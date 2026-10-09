# Handoff: spliterator CSV performance work, 2026-10-08/09

Sections 3.1–3.13 were committed after this document was first written (the branch was rebased onto the 9.1.0
release commit, see 3.12). Section 3.14 (row-count benchmark rows) is uncommitted on `main`, as are this file and
`HANDOFF_SUGGESTIONS.md`. `yarn compile && yarn test --run && yarn lint` is green (835 tests). The person owning
this repo decides what lands.

This document is for an agent arriving cold. It covers what was measured, what was changed, why,
what was tried and rejected, and where the remaining headroom is thought to be. Read `AGENTS.md`
first for the architecture; this file assumes it.

---

## 1. Where this started

The goal was to benchmark spliterator's CSV parsing against [uDSV](https://github.com/leeoniya/uDSV)
using uDSV's own bench harness (checked out at `../uDSV`), on realistic large files from `/mnt/mw`,
then chase whatever the benchmark exposed, and publish an honest benchmark section in `README.md`
reproducible from a script in the repo.

Datasets used:

| File                                                                                 | Size    | Shape                                                |
| ------------------------------------------------------------------------------------ | ------- | ---------------------------------------------------- |
| `../uDSV/bench/data/litmus_quoted.csv`                                               | 1.9 MB  | uDSV's synthetic quoted fixture (`litmus_gen.cjs`)   |
| `/mnt/mw/record-matcher/sources/openpayments_covered-recipient-profile_20260603.csv` | 386 MB  | wide, quoted, real                                   |
| `/mnt/mw/ppd/2026-07-22/gb-tuples.csv`                                               | 1.45 GB | quoted, exceeds V8's string limit so it only streams |

Scratch copies for micro-timing (not in the repo, in the session scratchpad
`/tmp/claude-1000/-home-lab-Projects-spliterator/e5371494-bd4b-49fc-a5b1-0e919d7c66d6/scratchpad/`):
`gb300.csv` (first 300 MB of gb-tuples, quoted), `gb300-noq.csv` (same rows with quotes stripped,
266 MB), `count.mjs` (streams a file with `bulkThreshold: 0`, `mode: "array"`, `header: false`,
`trim: false`, counts rows, prints ms and MiB/s).

---

## 2. The benchmark harness integration (`benchmarks/udsv/`)

- `sweep.ts` spawns uDSV's `bench/runone.cjs` per parser per dataset, unmodified, and collects its
  JSON. The harness's metric is a geometric mean over 3-second cycles, reported as MiB/s.
- The harness reads the whole file into a string unless the adapter path contains
  `/streaming/non-retained`. A 1.45 GB file cannot be a string (`ERR_STRING_TOO_LONG`), so the
  sweep writes `runone-streaming.generated.cjs`, a copy with that test widened to also match
  `-count.js$`, and uses it for the count adapters.
- uDSV drops the header row; the harness verifies row counts with a tolerance of 2 below
  `expected.json`. For a dataset with no entry the sweep computes one with uDSV itself and adds 1,
  so both uDSV and header-keeping parsers pass. A file too large for a string gets a placeholder
  entry and runs unverified.
- Memory is not taken from the harness (its figure is the largest RSS step _between_ cycles, which
  reads zero for a parser that allocates on the first parse). Each run goes through
  `/usr/bin/time -f %M`; peak RSS minus the baseline the runner reports before loading the parser
  is recorded as "Peak RSS above baseline".
- Adapters in `benchmarks/udsv/adapters/`: `spliterator-memory` (string in), `spliterator-stream`
  (file in, rows retained), `spliterator-count`, `udsv-count`, `papaparse-count` (file in, rows
  discarded). Count adapters locate uDSV through `UDSV_ROOT`.
- `render.ts` turns `results.json` into Markdown tables (the user explicitly wanted Markdown, not
  box-drawn code blocks, and a memory column). `README.md` has a `## Benchmarks` section built from
  it. `test/benchmarks/udsv-render.test.ts` covers the renderer.

Latest harness numbers (2026-10-09, after 3.7; background load ~3, equal for every parser):

| Dataset / mode                                  | spliterator | uDSV | PapaParse      |
| ----------------------------------------------- | ----------- | ---- | -------------- |
| litmus_quoted 1.9 MB, in-memory string → arrays | 209 MiB/s   | 370  | 74             |
| litmus_quoted, stream, rows retained            | 153         | 229  | 67             |
| litmus_quoted, stream+count                     | 168         | 261  | 89             |
| openpayments 386 MB, in-memory string → arrays  | 73          | 142  | (fails verify) |
| openpayments, stream, rows retained             | 99          | 75   | 86             |
| openpayments, stream+count                      | 205         | 307  | 184            |
| gb-tuples 1.45 GB, stream+count                 | 137         | 269  | 118            |

