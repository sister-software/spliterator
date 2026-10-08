## Spliterator tl;dr

- Package manager: **yarn v4**
- Runtime: **Node >= 22.18**
- Language: **TypeScript only** (src + tests + fixtures)
- Build output: `out/`
- Module type: **ESM** (`"type": "module"`)

---

## Quick Workflow

```bash
yarn compile
yarn test --run
yarn lint
```

- Use `--run` with vitest (non-watch mode).
- Use `bulkThreshold: 0` to force streaming behavior.
- Use `WorkerPool` when repeating worker-heavy operations.

For full details (architecture, sequence invariants, gotchas, exports, and performance notes),
use the sections below.

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

# Release — two GitHub Actions dispatches; nothing runs locally. `main` is protected, so the
# bump lands via an auto-merging PR (mode=prepare), then the merged commit is tagged and
# published (mode=publish). See .github/workflows/publish.yml.
gh workflow run publish.yml -f mode=prepare -f version=minor
gh workflow run publish.yml -f mode=publish
```

The package manager is **yarn** (v4). Node >= 22.18 is required. Compiled output goes to `out/`.

**Source is TypeScript only, tests and fixtures included.** `*.js` and `*.mjs` are gitignored.
Worker handler fixtures are `.ts` files loaded by path; Node strips types natively on the supported floor,
so nothing compiles them first.

## Architecture

Spliterator is an ESM TypeScript library (`"type": "module"`) for streaming delimited byte content
(CSV, JSONL, TSV, etc.) without loading entire files into memory.

### Core layer (`lib/`)

**`Spliterator`** (`lib/core/Spliterator.ts`) — The synchronous low-level engine.
Takes a `Uint8Array` source and a delimiter, maintains an `IndexQueue` of `ByteRange` tuples
`[start, end]`, and implements `IterableIterator`. The `#fill()` method scans for delimiter
positions and enqueues byte ranges.
`#drain()` handles the end-of-buffer edge case. Supports `drop`, `take`, `skipEmpty`, and `position` init options.

**`AsyncSpliterator`** (`lib/core/AsyncSpliterator.ts`) — The async counterpart. Reads chunks via an `AsyncChunkIterator`, appends them into a `BufferController` (a growable/compressible buffer), and searches for delimiters within. Implements `AsyncIterableIterator` and `AsyncDisposable`. Exposes `toReadableStream()` and `pipeThrough()` for web stream interop.

- **`AsyncSpliterator.segments(source, { delimiter, concurrency, probeSize? })`** — Returns
  delimiter-aligned `[start, end)` byte ranges (`lib/parallel/segments.ts`) by probing small
  windows at each ideal boundary **in parallel** (`Promise.all`) and aligning each cut just past
  the next delimiter. The boundary primitive for parallel parsing — hand each range to a worker.
  Invariant: concatenating each segment's records reproduces the file exactly (no record split or
  duplicated).

