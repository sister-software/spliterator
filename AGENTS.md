## Commands

```bash
# Build (TypeScript compile to out/)
yarn compile

# Run tests (vitest). Always pass `--run` — bare `vitest` enters watch mode
# and never exits. The script compiles first because tests import "spliterator"
# which resolves via package.json `exports` to `out/index.js` — running against
# stale compiled output silently masks source fixes.
yarn test --run

# Run a single test file
yarn test --run test/Spliterator.test.ts

# Run tests matching a pattern
yarn test --run --reporter=verbose -t "Synchronous parity"

# Lint (prettier + eslint)
yarn lint

# Auto-fix lint issues
yarn lint:fix

# Release
yarn release
```

The package manager is **yarn** (v4). Node >= 20.18.1 is required. Compiled output goes to `out/`.

## Architecture

Spliterator is an ESM TypeScript library (`"type": "module"`) for streaming delimited byte content (CSV, JSONL, TSV, etc.) without loading entire files into memory.

### Core layer (`lib/`)

**`Spliterator`** (`lib/Spliterator.ts`) — The synchronous low-level engine. Takes a `Uint8Array` source and a delimiter, maintains an `IndexQueue` of `ByteRange` tuples `[start, end]`, and implements `IterableIterator`. The `#fill()` method scans for delimiter positions and enqueues byte ranges; `#drain()` handles the end-of-buffer edge case. Supports `drop`, `take`, `skipEmpty`, and `position` init options.

**`AsyncSpliterator`** (`lib/AsyncSpliterator.ts`) — The async counterpart. Reads chunks via an `AsyncChunkIterator`, appends them into a `BufferController` (a growable/compressible buffer), and searches for delimiters within. Implements `AsyncIterableIterator` and `AsyncDisposable`. Exposes `toReadableStream()` and `pipeThrough()` for web stream interop.

- **`AsyncSpliterator.asMany(source, delimiter, concurrency)`** — Divides a file into `concurrency` delimiter-aligned byte segments by probing small windows at each ideal boundary. Returns one `AsyncSpliterator` per non-empty segment. All segments share the same event loop (single-threaded async interleaving). Uses `createChunkIterator(source, { start, end: end - 1 })` — note `end` is inclusive in Node.js `createReadStream` semantics.

- **`AsyncSpliterator.asManyWorkers(source, delimiter, concurrency)`** — Same boundary detection as `asMany`, but spawns one `worker_threads` Worker per segment, giving each its own V8 engine and OS thread. Workers batch all records into a single `Uint8Array[]` message (+ `null` sentinel) before posting — this ensures results arrive in one event-loop turn after any main-thread block. Module-level helpers: `SEGMENT_WORKER_CODE` (inline CJS string, `eval: true`) and `workerToIterable` (attaches listeners eagerly at construction, uses a `chunks[]`+`head` pointer for O(1) draining). Requires a path string or URL — file handles cannot cross thread boundaries.

**`BufferController`** (`lib/BufferController.ts`) — A growable `Uint8Array` wrapper used by `AsyncSpliterator`. Supports `set()` to append data, `compress()` to discard already-consumed bytes and shift the buffer, and `subarray()` to slice without copying.

**`IndexQueue`** (`lib/IndexQueue.js`) — A simple FIFO queue of `ByteRange` tuples, tracking total `byteLength` to enforce the high-water mark.

**`CharacterSequence`** (`lib/CharacterSequence.ts`) — Encodes a delimiter string/bytes and provides `search`, `searchAll`, and `searchMatches` (two-pattern delimiter+quote) methods for scanning byte arrays. Defines the `Delimiters` enum (Newline, Comma, Tab, etc.). Single-byte delimiters use native `Uint8Array.indexOf`; everything else uses Boyer-Moore-Horspool, with a SIMD WASM fast path for haystacks ≥ `WASM_THRESHOLD`.

**WASM SIMD scanner** (`wasm/`, `lib/wasm_module.ts`, `lib/wasm_base64.ts`) — A `#![no_std]` Rust crate (`wasm/src/lib.rs`) compiled with `+simd128` and embedded as base64 (`wasm/build.sh` regenerates `lib/wasm_base64.ts`; requires the `wasm32-unknown-unknown` target, `wasm-opt` optional). `loadWasmModule()` instantiates it lazily into a single shared `WebAssembly.Memory`. Because loading is **asynchronous**, synchronous parsing only uses SIMD if the caller first awaits `CharacterSequence.whenReady(): Promise<boolean>`; otherwise it transparently uses the JS scanner. All three scan methods write the haystack to offset 0 of the shared memory, so `searchAll`/`searchMatches` invalidate `search`'s identity-keyed cache, and result views are 4-byte aligned. A full result buffer (`WASM_MAX_RESULTS`) falls back to the uncapped JS scan rather than truncating.