The in-memory openpayments figure is one sample per 3-second cycle and includes a major GC of the
previous 1.3 GB result; it moved 78 → 73 between two sweeps with no code change in between, so
treat ±10% there as noise. Standalone, a single parse of that string is 3.2 s (was 3.8 s).

Before this work spliterator's streaming count was 88 and 148 MiB/s on those two files. The full
tables with memory columns are in `README.md` and `benchmarks/udsv/results.json`.

---

## 3. Changes made, in order of measured payoff

### 3.1 `AsyncSequence.next()` awaited its opener on every pull (biggest win, not planned)

`lib/iterators/AsyncSequence.ts`. The pull loop did `await this.#openUpstream()` unconditionally.
After the first pull that is an extra async frame per item on every streamed format. Fixed by
reading `this.#upstream ?? this.#syncUpstream` first and only awaiting the opener when both are
null.

Measured on the 300 MB quoted stream: 2.9 s → 2.5 s. `TextSpliterator` over the same file
2.0 s → 1.6 s. 20–40% on streamed rows. This was found by profiling, not by the plan.

### 3.2 Batched sources (`BATCHED_SOURCE`, `batched()`, `BatchedAsyncIterable`)

Same file. An upstream can be marked as yielding arrays; `next()` then walks each array in place
with no `await` per element, skipping empty arrays. Needed because the windowed cell scan (3.3)
was _slower_ than the per-row path until rows crossed the sequence boundary in bulk: rows yielded
singly from an async generator 4.8 s, per-row path 3.2 s, batched 2.9 s. A batched source that has
its header consumed must put the rest of that batch back in front: `reheadBatches` in
`lib/formats/csv-cells.ts`. Tests in `test/iterators/batched.test.ts`.

### 3.3 Windowed cell scanning on the streaming CSV path

- `AsyncSpliterator.nextWindow()` (`lib/core/AsyncSpliterator.ts`): fills as `next()` does, then
  dequeues _every_ queued range at once and returns the contiguous view from the first range's
  start to the last range's end. Whole records only; about a high-water mark (64 KiB) of rows per
  await. The engine's `skipEmpty`/`drop`/`take` do **not** apply to windows; the CSV layer applies
  them itself. Invariant tested in `test/core/nextWindow.test.ts`:
  `windows.join(delimiter) === source`, with a trailing empty window when the source ends on a
  delimiter.
- `scanCsvCellsStreaming` (`lib/formats/csv-cells.ts`): per window, decode with the fatal decoder
  and run `scanCsvCells` (the existing in-memory kernel driver) over it. Nothing carries across
  windows because the engine cut the records with quote state in hand. A window that is not valid
  UTF-8 takes the per-row path for that window alone (the `fallback` callback). Output is a batched
  source.
- `CSVSpliterator.fromAsync` (`lib/formats/CSVSpliterator.ts`): `openRows` now awaits
  `CharacterSequence.whenReady()` on the streaming branch too, because `scanWindows` checks
  `hasScanner()` and a fresh process otherwise took the row path for its first file. **This was
  invisible in the test suite** (the scanner was already loaded by earlier tests) and only showed
  up in a standalone run. Header handling: if the opened rows are batched, the first non-empty
  batch's first row is the header and the remainder is re-headed.
- `columnScan: "rows"` opts out and remains the parity reference. Tests in
  `test/formats/CSVSpliterator.test.ts` under `describe("streaming cell scan")`: parity at
  `highWaterMark: 32`, a quoted field longer than a window, an invalid-UTF-8 window, `skipEmpty:
  false`, early exit closes the source.

### 3.4 A string source is the decoded text

`CSVSpliterator.from(string)` passes the string itself to the cell scanner instead of decoding the
bytes it had encoded from it. Offsets agree because a lone surrogate encodes as U+FFFD, one UTF-16
unit either way (the surrogate survives where the row path yields U+FFFD; tested in
`test/formats/csv-cells.test.ts`). On the 386 MB string: 4.2 s → 3.8 s and peak memory
2237 → 1465 MiB (the second copy of the source is gone). Side effect: `columnScan: "rows"` no longer
saves memory on a string source, so that README claim was removed and the reason recorded in
`AGENTS.md`.

### 3.5 Unquoting

`lib/formats/csv-columns.ts`.

- `unquoteColumn(value, escaped?)`: only calls `replaceAll('""', '"')` when something says a
  doubled quote exists. If `escaped` is undefined it runs one `indexOf('""')`; the two-pass form
  with unconditional `replaceAll` was 17% of a streamed quoted parse.
