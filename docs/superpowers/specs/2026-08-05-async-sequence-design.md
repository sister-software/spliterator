# AsyncSequence — a chainable async surface

**Date:** 2026-08-05
**Status:** Draft (pending user review)
**Component:** `spliterator` — new `lib/AsyncSequence.ts`; return types of `*.fromAsync`; naming of
the parallel primitives

## Context & goal

The high-level spliterators are abstract static classes reached through `from` / `fromAsync`. That
shape is fine and stays. The problem is narrower: **`fromAsync` returns a bare `AsyncGenerator`, and
there is nothing you can do with one except `for await`.**

The sync side has no such problem. `engines` is `>= 24.0.0`, and Node 24+ ships
`Iterator.prototype.map/filter/take/drop/flatMap/reduce/toArray` (verified on Node 26). So
`TextSpliterator.from(...)` already returns a first-class chainable JavaScript value. Async iterator
helpers ([tc39/proposal-async-iterator-helpers][proposal]) have not shipped anywhere, and the
proposal has been quiet in committee for a long time. Only the async half is stranded — and async is
the half a streaming library exists for.

The cost is visible at call sites in `mailwoman`:

```ts
// dev-tools/failure-report.run.ts:76-92 — take + filter + map, written longhand
let i = -1
for await (const row of JSONSpliterator.fromAsync<…>(resolve(dir!, file))) {
  i++
  if (i >= sampleN) break            // Iterator.prototype.take, hand-rolled
  if (!row.raw || !row.components) continue
  fixtures.push({ … })
}

// dev-tools/failure-report.run.ts:98-100 — the damning one
const fixtures = (await Array.fromAsync(JSONSpliterator.fromAsync<ParityFixture>(PARITY_FIXTURES_PATH)))
  .filter((f) => !f.dropped && f.expect)
  .map((f) => ({ … }))
```

The second buffers the whole corpus into an array **in order to have `.filter`/`.map`**, then
filters. The streaming benefit is discarded at the seam — not through carelessness, but because
`Array.fromAsync` is the only route to combinators. The ergonomic path is currently the
non-streaming one. That is the defect this design closes.

**Goal:** `fromAsync` returns something chainable, spec-shaped, and lazy, without writing a parallel
sync helper class and without asking anyone to install a polyfill.

[proposal]: https://github.com/tc39/proposal-async-iterator-helpers

## Non-goals

- **A sync `Sequence` class.** Node 24+ already ships the sync helpers. Writing a second class to
  duplicate them is the maintenance cost this design exists to avoid. The one sync gap is batching
  (`chunks`), and a whole class is too much to pay for one method.
- **Delegating to native `AsyncIterator` when it exists.** Measurements below show native helpers
  are _slower_ than a fused implementation. Delegation would be a pessimization.
- **Making `AsyncSpliterator` extend `AsyncSequence`.** The engine stays uncoupled from the sugar.
  It is already `AsyncIterable`, so `AsyncSequence.from(spliterator)` works when wanted. Accepted
  cost: `toReadableStream`/`pipeThrough` exist in two files until a later cleanup.
- **Thenability.** `await sequence` is not supported. `.toArray()` is the terminal.

## Measurements

Node 26, 2M items, `map → filter → map`, `hrtime` around a warmed run.

| Implementation                                           |  throughput | vs. bare async generator |
| -------------------------------------------------------- | ----------: | -----------------------: |
| bare async generator, no operators                       |    10.3 M/s |                     1.0× |
| **nested async generators** (each helper wraps the last) | **2.4 M/s** |          **4.3× slower** |
| **fused, hand-rolled `next()`**                          | **5.5 M/s** |          **1.9× slower** |
| the same fused chain with 6 operators instead of 3       |     5.8 M/s |                   _free_ |

The last row is the design driver. Under fusion, **chain depth is nearly free**. Under nesting, every
operator adds a microtask hop per item.

**Measured again against the shipped class**, same machine and shape:

| Implementation                       | throughput |
| ------------------------------------ | ---------: |
| bare async generator, no operators   |   10.3 M/s |
| `AsyncSequence`, 3 operators         |    5.4 M/s |
| `AsyncSequence`, 6 operators         |    4.9 M/s |
| nested async generators, 3 operators |    2.3 M/s |