- **`AsyncSpliterator.asMany(source, { delimiter, concurrency })`** — `segments(...)` then one `AsyncSpliterator` per range via `createChunkIterator(source, { start, end: end - 1 })` (note `end` is inclusive in Node's `createReadStream`). All share the event loop (no threads).

- **`AsyncSpliterator.asManyWorkers<R>(source, { worker, concurrency, batchSize?, maxInFlight? })`**
  — One `worker_threads` Worker per segment. The worker entry
  (`lib/parallel/segment-worker-entry.ts`) opens its own handle to its range and runs the
  `worker` handler module per record (`runSegment` in `lib/parallel/segment-runtime.ts`). Results
  stream back through `workerToIterable` (`lib/parallel/segment-workers.ts`) as **one merged async
  iterator** for a single-thread writer. Chunked batches, zero-copy `Uint8Array` transfer,
  bounded in-flight ack backpressure. The handler returns a value (cloned), a `Uint8Array`
  (transferred), or `undefined` (skipped); its module top-level runs once per worker (load models
  there). Requires a path/URL — file handles cannot cross threads. See
  `docs/superpowers/specs/2026-06-29-parallel-segment-parsing-design.md`.

**`BufferController`** (`lib/core/BufferController.ts`) — A growable `Uint8Array` wrapper used by `AsyncSpliterator`. Supports `set()` to append data, `compress()` to discard already-consumed bytes and shift the buffer, and `subarray()` to slice without copying.

**`IndexQueue`** (`lib/core/IndexQueue.ts`) — A simple FIFO queue of `ByteRange` tuples, tracking total `byteLength` to enforce the high-water mark.

**`CharacterSequence`** (`lib/core/CharacterSequence.ts`) — Encodes a delimiter string/bytes and provides `search`, `searchAll`, and `searchMatches` (two-pattern delimiter+quote) methods for scanning byte arrays. Defines the `Delimiters` enum (Newline, Comma, Tab, etc.). Single-byte delimiters use native `Uint8Array.indexOf`; everything else uses Boyer-Moore-Horspool, with a SIMD WASM fast path for haystacks ≥ `WASM_THRESHOLD`.

**WASM SIMD scanner** (`wasm/`, `lib/core/wasm_module.ts`, `lib/core/wasm_base64.ts`) — A
`#![no_std]` Rust crate (`wasm/src/lib.rs`) compiled with `+simd128` and embedded as base64
(`wasm/build.sh` regenerates `lib/core/wasm_base64.ts`; requires the `wasm32-unknown-unknown`
target, `wasm-opt` optional). `loadWasmModule()` instantiates it lazily into a single shared
`WebAssembly.Memory`. Because loading is **asynchronous**, synchronous parsing only uses SIMD if
the caller first awaits `CharacterSequence.whenReady(): Promise<boolean>`; otherwise it
transparently uses the JS scanner. All three scan methods write the haystack to offset 0 of the
shared memory, so `searchAll`/`searchMatches` invalidate `search`'s identity-keyed cache, and
result views are 4-byte aligned. A full result buffer (`WASM_MAX_RESULTS`) falls back to the
uncapped JS scan rather than truncating. Exports `find_delimiter`, `find_all_delimiters`,
`find_all_matches` (two-pattern delimiter+quote) and `scan_delimited_ranges` — the bounded,
resumable primitive behind `scanRanges`, which carries quote state and emits completed ranges
directly. Measured ~5–6 GB/s for multi-byte scanning against ~600 MB/s for the JS
Boyer-Moore-Horspool fallback, and ~8–17× for `searchAll`.

### High-level spliterators (all static-class pattern)

- **`TextSpliterator`** — Wraps `Spliterator`/`AsyncSpliterator`, decodes each yielded
  `Uint8Array` to a string via `TextDecoder`. **`trim` is on by default**: each row is trimmed
  after decoding and, with `skipEmpty` (also default), a whitespace-only row is dropped — so a
  CRLF file read on `\n` yields clean lines and `from(" a, b ,,c", { delimiter: "," })` is a
  list parser. `count`/`countAsync` test raw slices for ASCII whitespace to stay in agreement
  without decoding. Pass `trim: false` for byte parity.
- **`JSONSpliterator`** — Wraps `TextSpliterator`-style logic, additionally calls `JSON.parse` on each line.
- **`CSVSpliterator`** — Two-level splitting: first splits rows (newline), then splits each row
  into columns (comma). Supports `mode: "array" | "object" | "entries"`, header normalization,
  and per-column transformers. **`trim` is on by default** and trims every column after
  unquoting, header cells included; RFC 4180 says that whitespace is part of the field, so pass
  `trim: false` for byte parity. **`columnScan: "auto"`** (default) parses a wholly in-memory
  source by decoding it once with a `fatal` decoder and slicing cells at boundaries the
  `scan_csv_cells` kernel emits in UTF-16 units; `"rows"` is the per-row path and the parity
  reference. `lib/formats/csv-cells.ts` drives the kernel in 64 KiB windows; `cellScanEligibility`
  lists the gates (single ASCII delimiters that differ, no CR delimiter, no `position`, under the
  string length cap, scanner loaded, valid UTF-8). The async path reaches it through the
  `bulkParser` argument of `openDelimitedRows`, so only sources the adaptive source reads whole
  take it. Measured (`node out/benchmarks/csv-column-scan.js`, Node 26, Ryzen 9 8945HS, 1M rows ×
  5 columns, min of 7): array 393ms → 220ms, object 766ms → 485ms, entries 1150ms → 793ms;
  quoted CRLF and mixed-UTF-8 fixtures within 10% of those; 8K-row sources 2× on the sync path (a
  310 KB source streams on the async path, which is unchanged). The one cost is first-row
  latency, ~28ms on 40MB, because the whole source decodes on the first pull.
- **`XLSXSpliterator`** — Reads/writes `.xlsx` workbooks via the **optional peer deps**
  `read-excel-file` / `write-excel-file` (dynamically imported; a missing module throws an error
  naming the package). Not a `CSVSpliterator` subclass — XLSX is a ZIP of XML, so there is no
  byte-delimiter machinery to inherit, and **both directions materialize the whole workbook**
  (no bounded-memory promise; prefer CSV when that matters). `fromAsync` mirrors CSV's option
  surface plus `sheet`, but cells arrive **typed** (`string | number | boolean | Date | null`);
  `from()` always throws (vendor is Promise-only). `write(rows)` accepts any (async) iterable of
  arrays or records (record keys become the header) and returns a lazy
  `toFile`/`toBuffer`/`toStream` handle. See
  `docs/superpowers/specs/2026-08-07-xlsx-support-design.md`.

The `mode` emitters and transformer-binding shared by `CSVSpliterator` and `XLSXSpliterator` live in `lib/formats/row-emitters.ts`, generalized over the cell type (CSV binds `string` with `""` for missing columns; XLSX binds typed cells with `null`).

All high-level classes are abstract static-only (instantiation throws `TypeError`). They expose `from(syncSource)` and `fromAsync(asyncSource)` class methods. `from` returns a **`Sequence`**; `fromAsync` returns an **`AsyncSequence`**. Both are lazy and chainable, and neither engine class is one — `Spliterator.fromSync` returns a `Spliterator` (it keeps `position`, `toDecodedArray`, `Symbol.dispose`), and `Sequence.from(spliterator)` wraps it when the chain is wanted.

### `AsyncSequence` (`lib/iterators/AsyncSequence.ts`)

A lazy, chainable async iterator returned by every `fromAsync`. Core methods (`map`, `filter`, `take`, `drop`, `flatMap`, `reduce`, `toArray`, `forEach`, `some`, `every`, `find`) match the [async iterator helpers proposal](https://github.com/tc39/proposal-async-iterator-helpers) in name, arity, and semantics, including the `counter` argument. Extras that are deliberately not spec surface: `chunks(size)`, `parallelMap(fn, opts)`, `parallelFilter(fn, opts)`, `toReadableStream()`, `pipeThrough()`.

- **Fused, not nested.** A chain is an op list plus a source; iteration runs the ops in a plain loop inside one hand-rolled `next()`. One async boundary per item regardless of chain depth — only the op loop grows. Measured on Node 26 over 2M items: bare async generator 10.3M/s, `AsyncSequence` 5.4M/s at three operators and 4.9M/s at six, nested async generators 2.3M/s. Do not "simplify" this into chained `async function*` wrappers; that is a 2.3× regression. Do not extract the pull loop into a separate `async` method either — the extra async frame per item cost 30% when it was tried.
- **`flatMap`, `chunks`, `parallelMap`, and `parallelFilter` are fusion barriers** — they need inner-iterator state, so each starts a fresh segment.
- **Callbacks are awaited only when thenable**, so synchronous callbacks cost no microtask hop.
- **Closure propagates.** Early exit (`take` satisfied, `find`/`some`/`every` hit, `break`, throwing callback) calls `return()` upstream, which reaches `AsyncSpliterator.#finalize()` and releases the file handle. `#finish()` obtains the upstream iterator even if nothing was ever pulled, because an eager source may hold a handle opened before the sequence was constructed — this is why `take(0)` still closes. Fusion barriers wrap their generator in `closingWith`, which forwards `return()` to the inner sequence — `return()` on a never-started generator skips its `finally`, so `barrier.take(0)` would otherwise leak. A thunk source that was never invoked is skipped there, since invoking it would open a file purely to close it.
- **Sources may be deferred** (`SequenceSource<T>` = iterable, async iterable, or a thunk returning either, possibly promised). The thunk form is what lets `fromAsync` return synchronously while its underlying open is async — and it means nothing touches the filesystem until the first pull.
- **Single-shot**, matching the proposal's iterators.
- Wrapping costs ~1.9× a bare async generator. On parsed rows that's 3–8%; on raw `Uint8Array` ranges it's most of the cost, so iterate `AsyncSpliterator` directly for scan-only work.

### `Sequence` (`lib/iterators/Sequence.ts`)

The synchronous sibling, returned by every `from`. Same design as `AsyncSequence` — op-list fusion, one hand-rolled `next()`, `closingWith` around the fusion barriers — and the same method names and arity, minus what only makes sense asynchronously (`parallelMap`, `parallelFilter`) and plus `toAsync()`, which hands the chain to an `AsyncSequence` to continue.

- **The point is the extras, not the core.** Node ships `Iterator.prototype` helpers natively, so `map`/`filter`/`take`/`drop`/... were already free on a bare generator. What was not: `toMap`, `toSet`, `toSorted`, `chunks`, `toReadableStream`, `pipeThrough`. Re-implementing the core ops is what keeps those reachable mid-chain — a native helper returns an `Iterator Helper`, which has none of them, so `.map(f).toMap(g)` would not exist.
- **The two classes are deliberate siblings, not a shared generic.** The sync `next()` has no `await`, no thenable test, and no sync/async upstream fork; folding them together would put that machinery back in the sync path. Keep edits mirrored by hand.
- **Format `from()` methods delegate to a module-level generator** (`decodeRows`, `parseRows`, `splitRows`) and wrap it. Calling a generator function runs none of its body, so `from` stays as lazy as it was. `CSVSpliterator.from` reads `this.ColumnDelimiter` on the way in and passes it, because a private static cannot be reached through a subclass's `this` — that is what keeps `TSVSpliterator`/`PSVSpliterator` working.
- **`Symbol.dispose` closes the sequence**, so `using rows = CSVSpliterator.from(...)` releases the source on scope exit.
- **Wrapping costs 5–9% on parsed rows, 13–16% with three operators stacked.** Measured on Node 26 over 1M rows against the bare generator `from` used to return: `TextSpliterator` 138ms → 150ms → 160ms, `JSONSpliterator` 488ms → 511ms → 550ms. Against a generator doing no work at all it is 1.58× bare and 2.87× at three operators (11ms → 18ms → 33ms over 1M items) — the same shape as `AsyncSequence`, and the same conclusion: negligible once a row is parsed, most of the cost when it is not. For scan-only work iterate `Spliterator` directly.

### Adaptive bulk parsing (`lib/io/adaptive-source.ts`)

Every `fromAsync` opens its source through `openDelimitedRows`, which reads sources at or below `bulkThreshold` (default **128 KiB**) whole and parses them with the **synchronous** engine, streaming everything else. Returns a sync iterable in the first case and an async one in the second; `AsyncSequence` accepts either.

- **The win is fixed setup cost, not throughput.** Opening a handle and standing up a read stream is ~100µs, which dominates a small file and vanishes in a large one. Measured end-to-end, min of 200, two independent sweeps: ~1.85× at 635B, ~1.45× at 6.5KB, ~1.4× at 125KiB, and **nothing reliable at 253KiB or above** — the two sweeps disagreed on the sign there. That is why the default is 128 KiB and not larger; raising it trades memory linearly for a difference that no longer measures.
- **A raw synchronous parse looks far better than this path can deliver** (~1.6× even at 1GiB). The rest is eaten by the per-row cost of `AsyncSequence`, which both paths pay. Don't re-derive the raw number and conclude the threshold should be raised.
- **The bulk path awaits `CharacterSequence.whenReady()`.** The sync engine normally misses the WASM scanner because it finishes before the module loads; reaching it through an async path is the one place that can be fixed, worth ~26% on a large source.
- **Unsized sources use an end-of-input test, not a size test.** Pull one chunk; if the stream is already exhausted the whole input is in hand. Otherwise the pulled chunks are put back in front via a re-headed iterable — `test/io/adaptive-source.test.ts` covers 1/7/64/1024-byte chunkings because losing a chunk here would be silent.
- **`bulkThreshold: 0` forces streaming.** Use it when a bounded footprint is the point.
- Both engines must agree exactly; the parity tests assert the same fixture through both.

### Choosing a parallel primitive

Keyed off **per-row work**, not file size:

| Per-row work                              | Dominates   | Use                                                                        |
| ----------------------------------------- | ----------- | -------------------------------------------------------------------------- |
| None (count, segment, extract a field)    | The scan    | `Spliterator` raw ranges + SIMD (~5–6 GB/s vs ~600 MB/s JS)                |
| ~1–3 µs (`JSON.parse`, CSV→object)        | The parse   | Sequential `fromAsync`. Threads lose (0.3–0.9×); JSONL ~0.5× of `readline` |
| Milliseconds (inference, geocode, crypto) | The handler | `parallelMapWorkers` / `asManyWorkers`                                     |
| I/O-bound (file fan-out, network)         | Latency     | `parallelMap`. Peaks ~2–3 concurrency, then degrades                       |

Naming rule: **closure ⇒ caller's thread; module path ⇒ worker thread** (closures can't cross `postMessage`).

**Reusing workers across calls.** `asManyWorkers` and `parallelMapWorkers`
spawn and terminate their workers per call.
Pass a `WorkerPool` (`lib/parallel/worker-pool.ts`) to keep them warm instead.
Measured **3.3–5.6×** on repeated calls over a 200KB file, and **0.98× on a 52MB file**,
because startup only matters when it is a large share of the call.
Ownership is explicit (`await using pool = new WorkerPool({ size })`).

|                     | Caller's thread                                                   | Worker threads                                                |
| ------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------- |
| Collection of items | `parallelMap` / `parallelFilter` (`lib/parallel/parallel-map.ts`) | `parallelMapWorkers` (`lib/parallel/parallel-map-workers.ts`) |
| One large file      | `AsyncSpliterator.asMany`                                         | `AsyncSpliterator.asManyWorkers`                              |
| Boundaries only     | `AsyncSpliterator.segments`                                       | (feeds either)                                                |

### Node.js adapter (`node/`)

**`node/fs/`** — Node-specific file I/O, split by concern:

- `glob.ts` (`Globerator`)
- `reader.ts` (`createChunkIterator`, `readFileSize`, `readBytes`)
- `writer.ts` (`createFileWritableStream`)
- `concurrency.ts` (`fsConcurrency`)
- `index.ts` is the public barrel, so consumers continue to import from `spliterator/node/fs`.
- `fsConcurrency` reports libuv's threadpool size from `UV_THREADPOOL_SIZE` (default 4 `concurrency` for `parallelMap`/`parallelFilter` over file paths; `availableParallelism()` counts CPUs, not I/O). The `CreateChunkIteratorOptions.end` field is **inclusive** (matches Node.js `createReadStream({ end })`).
  - This subpath is dynamically imported (`import("spliterator/node/fs")`) within the core layer so the library stays isomorphic — the dynamic import only runs in Node environments.

**`node/cli/`** — The `spliterator` binary, built on Node's built-in `util.parseArgs` (no dependencies). `index.ts` dispatches on the first argument; each command in `node/cli/commands/` owns its `parseArgs` call, its `help` string, and a `run(args)` entry. Shared flags and coercion helpers live in `node/cli/utils.ts`.

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

The package's public entry points:

- `.` → `out/index.js` — all public symbols
- `./node/fs` → `out/node/fs/index.js` — Node file helpers (dynamically imported by core)
- `./web` → `out/web.js` — the browser-safe surface: everything in the root minus `XLSXSpliterator`, `createNewlineWriter`, and the worker-thread primitives. Its static graph reaches no bare specifier at all.
- `./casing` → `out/lib/formats/casing.js` — the casing helpers alone. Browser-bundled consumers (mailwoman's codex and core) import from here or from `./web`.

**No entry point statically imports a `node:` module.** `test/package/static-graph.test.ts` walks the compiled graph of the root, `./web`, and `./casing` and fails on one. The root once reached `node:stream/web` and `node:worker_threads`, which made Vite print "externalized for browser compatibility" for every consumer that imported `TextSpliterator` from `"spliterator"`. Bundlers also follow a dynamic `import("literal")` and a `new URL("literal", import.meta.url)` into chunks, so those are not an escape either: every Node-only module and worker entry URL goes through `lib/internal/node-modules.ts`, whose `loadHidden` imports a variable specifier under `@vite-ignore`/`webpackIgnore`. `ReadableStream` is the global, and `createNewlineWriter` loads `node:fs` through `process.getBuiltinModule` because it must stay synchronous. Node-typed imports (`import type`) are fine, they are erased.

**Internal imports use the `#` import map** (`#core/*`, `#formats/*`, `#io/*`, `#iterators/*`, `#parallel/*`, `#internal/*`, `#cli/*`, `#fs/*`, and `#test/*` for examples), declared in `package.json` `imports` as plain `out/**/*.js` targets, like `exports`. TypeScript maps an `out/` target back to its `lib/` source through `rootDir`/`outDir`, so source type-checks against source and a clean build needs no prior `out/`; Node and bundlers take the compiled file. This mirrors mailwoman's maps with one deliberate difference: there is **no `node` condition pointing at source**, and so no `types` condition either. Node refuses to strip types under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so a published package routing `node` to `lib/**/*.ts` would fail on import for every consumer; that only works for workspace symlinks. tsc does not rewrite `#` specifiers, so the compiled tree resolves them through the same map, and worker entry scripts are located with `workerEntryUrl("#parallel/...")`, which goes through `import.meta.resolve`. `test/package/static-graph.test.ts` follows `#` and self-package specifiers through the map.

Plus four worker-runtime subpaths (`./merge-async-iterators`, `./parallel-map-runtime`, `./segment-runtime`, `./segment-workers`), which exist so worker entry modules can import them by specifier rather than by relative path.

**Every non-type import reachable from an entry point must be a real `dependency`.** There are none: `change-case` was dropped in favour of the word splitter in `lib/formats/casing.ts` (`snakeCase`/`camelCase` were checked against change-case 5.4.4 when it went, and `test/formats/casing.test.ts` pins that parity). `type-fest` is type-only — the root re-exports `casing`, whose emitted `.d.ts` references `CamelCase`/`SnakeCase` from it — so it is a devDependency and an **optional peer**, not a runtime dependency. The cost of that choice: a consumer without `type-fest` installed and without `skipLibCheck` sees a `Cannot find module 'type-fest'` error from the shipped `.d.ts`. Production APIs accept structural, string-like path values and do not import `path-ts`; it is a development dependency for test coverage only. `read-excel-file` and `write-excel-file` are optional peers, because `XLSXSpliterator` reaches them through `await import(...)` and throws an error naming the package when they are absent. Declaring a statically imported package optional makes the installed package unimportable — that shipped in 7.3.0 and is worth re-checking before a release: pack the tarball, install it into an empty project, and import it.

Examples import test helpers by relative path (`../test/support/utils.js`), not through the package. `out/test/**` is deliberately not shipped — it is ~944KB of compiled tests, and `fixturesDirectory` resolves relative to the cwd, so it could never work for a consumer.

### Testing

Tests use **vitest** and live in `test/`. Fixtures are in `test/fixtures/`. The `test/support/utils.ts` helper loads fixture files and pre-computes `String.prototype.split` results for parity comparisons.

The parallel-parsing layers are tested bottom-up so the worker protocol is verified without spawning threads: `runSegment` (`test/parallel/segment-runtime.test.ts`) and `workerToIterable` (`test/parallel/workerToIterable.test.ts`) are pure/main-thread; `computeSegments` (`test/parallel/segments.test.ts`) and `asMany` (`test/parallel/asMany.test.ts`) run against temp fixtures and assert the boundary invariant + parity vs sequential parse. Only `test/parallel/asManyWorkers.test.ts`, `pooled-workers.test.ts`, `parallelMapWorkers.test.ts` and `worker-regressions.test.ts` spawn real workers — they use TypeScript fixture handlers in `test/fixtures/segment-handlers/` and `parallel-handlers/` (loaded by file path) and cover parity, the `Uint8Array` transfer path, the path-required `TypeError`, a throwing handler rejecting the iterator, and the lifecycle edges: an omitted delimiter, early exit from a pooled call, two calls sharing a small pool, disposal mid-spawn, a worker that exits without finishing, and an idle pooled worker that throws.

## Non-obvious Gotchas

- **`Buffer.allocUnsafe` pool offset**: Small buffers (< 4096 bytes) share a pool. `new Uint8Array(buf.buffer, 0, n)` reads from offset 0 of the pool — garbage data. Always use `new Uint8Array(buf.buffer, buf.byteOffset, n)`.

- **`node/fs` `end` is inclusive**: `CreateChunkIteratorOptions.end` matches Node.js `createReadStream({ end })` — inclusive. When computing exclusive upper bounds, pass `end - 1`.

- **`workerToIterable` listeners must be eager**: Attaching `worker.on('message')` inside `[Symbol.asyncIterator]()` loses messages posted while a prior segment is being consumed. Listeners must be attached immediately when the iterable is created.

- **Worker batching is required for spin-lock correctness**: Posting records one-by-one means N messages pile up in the main thread's event queue during a block; draining them after the block is O(N). Batching all records into one message reduces post-block work to 4 message events regardless of record count.

- **`BufferController` growth must stay geometric**: `set` grows via `Math.max(nextLength, bytes.length * 2)`. Growing to exactly the length needed makes repeated appends quadratic in bytes copied — invisible on ordinary input, catastrophic for any single record larger than the chunk size, which is precisely what quote handling produces.

- **`BufferController.compress` compacts above a threshold**: it slides the live bytes to offset zero once the discarded prefix outweighs them, rather than always leaving a subarray view. An unconditional view strands that prefix inside the allocation, where it consumes capacity and forces constant re-growth. Don't simplify it back to a plain `subarray`.

- **`CharacterSequence.scanRanges` works in window coordinates**: only `[scanCursor, end)` is staged into WASM memory, and the wrapper rebases what the kernel returns. The first emitted range is the only one that can begin before the window, so it takes the carried absolute `pendingSliceStart`; a call that emits nothing echoes back a meaningless zero, so the carried value stays authoritative there. Callers must keep `pendingSliceStart <= scanCursor`.

- **Quote mode already respects `highWaterMark`**: `scanRanges` is bounded, resumable and carries quote state, and the JS `searchMatches` fallback is bounded too. Measured at 64KiB over a 1M-row quoted CSV, quote mode queues _fewer_ ranges than the non-quote control. This has twice been mistaken for a leak — don't re-fix it.

- **The WASM scanner loads asynchronously**: synchronous callers (`Spliterator.fromSync`, `CSVSpliterator.from`) that finish in a single tick silently use the JS scanner. `await CharacterSequence.whenReady()` first to opt into SIMD.

- **`BufferController` right-sizes over a window, never per compression**: capacity is judged once per 64 compressions against the largest `bytesWritten` seen across that window, and only handed back above 4× it. Shrinking on every compress was measured at 20 shrinks and 121 reallocations against a 7-reallocation baseline (165MB copied against 8.3MB) — a stream still producing large records needs the capacity it was just handed back. A short tail deliberately never reaches an evaluation.

- **A pooled worker imports the handler once, not once per call**: with a `WorkerPool`, handler module top-level state persists across every call routed through that worker — which is the reason to pool, since loading a model is the expensive part, but it is a real difference from the unpooled path where each call gets a fresh module. Relatedly, `workerData` is fixed when the pool spawns a worker, so passing it per call alongside `pool` throws rather than being silently dropped.

- **Pooled worker messages carry a `leaseId`**: a worker is handed to the next caller while a batch from the previous lease may still be in flight, so every message is matched against the active lease and anything else is dropped. Adding a message type to `pool-worker-entry.ts` means carrying the id through it.

- **`caseProfile` has two fast paths that the predicates depend on**: ASCII code units are classified by range with no allocation, and a non-ASCII position runs one sticky `UNCASED_RUN` exec to skip a whole caseless run (a Korean address went 1412ns → 109ns). Rewriting it as a `for..of` over `toUpperCase()`/`toLowerCase()` per character reads simpler and is 4× slower on ASCII and 13× on CJK. `titleCase` sits at ~150 MB/s on ASCII; a `Uint16Array` + `String.fromCharCode.apply` rewrite was measured and is not faster.

- **`scanRanges` stages `[scanCursor, end)` into WASM memory per call, so `end` must be a window**: the sync `Spliterator` passes `min(source, scanCursor + 64 KiB)`, never the whole source. Handing it the remainder copied up to the full source per 4 KiB fill and made a 1M-row quoted CSV scan 969ms against 85ms plain; windowed it is 62ms. The record open at a window's edge resumes through the carried `pendingSliceStart`/`insideQuotes`, which is the kernel's contract. Before this the sync quote path scanned the whole remainder through `searchMatches`, one match object per delimiter, and above `WASM_MAX_RESULTS` that call falls back to the JS scanner.

- **`scan_csv_cells` counts UTF-16 units from the UTF-8 lead byte, which is only exact for valid UTF-8**: the fast path decodes with `{ fatal: true, ignoreBOM: true }` and treats the decoder's `TypeError` as "take the row path". Decoding lossily would silently misalign every cell after the first bad byte. `ignoreBOM` is required too: the row path strips one BOM per row because it decodes per row, so `csv-cells.ts` strips it per row itself.
- **Kernel result views alias shared memory**: `CharacterSequence.scanCells` copies each batch out before returning, because a transformer may run a nested parse while the outer row is being assembled. Don't "optimize" the copy away.
- **A static `import` of anything under `out/` from a test breaks the second `tsc -b`** (TS5055, the emitted `.d.ts` becomes its own input). Tests that need un-exported internals load them in a `beforeAll` through a dynamic import whose specifier is a variable; see `test/core/wasm.test.ts`.

- **`Array.shift()` is O(n)**: Avoid `shift()` on large arrays in hot paths. Use a `head` pointer instead (`chunks[head++]`).

## Known Performance Issues

Open items only — resolved work is in the git log, and the invariants it left behind are in the gotchas above.

Nothing open. Add entries here as they are found, and move the invariant into the gotchas above when one is fixed.