- `splitQuotedString` (row path) is now a fused split+unquote walk with a `sawDoubledQuote` flag
  and `unquoteSlice(line, start, end, sawDoubledQuote)`, so a quoted cell is sliced once. Edge cases
  in `test/core/QuoteHandling.test.ts`.

### 3.6 Kernel escape flag (last change, 2026-10-09)

`wasm/src/lib.rs` `scan_csv_cells`. New `CELL_FLAG_HAS_ESCAPE = 4`, set when a quote _opens_
directly after a quote byte (the second half of `""` inside a quoted field). Reasoning on why that
rule is exact: `""` as an empty quoted cell is open-then-close, so no flag; `"a""b"` is
open-close-open(prev is quote → flag)-close; `x""y` with quotes not at the edges is open-close, no
flag, and `unquoteColumn` would not have stripped it anyway. The rule marks every pair where the
first quote closed a field, which is exactly what the row path's `sawDoubledQuote` captures.

- The carried state slot 4 of the results header is now a flags word
  (`HAS_QUOTE | HAS_ESCAPE`), not a boolean. Renamed `cellHasQuote` → `cellFlags` in
  `lib/core/wasm_module.ts`, `lib/core/CharacterSequence.ts` (`CellScanState`,
  `WasmCellScanResult`), `lib/formats/csv-cells.ts`, `test/core/wasm.test.ts`.
- Across a window edge the first quote of a pair can be the last byte of the previous window; the
  kernel reads `previous_byte` (already passed for CR handling) when `offset == 0`. Tested.
- `csv-cells.ts` reads the flag itself and no longer calls `unquoteColumn` at all (see 3.7).
- `wasm/build.sh` was run; `lib/core/wasm_base64.ts` is regenerated (3343 bytes).

Interleaved A/B on the 300 MB quoted stream (a git worktree with the `indexOf` form, four pairs):

| Build            | Runs                     |
| ---------------- | ------------------------ |
| `indexOf` search | 2.80, 2.57, 2.61, 2.48 s |
| kernel flag      | 2.67, 2.44, 2.40, 2.37 s |

~5%, every pair in the same direction.

### 3.7 The in-memory gap was the scavenger, not the parser (2026-10-09)

The suggestion document (`HANDOFF_SUGGESTIONS.md`) read the 3.5× litmus gap as per-cell work and
proposed a fused `indexOf` loop over the string. Profiling one litmus parse first said otherwise:

| Measurement on `litmus_quoted.csv` (1.9 MB, 10k rows × 20 quoted cells) | Value   |
| ----------------------------------------------------------------------- | ------- |
| encode string → bytes                                                   | 0.17 ms |
| kernel boundaries only (`CharacterSequence.scanCells` loop)             | 2.6 ms  |
| scan + slice, rows discarded, min of 200                                | 8.6 ms  |
| same, rows **kept**, p50                                                | 19 ms   |
| uDSV `stringArrs`, p50                                                  | 5.0 ms  |
| harness-style geometric mean (what `results.json` reports)              | 17.6 ms |

Discarding rows was a steady 9–10 ms per parse; keeping them doubled it, and `--cpu-prof`
attributed the difference to `(garbage collector)`: 43% of the kept run against 7% for a plain
`split`. `--trace-gc-nvp` gave the mechanism: each scavenge saw ~22 MB allocated since the last
one with ~12 MB surviving (the result built so far), 9–11 ms per scavenge, about one per parse.
uDSV allocated ~8.5 MB per parse, scavenged once per ~3.5 parses, and each one survived ~3 MB in
under 1 ms. `%DebugPrint` on the results showed cells with the same representation in both
(sliced one-byte strings at ≥13 chars, sequential copies below), but our row arrays had a
`FixedArray[43]` backing store behind 20 elements where uDSV's had `[20]`.

Two allocations per cell were the whole difference:

1. `unquoteColumn` sliced the quoted outer string, then sliced its inside. The outer string was
   garbage on every quoted cell. `cell()` now checks the quote bytes in the source text and slices
   the inside once; `CELL_FLAG_HAS_ESCAPE` says whether to `replaceAll`.