### High-level spliterators (all static-class pattern)

- **`TextSpliterator`** — Wraps `Spliterator`/`AsyncSpliterator`, decodes each yielded `Uint8Array` to a string via `TextDecoder`.
- **`JSONSpliterator`** — Wraps `TextSpliterator`-style logic, additionally calls `JSON.parse` on each line.
- **`CSVSpliterator`** — Two-level splitting: first splits rows (newline), then splits each row into columns (comma). Supports `mode: "array" | "object" | "entries"`, header normalization, and per-column transformers.

All high-level classes are abstract static-only (instantiation throws `TypeError`). They expose `from(syncSource)` and `fromAsync(asyncSource)` class methods.

### Node.js adapter (`node/`)

**`node/fs/index.ts`** — Node-specific file I/O. Exports `createChunkIterator` (opens a file handle and returns a readable stream as `AsyncChunkIterator`), `createFileWritableStream`, `readFileSize`, and `readBytes`. The `CreateChunkIteratorOptions.end` field is **inclusive** (matches Node.js `createReadStream({ end })`). This module is dynamically imported (`import("spliterator/node/fs")`) within the core layer so the library stays isomorphic — the dynamic import only runs in Node environments.

**`node/cli/`** — A `yargs`-based CLI (`spliterator` binary). Commands live in `node/cli/commands/`. Reads from a file path or STDIN, writes to a file path or STDOUT.

### Key data flow

```
File path / Buffer / AsyncIterable
        |
        v
  createChunkIterator (node/fs)   [async path only]
        |
        v
  AsyncSpliterator / Spliterator
   (ByteRange queue + needle search)
        |
        v
  Uint8Array slices (raw bytes)
        |
        v
  TextSpliterator / JSONSpliterator / CSVSpliterator
   (decode + parse)
        |
        v
  Typed values for caller
```

### Exports

The package exposes three entry points:

- `.` → `out/index.js` — all public symbols
- `./node/fs` → `out/node/fs/index.js` — Node file helpers (dynamically imported by core)
- `./test/utils` → `out/test/utils.js` — test fixture helpers

### Testing

Tests use **vitest** and live in `test/`. Fixtures are in `test/fixtures/`. The `test/utils.ts` helper loads fixture files and pre-computes `String.prototype.split` results for parity comparisons.

The `asManyWorkers` test (`test/AsyncSpliterator.asManyWorkers.test.ts`) generates its own large fixture (~8 MB, 100 000 JSONL records) at test time in `tmpdir()` via `beforeAll`/`afterAll`. Its spin-lock test blocks the main thread for 3 000 ms (generous to cover worker-thread V8 bootstrap overhead in vitest, which is ~1 s) and asserts the post-block drain takes < 200 ms. Worker threads batch all records into a single message, so the drain is just 4 message events + microtask queue — not proportional to record count.

## Non-obvious Gotchas

- **`Buffer.allocUnsafe` pool offset**: Small buffers (< 4096 bytes) share a pool. `new Uint8Array(buf.buffer, 0, n)` reads from offset 0 of the pool — garbage data. Always use `new Uint8Array(buf.buffer, buf.byteOffset, n)`.

- **`node/fs` `end` is inclusive**: `CreateChunkIteratorOptions.end` matches Node.js `createReadStream({ end })` — inclusive. When computing exclusive upper bounds, pass `end - 1`.

- **`workerToIterable` listeners must be eager**: Attaching `worker.on('message')` inside `[Symbol.asyncIterator]()` loses messages posted while a prior segment is being consumed. Listeners must be attached immediately when the iterable is created.

- **Worker batching is required for spin-lock correctness**: Posting records one-by-one means N messages pile up in the main thread's event queue during a block; draining them after the block is O(N). Batching all records into one message reduces post-block work to 4 message events regardless of record count.

- **`Array.shift()` is O(n)**: Avoid `shift()` on large arrays in hot paths. Use a `head` pointer instead (`chunks[head++]`).

## Known Performance Issues

Identified bottlenecks, ordered by impact. Check these off as they are addressed.

- [x] **`IndexQueue.dequeue` — O(n) `splice` on every yield** (`lib/IndexQueue.ts:48`)

  - `Array.splice(0, 2)` shifts every remaining element left on every dequeue call. Since `dequeue` is called once per yielded row, this compounds badly for large files. Fix: use a `#head` pointer and advance it instead of splicing, compacting the backing array only periodically. Also, `peek()` and `peekLast()` both call `.slice()` — they should use direct index access instead. `enqueue` uses `push(...tuple)` (spread) — should be two separate `push` calls.

- [x] **`CharacterSequence.search` — no fast path for single-byte delimiters** (`lib/CharacterSequence.ts:149`)

  - The Boyer-Moore-Horspool implementation is correct but degenerates to a naive JS-level scan for 1-byte delimiters (newline, comma, tab — the most common cases). `Uint8Array.prototype.indexOf` is a native C++ implementation with SIMD potential and would be significantly faster for this case. Add a `this.length === 1` short-circuit that delegates to `indexOf`.