The prototype's perfectly-flat depth curve does not survive into the real class — doubling the
operator count costs ~10%, since the op loop still grows even though the async boundary does not.
Nesting the same six would roughly double. The 1.9× wrapper tax holds.

One implementation detail is load-bearing: extracting the pull loop into its own `async` method (to
host the try/catch that closes on a throwing callback) cost **30%** — 3.8 M/s against 5.4 — because
it adds a second async frame per item. The try/catch has to sit inline in `next()`.

The residual 1.9× is the wrapper object itself, one extra async frame per pulled item. It cannot be
removed while remaining an async iterator.

Sync, same shape, for calibration:

|                                                     | throughput |
| --------------------------------------------------- | ---------: |
| bare sync generator, no operators                   |   70.4 M/s |
| V8 native `Iterator.prototype` helpers, 3 operators |   20.2 M/s |
| the same logic hand-inlined                         |   68.1 M/s |

**V8's native helpers are not fused** — a 3.4× tax against hand-inlining. The proposal specifies
each helper as a composed iterator object, so native async helpers will carry the same shape (the
2.4 M/s row). A fused implementation beats them.

That reframes what spec-compatibility buys. It is **not** "a temporary polyfill you delete when the
proposal lands." The class is permanent. Compatibility buys call sites that keep working verbatim if
you ever do swap to native, and knowledge that transfers to any other codebase.

### When the tax matters

A microtask hop is ~100ns. The tax is entirely a function of per-row work:

- **Parsed rows (JSONL, CSV → objects).** `JSON.parse` on a row is ~1–3µs. Iteration overhead is
  3–8%, invisible. `AGENTS.md` already documents this path as parse-bound.
- **Raw `Uint8Array` ranges, no parse.** Per-row work is tens of nanoseconds, so a 1.9× iteration
  tax is most of the cost — and it lands on exactly the workload `AGENTS.md` names as spliterator's
  real edge ("the scan advantage only shows when you _don't_ fully parse every row").

The mitigation is not cleverness, it is an escape hatch: `AsyncSpliterator` stays a bare async
iterator, `for await` over it costs what it costs today, and `AsyncSequence` is opt-in on top.

## Surface

One new file, `lib/AsyncSequence.ts`. A class implementing `AsyncIterableIterator<T>` over any
`AsyncIterable<T> | Iterable<T>`.

**Spec-compatible core.** Names, arity, and semantics match the proposal exactly, including the
`counter` second argument to callbacks. Callbacks may return promises. No extra parameters, no bent
semantics.

```
map(fn)   filter(fn)   take(n)   drop(n)   flatMap(fn)      → AsyncSequence<U>   (lazy)
reduce(fn, init?)   toArray()   forEach(fn)
some(fn)   every(fn)   find(fn)                             → Promise<…>         (terminal)
AsyncSequence.from(source)                                  → AsyncSequence<T>   (static)
```

**Quality-of-life extras**, named so they cannot be mistaken for spec surface:

```
chunks(size)                               → AsyncSequence<T[]>
parallelMap(fn, { concurrency, signal? })  → AsyncSequence<U>
toReadableStream()   pipeThrough(transform, options?)
```

`parallelMap` here takes a **closure**, so under the naming rule below it runs on the caller's
thread. The threaded free function is `parallelMapWorkers`.

`chunks` resolves a live name collision. Spec `take(n)` yields the **first n items**; the existing
`take`/`takeAsync` in `lib/take.ts` yield **batches of n**. Shipping spec helpers next to them would
leave `take` meaning two opposite things in one package, and `failure-report.ts:81` is a spec-`take`
use case. `chunks` is the name the [iterator-chunking proposal][chunking] uses.

[chunking]: https://github.com/tc39/proposal-iterator-chunking

## Semantics

**Fusion.** A chain is an **op list plus a source**, not nested generators. Each intermediate method
returns a new `AsyncSequence` carrying `[...ops, newOp]`. Iteration is a hand-rolled `next()` that
pulls one value from the source and runs the op list in a plain `for` loop. One async boundary per
item regardless of depth.