2. Rows grew by `push` from `[]`: two discarded stores per row and a 43-slot survivor. Rows are
   now filled into `template.slice()` where the template is an exact-width array of `""` the
   width of the previous row (uDSV's `rowTpl.slice()`), with `row.slice(0, width)` for a
   narrower row and plain index assignment past the end for a wider one.

A trap worth knowing: `row[width++] = cell(...)` evaluates the member expression first, so
`width` was already incremented when `cell()` ran and the BOM strip at `width === 0` never
fired. The BOM parity tests caught it; the value is now assigned to a local first.

Result on litmus, same machine, same session:

| Metric                               | Before  | After  |
| ------------------------------------ | ------- | ------ |
| harness-style gmean                  | 17.6 ms | 8.7 ms |
| GC per parse (perf_hooks `gc`)       | 6.9 ms  | 0.9 ms |
| min                                  | 9.0 ms  | 7.1 ms |
| uDSV, same loop                      | 5.4 ms  | 5.1 ms |
| 300 MB quoted stream, rows discarded | 2.4 s   | 2.1 s  |

The remaining litmus gap is ~1.7× and is now in the min, not the mean: ~2.6 ms of kernel
round-trip (encode, stage into WASM memory, copy the result block out, rebase) plus the slicing
loop. The fused-string-loop idea from the suggestions would attack the kernel share; it is still a
third implementation to keep in parity, and it is now worth ~2.6 ms of 8.7, not the 3.5× it was
pitched at.

`unquoteColumn`'s `escaped` parameter added in 3.6 was removed again as dead; the row path has its
own `sawDoubledQuote`, and the cell path no longer calls it.

### 3.8 Compiled row builders for object and entries mode (2026-10-09)

Move 1 from `HANDOFF_SUGGESTIONS.md`. Baseline on litmus with `header: true`, harness-style gmean:
array 9.8 ms, object 62.5 ms, entries 38.4 ms. `--cpu-prof` on object mode: `zipSync` 29%, the
`object` emitter body 23%, GC 22%.

Step 1, replace the `zipSync` iterator (an iterator step and a 3-tuple per cell) with an indexed
loop when both arguments are arrays: object 62.5 → 29.6 ms, entries 38.4 → 20.1 ms.

Step 2, compile a builder per bound header with `new Function`, a literal
`{ "id": f[0](0 < c.length ? c[0] : m), ... }` with the header names as string-literal keys. A
scratch prototype on the retained array rows measured the loop at 6.7 ms per 10k objects and the
literal at 0.25 ms (results escaping to a global, so not escape analysis). In the library it is
adaptive: the loop handles the first 32 rows of a header, then the builder is compiled once and
cached in a `WeakMap` keyed by the bound header array. Result: object 10.0 ms, entries 17.4 ms,
array 10.0 ms. Object mode is now free relative to array mode; entries still pays one 3-element
array per cell.

Details worth knowing:

- `JSON.stringify(key)` makes any header a valid literal key. `"__proto__": v` in a literal invokes
  the setter, same as `record["__proto__"] = v` did, so a string is ignored on both paths.
- A `new Function` that throws (CSP without `unsafe-eval`) is recorded as `false` on the header's
  state and the loop stays, no retry per row.
- Headers above 2048 columns never compile.
- Columns past the header are appended as `column_<idx>` after the literal.
- `bindTransformers` had a latent bug the new tests surfaced: a header named `__proto__` bound
  `Object.prototype` as its transformer (`byName[columnName] ?? identity` on a plain object). It now
  checks `Object.hasOwn`.
- `test/formats/row-emitters.test.ts` checks every expectation on row 3 (loop) and row 81
  (compiled).

### 3.9 Stepping scanner (2026-10-09)

`--cpu-prof` on the 300 MB stream after 3.8: `scanCsvCells` generator 13%, the `windows` async
generator plus `Array.from` 11%, `toColumns` map callback 8%, `AsyncSequence.next` 6%. The cell
loop is now `CellRowScanner.nextBatch(out)`, a stepping object that pushes one kernel batch of rows
(≤ 4096 cells) into the caller's array. The in-memory parser yields a fresh array per batch and
walks it in its own generator (one generator per row, not two); the streaming path collects a whole
window into one array with no flattening copy; `scanCsvCells` stays as the flat generator for tests
and the small-file bulk parser. litmus in-memory gmean 9.7 → 8.3 ms, object 9.0 → 7.8 ms, entries
13.0 → 11.2 ms; the 300 MB quoted stream 2.1 → 1.9 s (150 MiB/s).

Where the in-memory litmus parse (8.3 ms, uDSV 5.0 ms) goes now, from the profile: JS cell loop
~2.0 ms (10 ns/cell), kernel ~0.95 ms, `scanCells` staging/copy/rebase ~0.35 ms, the format's
generator and `Sequence` ~1 ms, GC ~0.8 ms, encode ~0.3 ms. Nothing left is a single large item.

The per-row `map` op on the stream (`toColumns` plus the emitter, ~8%) was considered and left:
applying it per batch inside the producer would save one closure call per row but not the
sequence's own per-item step, and the header is bound after the first batch arrives, which
complicates where the emitter can run.

### 3.10 JSONL and text streaming decode per window (2026-10-09)

Priorities were re-read from mailwoman's actual usage (`scratchpad/2026/10/09/spliterator.code-search`
in the mailwoman repo): 110 `JSONSpliterator.fromAsync` call sites, ~60 CSV/TSV `fromAsync` over
multi-million-row corpus files in object mode with `normalizeKeys: false`, 82 `TextSpliterator.from`
over small in-memory text (stdout splitting), 5 XLSX. No numeric or columnar consumers. So the
typed-columnar kernel idea (section 9) has no customer and was dropped; JSONL streaming moved to
the top.

