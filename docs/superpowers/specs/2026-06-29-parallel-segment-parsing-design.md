# Parallel segment parsing — design

**Date:** 2026-06-29
**Status:** Approved (pending spec review)
**Component:** `spliterator` — `AsyncSpliterator` static methods + `node/fs` primitives

## Context & goal

Spliterator parses delimited byte streams sequentially. Bulk ingests at sister.software
(`mailwoman`) hit two ceilings:

- **One huge file, CPU-bound transform.** The NPPES registry is ~4.8 GB / 9.6M rows; G-NAF is
  ~16.9M PSV rows. These stream single-threaded via `TextSpliterator.fromAsync(handle)`, then run a
  heavy per-row transform (`parsePersonName` / `canonicalizeOrganizationName` / geocode, or
  `JSON.parse` of a GeoJSON feature). The work is CPU-bound, so the existing async-concurrency
  primitive (`asyncParallelIterator`) — which only overlaps I/O on the main thread — can't speed it
  up.
- **Output is a single-thread writer.** Results feed one sink: a SQLite writer (WOF) or a JSONL
  `createWriteStream` (G-NAF). The consumer wants the **same ergonomics as `asyncParallelIterator`**:
  a single async iterator of results consumed on the main thread.

**Goal:** delegate the read + parse + transform of one large file to worker threads — each worker
holds its own handle to the source and processes a delimiter-aligned byte segment — and stream
results back to the main thread as a single async iterator for a single-thread writer. Only segment
ranges cross outward; only handler results cross back. Raw line bytes never leave the worker.

This replaces the dead `AsyncSpliterator.asMany` stub (`if (Date.now()) throw "Not implemented"`)
and the fictional `asManyWorkers`/`readBytes`/`CreateChunkIteratorOptions.end` that AGENTS.md
documents but that never existed in code.

## Non-goals

- **Many small files.** That stays `asyncParallelIterator` over file paths (worker-per-file would
  pay V8 startup per file). This feature targets **one large file split into N segments**.
- **A persistent worker pool** reused across calls. Future optimization; v1 spawns and terminates
  workers per call (startup amortizes over a multi-GB file).
- **Output ordering.** Results interleave across segments (whatever finishes first). Targeted sinks
  are order-agnostic (id-keyed SQLite, reservoir sample). File-order output is out of scope.
- **Quote-aware CSV across segment boundaries.** v1 aligns on a raw delimiter; a quoted field
  containing the delimiter that straddles a segment boundary is not specially handled. Document the
  assumption (the target government files are unquoted, matching the existing `ingest.ts` note).

## Architecture overview

Three layers, smallest-useful-unit first. Layers 1 and 2 are independently valuable: they directly
deliver "compute byte ranges, hand each to a thread that owns a handle," which the consumer can wire
into its own worker pool. Layer 3 is the turnkey orchestrator.

```
        ┌─────────────────────────────────────────────────────────────┐
        │ main thread                                                   │
        │  AsyncSpliterator.segments(path, {delimiter, concurrency})    │  Layer 2
        │     → [ [0,a], [a,b], [b,c], ... ]   (delimiter-aligned)      │
        │  asManyWorkers(path, {worker, ...})                           │  Layer 3
        │     → single AsyncIterableIterator<R>  → single-thread writer │
        └───────────┬───────────────────────────┬─────────────────────┘
            range {start,end}              results (batched, transferable)
                    │                             ▲
        ┌───────────▼─────────────────────────────┴────────────────────┐
        │ worker k (own handle)                                         │
        │  createChunkIterator(path, {start, end})  ──► AsyncSpliterator│  Layers 1+2
        │  per record → handleRecord(bytes, ctx) → batch → post         │
        └──────────────────────────────────────────────────────────────┘
```

## Layer 1 — `node/fs` primitives

### `CreateChunkIteratorOptions.end?: number`
Inclusive upper byte bound, matching Node's `createReadStream({ end })`. Passed through to the read
stream so a chunk iterator stops at a segment's end. To read the half-open byte range `[start, end)`,
callers pass `{ start, end: end - 1 }`. (AGENTS.md already documents this semantic; we make it real.)