Callback results are awaited **only when thenable** (`typeof r?.then === "function"`). Sync
callbacks — `(f) => !f.dropped`, the common case — cost zero hops.

`flatMap` is a **fusion barrier**: it needs inner-iterator state, so it starts a new fused segment
rather than pretending to be free. Documented as such.

**Laziness and closure.** Intermediates pull nothing until iterated; terminals drive. On early exit —
`take(n)` satisfied, `find` hit, a `break` out of `for await`, a thrown callback — the wrapper calls
`return()` upstream. That reaches `AsyncSpliterator.return()` → `#finalize()`
(`lib/AsyncSpliterator.ts:672`) and releases the file handle. Without it, `.take(5)` on a 40 GB file
leaks a handle. This gets a dedicated test.

**Where applied.** `TextSpliterator.fromAsync`, `JSONSpliterator.fromAsync`, and
`CSVSpliterator.fromAsync` stop being `async function*` and become plain functions returning
`AsyncSequence<T>` over a private inner generator. **Returned synchronously** —
`JSONSpliterator.fromAsync(path).filter(…)` must not require an `await` first.

`Array.fromAsync(sequence)` keeps working; it is still `AsyncIterable`.

## Naming — the `Workers` convention

Five primitives already exist for going parallel, on two axes, and the naming makes the second axis
invisible:

|                       | main thread                 | worker threads                   |
| --------------------- | --------------------------- | -------------------------------- |
| a collection of items | `asyncParallelIterator`     | `parallelMap`                    |
| one big file          | `AsyncSpliterator.asMany`   | `AsyncSpliterator.asManyWorkers` |
| just the boundaries   | `AsyncSpliterator.segments` | (feeds either)                   |

`asyncParallelIterator` vs `parallelMap` gives the reader nothing; only `asMany`/`asManyWorkers`
signals the column. A `Workers` suffix, applied consistently, means "this crosses a thread
boundary":

```
parallelMap(source, fn, { concurrency })             ← main thread   (was asyncParallelIterator)
parallelMapWorkers(source, { worker, concurrency })  ← threads       (was parallelMap)
asMany(source, …)   /   asManyWorkers(source, { worker, … })          (unchanged, already correct)
```

This encodes a rule that is **already true of every primitive here and simply unstated**:

> **If you can pass a closure, it runs on your thread. If you must pass a module path, it runs on
> another one.**

Closures cannot cross `postMessage`, so the signature already carries the information — `asManyWorkers`
requires a path/URL for exactly this reason. Aligning the names turns an accident into a rule a
caller can hold in their head, and it resolves the collision this design would otherwise introduce
(`AsyncSequence.prototype.parallelMap` takes a closure; the free threaded function needed a
different name).

## Choosing a primitive

The guidance exists today but is scattered across one function's JSDoc (`lib/parallel-map.ts:80-92`)
and `AGENTS.md`, so nobody meets it at decision time. Callers ask "how big is my file?" The question
that actually predicts the answer is **how much work happens per row**:

| per-row work                                     | what dominates | reach for                                                                                     |
| ------------------------------------------------ | -------------- | --------------------------------------------------------------------------------------------- |
| none — counting, segmenting, pulling two fields  | the scan       | `Spliterator` raw ranges; WASM SIMD earns its keep (~5–6 GB/s vs ~600 MB/s JS BMH)            |
| ~1–3 µs — `JSON.parse`, CSV→object, normalize    | the parse      | plain sequential `fromAsync`. Threads **lose** here (0.3–0.9×); JSONL is ~0.75× of `readline` |
| ms-scale — inference, geocode, crypto, image ops | your handler   | `parallelMapWorkers` / `asManyWorkers`                                                        |
| I/O-bound — `readFile` fan-out, network          | latency        | `parallelMap` (main thread). Concurrency peaks ~2–3, then **degrades**                        |

The line worth stating once, loudly: **the scan is almost never the bottleneck unless you aren't
parsing.** The library currently lets people discover that the expensive way.