Baseline on a 120 MB synthetic JSONL of 600k rows: `readline` + `JSON.parse` 783 ms,
`JSONSpliterator.fromAsync` 1289 ms, `TextSpliterator.fromAsync` without parsing 281 ms, the raw
engine 138 ms. A prototype that pulled `nextWindow()`, decoded once, split the text on `\n` and
parsed each slice ran 584 ms. The per-row cost was a `TextDecoder.decode` call per row (a few
hundred ns of fixed overhead in Node) plus the per-row `await`.

`lib/io/windowed-text.ts` is that prototype as a batched source: decode per window, split on the
decoded delimiter (multi-character works), `crlf` and `skipEmpty` applied in the split, rows out as
batches. `TextSpliterator.fromAsync` and `JSONSpliterator.fromAsync` take it when the adaptive
source returns a streaming engine; the small-file bulk branch is unchanged. `drop`/`take` moved
from engine options to sequence ops on these two paths (they still count after `skipEmpty`). A
`fatal` decoder failure on a window falls back to per-row decoding to name the row. A text version
of the comment filter mirrors the byte one.

| JSONL                               | before  | after   | readline + JSON.parse |
| ----------------------------------- | ------- | ------- | --------------------- |
| 120 MB synthetic, 600k rows         | 1289 ms | 707 ms  | 702 ms                |
| 500 MB BAN corpus slice, 1.27M rows | —       | 1948 ms | 2092 ms               |
| Text rows only, 120 MB              | 281 ms  | 241 ms  |                       |

The 120 ms between the library (707) and the prototype (584) is the sequence's per-row op step
and the `map` closure; parsing inside the batch producer would recover some of it at the cost of
moving error attribution out of the sequence. Not done.

Tests: `test/io/windowed-text.test.ts`, every case at `highWaterMark: 48` with 7-byte chunks so
rows and multi-byte characters straddle windows, checked against the sync `from`.

### 3.11 Kernel batch as a view (2026-10-09)

`CharacterSequence.scanCells` returned a copy of the result block rebased to absolute units in a JS
loop, 9% of a streamed parse. It now returns the shared-memory view, window-relative, plus a
`unitBase` the consumer adds. Safe because `CellRowScanner.nextBatch` turns the whole batch into
rows before returning and runs no user code; the AGENTS.md gotcha that forbade removing the copy
was rewritten to say when a copy is required (any new consumer that yields or calls out mid-batch).
386 MB streamed into objects 1869 -> 1685 ms, litmus in-memory 8.3 -> 7.4 ms, 300 MB quoted stream
1.9 -> 1.8 s.

### 3.12 Consumer CI break on 9.1.0: import.meta.resolve (2026-10-09)

mailwoman's Docusaurus build failed after bumping to spliterator 9.1.0. Docusaurus loads plugins
through jiti, which transpiles ESM dependencies to CommonJS on the fly: it rewrites
`import.meta.url` and leaves `import.meta.resolve` alone, so Node refused
`out/lib/internal/node-modules.js` with "Cannot use 'import.meta' outside a module".
`workerEntryUrl` now resolves through `createRequire(import.meta.url).resolve(specifier)` (the `#`
import map works through `require.resolve` too), with `node:module` and `node:url` loaded through
`process.getBuiltinModule` so it stays synchronous and the root keeps no static `node:` import.
`test/package/import-meta.test.ts` scans `out/lib` and `out/node` and refuses any `import.meta`
form but `.url`. The branch was rebased onto the 9.1.0 release commit (`fe53ab7`) so the fix can
ship as 9.1.1.

XLSX was checked and left alone: the five mailwoman call sites read small workbooks, no workbook
over 5 MB exists on `/mnt/mw`, and `read-excel-file` has no streaming API.

### 3.13 String sources split as text (2026-10-09)

`TextSpliterator.from(string)` encoded the string, scanned the bytes and decoded each row back:
7.8 us per call on a 40-line string against 1 us for `split` + `trim`. That is the shape of the ~80
stdout-splitting call sites in mailwoman. `textRows` (`lib/io/windowed-text.ts`) now splits the
string on the delimiter text with the engine's `crlf`, `skipEmpty`, `drop`, `take` semantics; the
streaming window path shares the same splitter. Gated by `canSplitAsText` (no byte `position`, no
quote handling, UTF-8 only). 2.5 us per call; the remainder is the `Sequence` and the generator.
`JSONSpliterator.from(string)` takes the same route with the text comment filter.
`test/formats/text-rows.test.ts` pins parity with the byte route over 9 texts x 8 option sets.