- [x] **`SlidingWindow` — naive scan, ignores `CharacterSequence.search`** (`lib/SlidingWindow.ts:62`)

  - Uses `this.#delimiter.every((byte, i) => ...)` — a JS callback per byte in the buffer. `CharacterSequence.search` (BMH) is available but unused here. Switching to `this.#delimiter.search(this.buffer, this.cursor, this.#byteLength)` would immediately apply the faster search (and benefit from the single-byte fix above).

- [ ] **`BufferController.compress` delays underlying `ArrayBuffer` GC** (`lib/BufferController.ts:71`)

  - `this.bytes = this.bytes.subarray(start, end)` creates a view into the same `ArrayBuffer`, so bytes before `start` are logically discarded but still retained in memory. The old buffer is not freed until `grow` is called. Physically copying remaining bytes into a fresh buffer after compress would resolve this — but it adds an O(remaining) copy on every fill cycle, trading throughput for earlier GC. Left as a view deliberately; revisit only if memory pressure on long streams proves to be a problem.

- [x] **`new TextEncoder()` created on every `normalizeCharacterInput` call** (`lib/CharacterSequence.ts:110`)

  - `TextEncoder` is stateless — a single module-level shared instance is safe and avoids per-construction overhead. `CharacterSequence.decode` similarly creates `new TextDecoder()` on every call.

- [x] **`AsyncSpliterator.#fill` compresses before confirming new data is needed** (`lib/AsyncSpliterator.ts:405`)

  - `compress` is called unconditionally before the read loop. If the queue is already at the high-water mark and the loop runs zero iterations, the compress (and potential `grow`) was wasted work.

- [x] **`CSVSpliterator` allocates a new `Spliterator` per row** (`lib/CSVSpliterator.ts:184,289`)

  - For a file with N rows, N short-lived `Spliterator` objects are constructed and immediately GC'd. Each brings its own `IndexQueue` (`new Array`). A reusable column parser that resets state rather than constructing a new object would eliminate this GC churn. `SlidingWindow` (already in the codebase) is the intended low-level primitive for this but has its own issue (see above).

- [x] **`asManyWorkers` — worker-thread startup overhead** (`lib/AsyncSpliterator.ts`)

  - `new Worker()` pays a full V8 bootstrap cost (~1 s in vitest, ~100–300 ms in a clean process) on every call. A persistent pool of pre-warmed workers that receive segment assignments via `postMessage` would reduce repeated calls to near-zero after the first. Particularly impactful for server workloads processing many files sequentially.

- [x] **`asMany`/`asManyWorkers` — sequential boundary detection** (`lib/AsyncSpliterator.ts`)

  - Boundary probes (`readBytes`) are issued one after another in a loop. Since each probe is an independent random-access read, they can all be fired in parallel with `Promise.all`. This reduces the pre-scan phase from O(concurrency) sequential I/O round-trips to a single parallel round-trip.

- [ ] **`asManyWorkers` — batching vs. streaming latency trade-off**

  - Workers currently collect every record before posting a single batch. For large segments this maximises post-block drain efficiency but delays the first record until the entire segment is processed. A chunked delivery option (`batchSize` records per message) would let callers trade latency-to-first-record against message-queue pressure. Useful when output is being streamed to a downstream consumer in real time.

- [x] **WASM SIMD for multi-byte delimiter scanning**
  - Implemented as a `#![no_std]` Rust crate (`wasm/src/lib.rs`) compiled to `wasm32-unknown-unknown` with `+simd128`, embedded as base64 in `lib/wasm_base64.ts` (generated by `wasm/build.sh`) and loaded via `lib/wasm_module.ts`. Exports `find_delimiter` (first match), `find_all_delimiters` (range pairs), and `find_all_matches` (two-pattern delimiter+quote, `i8x16.eq` + `i8x16.bitmask`). `CharacterSequence.search`/`searchAll`/`searchMatches` use it for haystacks ≥ `WASM_THRESHOLD` (512 B); single-byte `search` still prefers native `indexOf`. Measured ~5–6 GB/s for multi-byte scanning vs ~600 MB/s JS BMH, and ~8–17× for `searchAll`.
  - **Async load caveat:** the module loads asynchronously. Synchronous callers (`Spliterator.fromSync`, `CSVSpliterator.from`) that complete in one tick fall back to the JS scanner unless they first `await CharacterSequence.whenReady()`.
  - Remaining: in quote mode (`enableQuoteHandling`), `#fill()` processes the whole remaining buffer in one call rather than respecting `highWaterMark`, so streaming a very large quoted source buffers all field ranges at once. Carrying quote state across bounded batches would fix it.