Placement: canonical table in `README.md` (a `## Choosing a primitive` section ahead of the existing
`### Parallel parsing across threads` at line 156), mirrored in `AGENTS.md`, with a `@see` from each
parallel primitive's JSDoc so it is reachable from editor hover. The two copies are prose, not code;
drift is acceptable against the reachability win.

## Breaking changes

1. **`asyncParallelIterator` → `parallelMap`** (main-thread), and the existing threaded
   **`parallelMap` → `parallelMapWorkers`**. Note this is a _silent_ break for anyone importing
   `parallelMap` today: the name survives with a different execution model. Release notes must call
   it out explicitly; the old threaded name is not kept as a deprecated alias, because an alias that
   resolves to main-thread execution is worse than a missing export.

2. **`asyncParallelIterator`'s free-function form is dropped** in favour of
   `AsyncSequence.prototype.parallelMap` plus the renamed free function. `mailwoman`'s
   `gazetteer-pipeline/admin/ingest-wof.ts:19,244` is the known consumer and migrates in the same
   change:

   ```ts
   const readResults = AsyncSequence.from(filePaths).parallelMap((fp) => readFile(fp, "utf8"), { concurrency })
   ```

3. **`takeAsync` is deleted**; `take(collection, batchSize)` is renamed `chunks`. The name `take` is
   freed for the spec meaning.

4. `*.fromAsync` return types change from `AsyncGenerator<T>` to `AsyncSequence<T>`. Source-compatible
   for `for await` and `Array.fromAsync` consumers; a type-level break for anyone naming the type.

Major version bump.

## Defects fixed en route

**`index.ts` does not compile at HEAD (243b890).** `lib/zip.ts` was added but the originals were
left in `lib/shared.ts:218-268`, and `index.ts` star-exports both:

```
index.ts(18,1): error TS2308: Module "./lib/shared.js" has already exported a member named 'Zipped'.
  …'ZippedEntries', 'zipAsync', 'zipSync', 'zippedEntries'
```

Fix: delete the five from `shared.ts` (`CSVSpliterator` already imports from `./zip.js`).

**`asyncParallelIterator` silently drops results on duplicate items** (`lib/take.ts:26-27`).
`runningTasks` and `results` are both `Map`s **keyed by the item value**. Two `===`-equal items — and
`ingest-wof.ts` feeds it an array of path strings — collide: the second `set` overwrites the first,
`runningTasks.delete(entry)` removes the wrong entry, and one result is yielded where two were
expected. Correct today only because `FastGlob` returns unique paths. Fix: key by a monotonic slot
index when it moves into `parallelMap`.

## Testing

`test/AsyncSequence.test.ts`:

- **Spec parity.** Each core method against the proposal's semantics, including the `counter`
  argument and promise-returning callbacks.
- **Fusion is observable-equivalent.** A chained result equals the same operations applied via nested
  plain async generators, for a matrix of op orders including `flatMap` barriers.
- **Early close.** `take(n)` / `find` / `break` / throwing callback each call `return()` upstream —
  asserted with a spy source, then end-to-end against a real `AsyncSpliterator` asserting the file
  handle closed.
- **Laziness.** A source that throws on the Nth pull is not reached when `take(N-1)` is used.
- **`chunks`** boundary cases: exact multiple, remainder, empty source.
- **`parallelMap`**: concurrency ceiling respected; **duplicate items each produce a result** (the
  regression test for the Map-keying defect); abort signal; rejection propagates.

`test/parallelMap.test.ts` → `test/parallelMapWorkers.test.ts`, renamed with its subject but otherwise unchanged — the threaded
implementation moves name only, not behaviour, so the existing suite is the proof that
`parallelMapWorkers` is the same code.

`test/asMany.test.ts` and the existing spliterator suites are unchanged and act as the
no-regression baseline for `fromAsync`'s new return type.

## Open questions

- Should `parallelMap` preserve input order, or keep `asyncParallelIterator`'s completion order?
  Completion order is what `ingest-wof.ts` relies on today and is cheaper. Leaning: keep completion
  order, document it loudly, revisit if a caller needs ordering.
- Does `chunks` also want a sync free-function form for parity with the deleted `take`? Leaning no
  until something asks.
