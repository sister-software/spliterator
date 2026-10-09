Read it all. The gap isn't uniform, and that matters for where the drastic moves are:

| Workload                      | spliterator | uDSV | Gap             |
| ----------------------------- | ----------- | ---- | --------------- |
| litmus in-memory              | 103         | 358  | **3.5×**        |
| openpayments in-memory        | 78          | 125  | 1.6×            |
| openpayments stream+count     | 212         | 302  | 1.4×            |
| gb-tuples stream+count        | 127         | 266  | 2.1×            |
| openpayments stream, retained | 78          | 76   | **already won** |

Per handoff §7 the residual cost is per-cell JS work (slice, normalize, push) plus layering — not scanning. uDSV is essentially at the V8 string-creation floor, so no byte-pipeline tweak closes 3.5×. Drastic means one of three things: produce cells cheaper, don't produce cells, or don't produce them on one thread. Ranked:

**1. Compiled row builders via `new Function` — highest ROI, uDSV-proven.**
`lib/formats/row-emitters.ts:102` builds objects with `zipSync` (an iterator + tuple allocation per cell) and dynamic `record[key] =`. That's why object mode is ~2× array mode. uDSV's `genToTypedRow` compiles `{ id: r[0], name: r[1] }` with constant keys so V8 sees a fixed shape. Compile per-header emitters once the header is known, for object _and_ entries mode, plus a fixed-arity array literal for the common fixed-column case. Applies to row path and windowed path alike. Expected: object mode → near array mode; entries similar; ~10–20% on arrays. Needs a no-`Function` fallback for CSP/bundlers. This is the only move with a directly comparable proof point in uDSV itself.

**2. In-memory: drop the kernel round-trip, run a fused `indexOf` loop on the string — biggest single gap.**
The 3.5× litmus gap lives here. Current path encodes the string into WASM memory, scans bytes, and slices at UTF-16 boundaries. But your own §8 probe measured JS `slice` at ~37 ns/cell — exactly uDSV's per-cell rate — because V8's `String.prototype.indexOf` is already SIMD. A fused, quote-aware, `indexOf`-driven loop over the string (uDSV's architecture, but with correct ragged-row and quote handling instead of schema inference) should land 200–300+ MiB/s in-memory. Keep the kernel path for byte sources. A few days of spike work; the risk is a per-character JS state machine sneaking in and eating the win — stay `indexOf`-driven like uDSV's quoted branch.

**3. Don't produce cells for count/aggregate work — and go parallel.**
The count adapters build full string arrays and discard them (`benchmarks/udsv/adapters/spliterator-count.ts`), which is why "count" runs at half of `TextSpliterator`'s row-scan speed (1.6s vs 2.4s on 300 MB). A scan-only count is ~187 MiB/s single-threaded; segment-parallel over `asManyWorkers`/`WorkerPool` multiplies that by cores — 3–5× past uDSV's 266 on gb-tuples, using parts that already exist and are tested. Two honesty constraints: a scan-only count is a _different workload_ than uDSV's full-parse count, so it needs its own labeled row in the table, not a silent adapter swap; and as a product feature (a true `countAsync` fast path, projection, in-worker aggregation) it's real value, not benchmark theater.

**4. Typed/columnar kernel output — the floor-breaker, and the biggest design cost.**
Handoff §9.1. As long as output is string arrays, you're bounded by V8 string creation and can at best tie uDSV. Parsing numeric columns into `Float64Array` inside the Rust kernel straight from bytes, emitting boundaries only for projected columns, never creates those strings at all — 5–10× on numeric-heavy data is plausible, and it's the one thing a byte-level kernel can do that a string-native parser structurally cannot. This is a new API surface (projection, type hints, columnar result), so it's a design doc before it's code. It's also the most defensible direction for the library's identity: byte ranges, SIMD, bounded memory.

**5. Sound schema specialization — adopt uDSV's trick without the unsoundness.**
uDSV _infers_ "no quotes" from a sample and corrupts ragged files silently. Spliterator can _prove_ it: one SIMD scan for the quote byte over the whole source (~70 ms on 386 MB at 5–6 GB/s, fusable into the streaming read per window). A proven-no-quote file unlocks: zero quote state anywhere, known column count → preallocated `new Array(n)` rows (have the kernel emit per-row cell counts, §9.3), no `normalizeCell` quote branch, compiled builders from move 1. On its own it's worth less than uDSV's numbers suggest (uDSV's _quoted_ branch also does ~266, so quote handling isn't the main cost) — it's the multiplier on moves 1–2, not a standalone fix. And the ragged-row policy stays correct per row, which is the honest counterweight already in your README.

**6. Micro, verify first:** skip `normalizeCell` when `trim: false` and no quote flag (check whether V8 already makes it free), kernel-emitted cell counts for preallocation. A few percent each; measure before landing.

Sequencing: **1 first** (days, broad, certain), then **2** (closes the worst table), then **3** (inverts the count tables with existing machinery). **4** is the only move that changes the game rather than the score — worth a design doc once 1–3 have landed and the remaining gap is measured again.

Want me to start on one of these? I'd suggest spiking #1 or #2 to validate the expected payoff before committing to the full change.