### 3.14 Row-count benchmark rows: scan-only and worker-parallel (2026-10-09, kimi session)

Top item of the updated `HANDOFF_SUGGESTIONS.md` review. The count adapters full-parse (every cell produced and
discarded), because uDSV's do; the library's scan-only path (`CSVSpliterator.countAsync`, which counts engine rows
and never decodes columns) was never shown. Two new adapters, both labeled as their own rows so the full-parse
counts stay for apples-to-apples:

- `spliterator-rows-count.ts` → "spliterator (stream, row count)": `countAsync(path, { header: false, trim: false,
  bulkThreshold: 0 })`.
- `spliterator-parallel-count.ts` → "spliterator (stream, row count, N workers)": `AsyncSpliterator.segments`
  (the documented boundary primitive) plus one **persistent** worker thread per core
  (`parallel-count-worker.ts`), spawned in `load()` so the timed cycles measure the scan, not the spawn. Each
  worker opens its own range with `createChunkIterator({ start, end: end - 1 })` and counts engine rows with
  `crlf: true, enableQuoteHandling: true` — the same row semantics as `countAsync`'s streaming branch — and posts
  one number back, so a segment of any size costs one message (no per-record transfer; `asManyWorkers` was not
  used because its per-record results stream would put 25M items through the merged iterator on gb-tuples).
  N is `availableParallelism()` (16 here) and the name carries it.

Results (single fresh sweep, quiet machine, load ~2; `results.json` and the README tables were regenerated from
it, so every number in the README moved slightly):

| Dataset               | full-parse count | row count | row count, 16 workers | uDSV (stream, count) |
| --------------------- | ---------------- | --------- | --------------------- | -------------------- |
| litmus_quoted 1.8 MiB | 199              | **715**   | 669                   | 249                  |
| openpayments 386 MiB  | 285              | **1091**  | **2015**              | 310                  |
| gb-tuples 1.42 GiB    | 174              | **393**   | **721**               | 271                  |

The scan-only sequential row beats uDSV's full-parse count everywhere (1.45–3.5×); the parallel row beats it
2.7–6.5×. On the 1.9 MB litmus file the parallel row _loses_ to the sequential one (669 vs 715 — segment probing
is per call) and costs 474 MiB against 53, which is visible in the table and is the expected small-file trade-off.
Parallel scaling on gb-tuples is only 1.8× (393 → 721) — short rows (~57 B) make it per-row-bound, and `/mnt/mw`
read bandwidth caps the rest.

**Verification.** Sequential `countAsync`, the rows-count adapter, and the parallel adapter agree exactly on all
three datasets, and match uDSV's `expected.json` where it exists (litmus 10000, openpayments 1697026; gb-tuples
25674049, unverified by the harness but identical across all three). **Known limit, demonstrated:** segments are
quote-blind, so a file with the row delimiter inside a quoted field miscounts in parallel — a synthetic 10 MB file
of `"a\nb",c` rows counted 581251 parallel against 300000 sequential. The adapter header and the README narrative
carry the caveat; all three published datasets are verified per the sentence above. The sound fix is library-level
quote-aware segmentation: the engine toggles quote state per quote byte, so the parity of `"` bytes before a cut
is exactly its quote state — countable per segment in parallel (order-free) and prefix-XORed, with a bounded
forward repair probe for cuts that land odd. Not done; that is what would make `asManyWorkers` safe for CSV with
embedded newlines generally.

Verification and timing scripts lived at the repo root as `scratch-*.mjs` (gitignored) and were deleted after use —
note that `yarn test`'s compile type-checks even root-level `.mjs` files, so scratch scripts cannot be left lying
around.

---

## 4. Clean before/after summary (worktree of `main` vs. working tree, quiet machine)

| Path                                       | Before   | After    |
| ------------------------------------------ | -------- | -------- |
| 300 MB quoted CSV streamed, rows discarded | 4.2 s    | ~1.9 s   |
| 266 MB unquoted CSV streamed               | 3.2 s    | 1.9 s    |
| 300 MB `TextSpliterator` rows streamed     | 2.0 s    | 1.6 s    |
| 386 MB CSV as a string, in memory          | 4.2 s    | 3.8 s    |
| in-memory peak RSS above baseline          | 2237 MiB | 1465 MiB |

---

## 5. Measurement caveats