### `readBytes(source: AsyncDataResource, start: number, length: number): Promise<Uint8Array>`
Random-access window read for boundary probing. Opens (or reuses) a handle, reads up to `length`
bytes from `start`, returns the (EOF-clamped, possibly shorter) slice. `@internal`.

### fd-leak fix
`ingest.ts` works around a real bug: `autoDispose` only fires on natural completion, not on an early
`break`/`.return()`, leaking the fd (a GC-time error in Node 24+). The range readers and workers
must dispose their handles on **early termination and error**, not only on natural EOF. Concretely:
`AsyncSpliterator.return()` / `[Symbol.asyncDispose]` must close an owned handle, and the worker
closes its handle in a `finally`.

## Layer 2 — boundary detection

### `AsyncSpliterator.segments(source, options): Promise<ByteRange[]>`

```ts
interface SegmentOptions {
  delimiter?: CharacterSequenceInput  // default: LineFeed
  concurrency: number                 // desired segment count (clamped ≥ 1)
  probeSize?: number                  // boundary probe window bytes (default 64 KiB)
}
```

Algorithm:
1. `fileSize = readFileSize(source)`. If `fileSize === 0` → return `[]`.
2. If `concurrency ≤ 1` → return `[[0, fileSize]]`.
3. Ideal cut points `cᵢ = round(i · fileSize / concurrency)` for `i ∈ 1..concurrency-1`.
4. For each `cᵢ`, **in parallel** (`Promise.all`): `readBytes(source, cᵢ, probeSize)`, find the
   first delimiter via `CharacterSequence.search`; the real cut is **just after** it
   (`cᵢ + delimiterIndex + delimiter.length`). A probe with no delimiter (record longer than
   `probeSize`) collapses that cut (`log` it — no silent drop).
5. Dedup + sort cuts; build contiguous `[start, end)` segments covering `[0, fileSize]`; drop
   zero-length segments. Result has **≤ concurrency** segments.

**Invariant (the correctness contract):** segments are contiguous, non-overlapping, cover the whole
file, and every internal boundary sits immediately after a delimiter — so concatenating each
segment's records reproduces the file's records exactly, with **no record split or duplicated**.

## Layer 3a — `asMany`

### `AsyncSpliterator.asMany(source, options): Promise<AsyncSpliterator[]>`

```ts
interface AsManyOptions { delimiter?: CharacterSequenceInput; concurrency: number; probeSize?: number }
```

`segments(...)` → one `AsyncSpliterator` per segment via
`createChunkIterator(source, { start, end: end - 1 })`. All share the event loop (no threads) — for
moderate jobs or I/O-overlap. Returns ≤ `concurrency` instances.

## Layer 3b — `asManyWorkers`

### `AsyncSpliterator.asManyWorkers<R>(source, options): AsyncIterableIterator<R>`

```ts
interface AsManyWorkersOptions {
  worker: string | URL          // module path; exports handleRecord (see contract)
  delimiter?: CharacterSequenceInput
  concurrency: number
  probeSize?: number
  batchSize?: number            // records per message (default 256)
  maxInFlight?: number          // unacked batches per worker before it pauses (default 4)
  workerData?: unknown          // forwarded to every worker (e.g. config)
}
```

- **Source must be a path string or URL.** File handles can't cross threads → `TypeError` otherwise.
- Returns **one merged async iterator** of handler results, interleaved across workers, consumed on
  the main thread by a single-thread writer.

