# Parallel map (record-dispatch worker pool) — design

**Date:** 2026-06-30
**Status:** Approved (probe-validated)
**Component:** `spliterator` — new `parallelMap` primitive (target 3.1.0)

## Context

This is the foundation for "parallel giant-CSV import + normalize + geocode" in `mailwoman`. The design
emerged from measurement + a DeepSeek consult, and reverses an earlier file-segment approach:

- **Measured:** `asManyWorkers` (file-segment workers, results to main) only beats single-threaded when
  per-row work is heavy. Light CSV parse / normalize / JSON-encode is **0.3–0.96×** (a loss) — the
  main thread's per-result overhead (~5–10µs/row) exceeds the parallelized savings.
- **Probe (mailwoman):** real neural geocode is **~23 ms/address** — ~2000× that overhead. So geocode
  _is_ worth threading; light normalization is not.
- **Reframe (DeepSeek + agreed):** split the work. A single-threaded streaming **normalize** (light,
  ergonomic, runs everywhere) composed with an optional threaded **geocode** stage. The geocode stage
  takes an async iterable of records (not file segments), so composition + a main-thread filter
  closure both work, and batching drives cross-thread cost <1µs/row.

That geocode stage needs a primitive `asManyWorkers` is not: a **record-dispatch worker pool** that
maps an async iterable through worker threads. That primitive is this spec. (`normalizeCSV` /
`geocodeStream` are the mailwoman follow-on, separate spec.)

## `parallelMap`

```ts
interface ParallelMapOptions {
	/** Worker module path/URL exporting `handleItem(item, ctx)`. Top-level code = per-worker init. */
	worker: string | URL
	/** Number of worker threads in the pool. */
	concurrency: number
	/** Items per dispatched batch. @default 64 */
	batchSize?: number
	/** Max batches in flight across the whole pool (bounds memory / read-ahead). @default 2·concurrency */
	maxInFlight?: number
	/** Forwarded to every worker via `workerData.userData` (must be structured-cloneable). */
	workerData?: unknown
}

function parallelMap<T, R>(
	source: AsyncIterable<T> | Iterable<T>,
	options: ParallelMapOptions
): AsyncIterableIterator<R>
```

- Spawns `concurrency` persistent workers (one pool, not one-per-segment).
- Reads items from `source` on the main thread, batches them (`batchSize`), and dispatches each batch
  to an **idle** worker. Each worker runs `handleItem(item, ctx)` per item and posts the result batch
  back; results stream out as a single merged async iterator in **completion order** (not input order).
- A result of `undefined` drops that item (filter); a `Uint8Array` result is transferred zero-copy.
- **Backpressure:** at most `maxInFlight` batches are outstanding; `source` is not pulled further until
  a slot frees. So a slow consumer / slow workers bound memory.
- **Lifecycle:** all workers terminated on completion, error, or early `return()`. A worker error (or a
  handler throw) rejects the iterator and tears down the pool. `workerData` is enforced cloneable.

### Worker contract

```ts
// worker module
export function handleItem(
  item: T,
  ctx: { index: number }    // global item index (monotonic across the pool)
): R | Uint8Array | undefined | Promise<…>
```

Top-level module code runs once per worker (load models / open read-only DBs here).

## Components (smallest-unit-first)

1. `lib/parallel-map-runtime.ts` — `runPool(io)`: the transport-agnostic pool loop (assign batches to
   idle workers, collect results, backpressure). Unit-tested with fake workers, no `worker_threads`.
2. `lib/parallel-map-worker-entry.ts` — the worker thread runner: imports the handler, processes
   dispatched batches, posts results (transfer `Uint8Array`s), reports idle.
3. `lib/parallel-map.ts` — `parallelMap(...)`: spawns the pool, wires `runPool` to real workers, exposes
   the merged async iterator. Reuses `mergeAsyncIterators`/`workerToIterable` patterns where applicable.

## Failure modes designed against (from the consult)

- **Memory/fd amplification** — N workers each load model + open DB. Document: `concurrency` is bounded
  by RAM, not cores. SQLite consumers must open `?mode=ro&immutable=1` (lock-free concurrent readers).
- **Startup latency** — per-worker init dominates tiny inputs; callers skip the pool below a threshold.
- **Early-termination leaks** — `return()`/`throw` must `worker.terminate()` all workers (await).
- **Non-cloneable `workerData`** — fail loud (closures/handles can't cross).
- **Error isolation** — a worker load/handler error surfaces on the iterator and tears down the pool.

## Testing

- `runPool` (no threads): dispatches all items, respects `maxInFlight`, drops `undefined`, surfaces a
  worker error, completes on source end.
- `parallelMap` (real workers, fixture handler): parity (all items mapped), `Uint8Array` transfer,
  throwing handler rejects + terminates, early break terminates, backpressure bounds in-flight.

## Non-goals (v1)

Ordered output (completion-order only); dynamic concurrency; a persistent cross-call pool.

## Follow-on (separate mailwoman spec)

`normalizeCSV(path, { mapping })` (single-thread streaming) + `geocodeStream(records, { wofDbPath,
dataRoot, locale, country, concurrency, filter? })` (= `parallelMap` + a geocode worker module that
rebuilds classifier/resolver/shards from config) + a guide doc.