- Another session on this machine (a mailwoman checkout) compiles intermittently; load average
  reached 15–20 at times. Every number above was retaken after waiting for 1-minute load < 4.5
  (`until awk '{exit !($1 < 4.5)}' /proc/loadavg; do sleep 15; done`). The harness sweep ran at a
  steady ~4 that applied equally to every parser. Absolute numbers will shift on a quiet machine;
  ratios should hold. Always interleave A/B runs here; sequential blocks drifted by 20%.
- A "before" build cannot be a copied `out/` directory: the `#` import map in `package.json`
  resolves relative to the nearest `package.json`, so a copy outside the package fails with
  `ERR_PACKAGE_IMPORT_NOT_DEFINED`, and a copy inside it would resolve `#core/*` to the _current_
  `out/`. Use `git worktree add <dir> HEAD`, `git diff HEAD | git -C <dir> apply`, symlink
  `node_modules`, compile there.
- `hasScanner()` is false in a fresh process until `whenReady()` resolves. Any standalone timing
  script that constructs a sync `Spliterator`/`CSVSpliterator.from` without awaiting it measures
  the JS scanner.

---

## 6. How uDSV gets its speed, and what it gives up

Read from `../uDSV/src/uDSV.mjs`.

**Schema inference up front.** `inferSchema` samples the first rows, decides delimiter, whether a
quote character appears anywhere, and the column count. The parser loop in `parse` has the column
count baked in: on every column but the last it does `indexOf(colDelim)`, on the last
`indexOf(rowDelim)`. One `indexOf` and one `slice` per cell, no per-character state machine when
the file has no quote at all (`colEncl === ''` branch, the one that hits ~300 MiB/s). The quoted
branch walks for the closing quote and only `replaceAll`s on a seen escape.

**Generated row builder.** `genToTypedRow` emits JavaScript source as a string, one expression per
column, and compiles it with `new Function`. For string arrays it collapses to returning the row.
For objects it is a literal `{ id: +r[0], name: r[1], ... }` with keys inlined, so V8 sees a fixed
shape with constant keys instead of a loop doing dynamic property assignment. This is why uDSV's
object mode is nearly as fast as its array mode, where spliterator's object mode costs about 2×.

**What happens when the schema is wrong: nothing.** There is no check.

- A short row never reaches the last column index, so the parser searches for a comma, runs through
  the newline, and glues the next row's leading cells onto this one. Rows merge until columns
  happen to realign.
- A long row hits the last index early, then searches for the newline, so every extra column lands
  in the last cell with the commas in it.
- A value that breaks an inferred type goes through the compiled conversion; a word in a numeric
  column becomes NaN unless the caller configured a replacement. The typed builder never re-infers.
- The quoted branch chooses the delimiter the same way, so row-merging is identical there.

None of this raises. The harness only checks row and column counts, which these regular datasets
never trip. On a ragged file spliterator's per-row behaviour is correct and uDSV's is undefined.
That is the honest counterweight to the 2× speed gap and belongs next to it in any write-up.

**What is portable.** The row builder: object mode in `lib/formats/row-emitters.ts` could compile a
per-header builder once with `new Function` after the header is known; applies to the per-row and
windowed paths alike. Risk: CSP / some bundlers forbid `new Function`, so it needs a fallback to the
current loop. The schema-specialized scan is the expensive one (an inference pass, a no-quotes
kernel, and a policy for a row that breaks the shape) and is effectively a different library.

---

## 7. Where the remaining cost is

- **Streaming path, string arrays:** after 3.7 the per-cell cost is one `slice`, `normalizeCell`,
  and an indexed store, plus the window decode. There is no obvious implementation gap left on this
  path; what remains is the layering (byte engine → decode → cell kernel → sequence) versus uDSV's
  single string loop.
- **In-memory string path:** after 3.7 the GC share is gone and the remaining litmus gap (~1.7×)
  is the kernel round-trip (~30% of the parse on a 2 MB source) plus slicing. On the 386 MB string
  the earlier decode removal bought only 10% of time while halving memory. First-row latency is
  the whole-source decode on the first pull (~28 ms on 40 MB).
- **Always measure with rows retained.** A discard loop hides scavenger cost entirely (3.7).
- **Object mode** now costs the same as array mode (3.8). Entries mode is ~1.7× array mode, which is
  the 3-tuple per cell.
- `AsyncSequence` wrapping is ~1.9× a bare async generator per item; on parsed rows that is 3–8%.
  Documented in `AGENTS.md` with the reasons not to restructure it.

---

## 8. WebAssembly string builtins probe (throwaway, 2026-10-09)