### Two distinct worker pieces
1. **The library's worker runner** — a small module spliterator ships (e.g. `out/lib/segment-worker.js`,
   spawned via `new Worker(runnerUrl, { workerData })`). It opens the handle for its segment
   (`createChunkIterator(path, { start, end: end - 1 })`), iterates records, calls the user handler,
   and runs the batching/transfer/ack protocol. Resolved module URLs (the runner's, the user
   handler's) are passed via `workerData` so the worker loads the exact same build as the parent.
2. **The user's handler module** (`options.worker`) — dynamically `import()`ed by the runner.

### Worker module contract
The `worker` module runs **once per worker** at import (top-level code, incl. top-level `await`, is
the per-worker init — load models/handles here). It exports:

```ts
export function handleRecord(
  record: Uint8Array,
  ctx: { index: number; segmentIndex: number }
): R | Uint8Array | undefined | Promise<...>
```

- Return a value → cloned back to main and yielded.
- Return a `Uint8Array` → its buffer is **transferred** (zero-copy) and yielded. (The write-heavy
  path: worker does `JSON.stringify` + encode, main just `fs.write`s the bytes.)
- Return `undefined` → record skipped (the filter case, e.g. WOF's non-matching feature).
- `ctx.index` is per-segment monotonic; `segmentIndex` identifies the segment. A globally-stable id
  derives from `(segmentIndex, index)`.

### Message protocol (the bottleneck mitigations, baked in)
- **Chunked batching:** workers post every `batchSize` results as one message — never per-record
  (queue pressure), never whole-segment (no streaming, unbounded worker memory).
- **Zero-copy transfer:** any `Uint8Array` result in a batch is added to the message's transfer
  list. Plain objects fall back to structured clone.
- **Backpressure (bounded in-flight):** a worker may have at most `maxInFlight` un-acked batches
  outstanding; main posts an `ack` after consuming each batch. The worker awaits an ack before
  exceeding the window, so main's incoming-message queue (and memory) stays bounded even when the
  writer is slower than the workers.
- **Sentinels & errors:** each worker posts a `done` sentinel when its segment is exhausted; the
  merged iterator completes when all workers are done. Any worker error rejects the iterator and
  **terminates all workers**; `.return()` / early break terminates them too (and closes handles).

### `workerToIterable`
Per the AGENTS.md gotcha: attach `message`/`error` listeners **eagerly at construction** (not inside
`[Symbol.asyncIterator]`, which loses messages posted while a prior segment is consumed) and drain
via a `chunks[] + head` pointer (no `Array.shift()` in the hot path).

## Bottlenecks & mitigations (accepted)

| Bottleneck | Mitigation in this design |
|---|---|
| Single-thread writer = Amdahl ceiling | Push all per-record work into the worker; worker emits final output form (bytes for JSONL, the exact tuple for SQLite) so main's per-record cost ≈ 0. |
| Cross-thread clone cost | Transfer `Uint8Array` results zero-copy; objects clone only as a convenience. |
| Message overhead | Chunked batches (`batchSize`), not per-record. |
| Main queue / memory blowup | Bounded in-flight window (`maxInFlight`) + ack backpressure. |
| CPU- vs I/O-bound | Documented: threads help only when transform dominates the read; assumes SSD/NVMe (parallel offset reads thrash an HDD). |
| Per-worker memory | Heavy handler deps load N×; choose `concurrency` for RAM, keep the handler module lean. Documented. |
| Result ordering | Interleaved; documented as order-agnostic (non-goal otherwise). |

## Testing strategy (TDD)

- **`node/fs`:** `readBytes` returns the correct window incl. EOF clamp; `createChunkIterator` with
  `end` stops at the inclusive bound; early `.return()` closes the handle (no fd leak).
- **`segments` invariant:** generated fixtures (varied row sizes, CRLF, a record longer than
  `probeSize`, file smaller than `concurrency`, empty file) — segments contiguous, cover `[0,size]`,
  each boundary delimiter-aligned; concatenated records equal the sequential parse.
- **`asMany` parity:** flattened decoded records across all segments equal `TextSpliterator`
  sequential over the whole file, at concurrency 1 / 4 / > record-count.
- **`asManyWorkers`:** temp fixture file + a fixture worker module. Parity (collected results equal
  the sequential transform), `TypeError` on a non-path source, `Uint8Array` transfer path, batching
  + backpressure (results stream before any single segment finishes; main queue stays bounded), a
  throwing handler rejects the iterator and terminates workers, early `.return()` terminates workers.

## Open questions / future

- Persistent pre-warmed worker pool (bridges the many-small-files case; removes per-call startup).
- Streaming `batchSize` by bytes as well as record count.
- Quote-aware segment boundaries.
