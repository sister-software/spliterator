# AsyncSequence — a chainable async surface

**Date:** 2026-08-05
**Status:** Draft (pending user review)
**Component:** `spliterator` — new `lib/AsyncSequence.ts`; return types of `*.fromAsync`

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
  are *slower* than a fused implementation. Delegation would be a pessimization.
- **Making `AsyncSpliterator` extend `AsyncSequence`.** The engine stays uncoupled from the sugar.
  It is already `AsyncIterable`, so `AsyncSequence.from(spliterator)` works when wanted. Accepted
  cost: `toReadableStream`/`pipeThrough` exist in two files until a later cleanup.
- **Thenability.** `await sequence` is not supported. `.toArray()` is the terminal.

## Measurements

Node 26, 2M items, `map → filter → map`, `hrtime` around a warmed run.

| Implementation | throughput | vs. bare async generator |
| --- | ---: | ---: |
| bare async generator, no operators | 10.3 M/s | 1.0× |
| **nested async generators** (each helper wraps the last) | **2.4 M/s** | **4.3× slower** |
| **fused, hand-rolled `next()`** | **5.5 M/s** | **1.9× slower** |
| the same fused chain with 6 operators instead of 3 | 5.8 M/s | *free* |

The last row is the design driver. Under fusion, **chain depth costs nothing** — 6 operators measure
the same as 3 (5.8 vs 5.5 is noise). Under nesting, every operator adds a microtask hop per item.

The residual 1.9× is the wrapper object itself, one extra async frame per pulled item. It cannot be
removed while remaining an async iterator.

Sync, same shape, for calibration:

| | throughput |
| --- | ---: |
| bare sync generator, no operators | 70.4 M/s |
| V8 native `Iterator.prototype` helpers, 3 operators | 20.2 M/s |
| the same logic hand-inlined | 68.1 M/s |

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
chunks(size)                          → AsyncSequence<T[]>
parallelMap(fn, { concurrency, signal? })  → AsyncSequence<U>
toReadableStream()   pipeThrough(transform, options?)
```

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

## Breaking changes

1. **`asyncParallelIterator` becomes internal.** It is absorbed into
   `AsyncSequence.prototype.parallelMap` and dropped from the public export. `mailwoman`'s
   `gazetteer-pipeline/admin/ingest-wof.ts:19,244` is the known consumer and migrates in the same
   change:

   ```ts
   const readResults = AsyncSequence.from(filePaths).parallelMap((fp) => readFile(fp, "utf8"), { concurrency })
   ```

2. **`takeAsync` is deleted**; `take(collection, batchSize)` is renamed `chunks`. The name `take` is
   freed for the spec meaning.

3. `*.fromAsync` return types change from `AsyncGenerator<T>` to `AsyncSequence<T>`. Source-compatible
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

`test/asMany.test.ts` and the existing spliterator suites are unchanged and act as the
no-regression baseline for `fromAsync`'s new return type.

## Open questions

- Should `parallelMap` preserve input order, or keep `asyncParallelIterator`'s completion order?
  Completion order is what `ingest-wof.ts` relies on today and is cheaper. Leaning: keep completion
  order, document it loudly, revisit if a caller needs ordering.
- Does `chunks` also want a sync free-function form for parity with the deleted `take`? Leaning no
  until something asks.