Question: can the kernel create the cell strings itself through the
[JS String Builtins](https://github.com/WebAssembly/js-string-builtins) (`wasm:js-string`) and the
UTF-8 extension (`wasm:text-decoder` / `wasm:text-encoder`, behind
`--experimental-wasm-imported-strings-utf8` on Node 26.2 / V8 14.6), and does that beat slicing in
JavaScript?

Files, all in the scratchpad `spike/` directory (not in the repo; `binaryen` and `wabt` were npm
installed there for `wasm-as`): `strings.wat` (imports `substring`, exports a loop that writes
substrings into an `externref` table or calls an imported `emit` per cell), `decode.wat` (a GC
`array i8` filled from a string via `encodeStringIntoUTF8Array`, then `decodeStringFromUTF8Array`
per cell), `check.mjs` (functional check), `bench.mjs` (timing). Compile with
`WebAssembly.compile(bytes, { builtins: ['js-string', 'text-decoder', 'text-encoder'] })`.

Findings:

1. `wasm:js-string` works on this Node **with no flag**. `wasm:text-decoder` / `text-encoder` need
   `--experimental-wasm-imported-strings-utf8`; without it instantiation fails with
   `Import #0 "wasm:text-decoder": module is not an object or function`.
2. Timings, 2 million cells, best of 7, boundaries precomputed:

| Variant                                                                          | ASCII cells | Mixed UTF-8 cells |
| -------------------------------------------------------------------------------- | ----------- | ----------------- |
| JS `slice` from an `Int32Array` of boundaries (today's cell loop)                | 75 ms       | 79 ms             |
| wasm `substring` into an `externref` table, no readback                          | 82 ms       | 79 ms             |
| same, then JS reads the table back with `table.get`                              | 102 ms      | 138 ms            |
| wasm `substring` with an imported `emit` callback per cell                       | 133 ms      | 124 ms            |
| JS: `TextDecoder.decode` the window once, then `slice` (today, including decode) | 83 ms       | 109 ms            |
| JS: `TextDecoder.decode` per cell on a `subarray`                                | 251 ms      | 310 ms            |
| wasm `decodeStringFromUTF8Array` per cell from a GC array, via `emit`            | 156 ms      | 173 ms            |

3. Conclusions:
   - Creating a string costs the same from either side. The wasm substring loop ties JS only when
     the results stay in wasm; any way of getting them out (table read, callback) is a boundary
     crossing per cell and loses.
   - Decoding per cell loses to decoding the window once even with the builtin, so the current
     decode-then-slice design is correct.
   - **Structural blocker:** the UTF-8 builtins read only from WebAssembly GC arrays. There is no
     instruction or JS API that copies linear memory or a `Uint8Array` into a GC `array i8`
     (`array.init_data` copies from a _data segment_; `array.new_fixed` is per element). The only
     bulk way in is encoding a JS string, which is circular here.
   - Stable Rust cannot express `externref` parameters or GC types, so any of this would be
     hand-written `.wat` beside the Rust kernel.
   - Net: no path from the string builtins to a faster string-array output. Not pursued.

---

## 9. Ideas not yet tried, roughly ranked

1. ~~Typed / columnar output from the kernel~~ — dropped 2026-10-09: no consumer in mailwoman
   (section 3.10). Revisit only if a numeric workload appears.
2. ~~`new Function` row builder for object mode~~ — done in 3.8.
3. ~~Kernel emits per-row cell counts for preallocation~~ — done differently in 3.7 (previous
   row's width as a template), no kernel change needed.
4. **Skip `normalizeCell` when `trim` is off and the cell has no quote.** Check whether V8 already
   makes this free before bothering.

---

## 10. Reproducing

```bash
# repo
yarn compile && yarn test --run && yarn lint

# kernel (requires wasm32-unknown-unknown target; wasm-opt optional)
bash wasm/build.sh

# harness sweep (see header of benchmarks/udsv/sweep.ts for uDSV setup)
node out/benchmarks/udsv/sweep.js --stream /mnt/mw/ppd/2026-07-22/gb-tuples.csv
node out/benchmarks/udsv/render.js        # Markdown tables from results.json

# quick stream timing
node <scratchpad>/count.mjs <scratchpad>/gb300.csv
```

Working-tree state: the 3.1–3.13 library work was committed (the branch was rebased onto the 9.1.0 release commit
per 3.12). What remains uncommitted is this session's benchmark work: modified `README.md` (regenerated benchmark
tables + row-count narrative), `benchmarks/udsv/results.json`, `benchmarks/udsv/sweep.ts` (two new entries in
`countParsers`); untracked `benchmarks/udsv/adapters/spliterator-rows-count.ts`,
`benchmarks/udsv/adapters/spliterator-parallel-count.ts`,
`benchmarks/udsv/adapters/parallel-count-worker.ts`; plus the staged `HANDOFF.md`/`HANDOFF_SUGGESTIONS.md`
themselves. The `../uDSV` checkout has only `bench/expected.json` entries added and dataset symlinks in
`bench/data/`.
