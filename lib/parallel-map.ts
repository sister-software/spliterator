/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { AsyncSequence, type ParallelMapSequenceOptions } from "./AsyncSequence.js"

/**
 * Map an iterable through a callback with up to `concurrency` calls in flight, yielding in **completion order** — not
 * input order.
 *
 * The callback is a closure, so every call runs on the caller's thread. This overlaps _latency_ — file reads, network
 * round-trips, anything that spends its time waiting — and does nothing for CPU-bound work, which still occupies the
 * one thread it always did.
 *
 * **Concurrency is not core count.** Work that contends for a shared resource (one disk, one socket pool, one on-disk
 * database) peaks _low_ — often ~2–3 — and then degrades. Sweep it.
 *
 * @param source The collection to map.
 * @param fn The callback, receiving `(value, counter)`.
 * @param options Concurrency ceiling and optional abort signal.
 *
 * @yields Each result, in completion order.
 * @see {@linkcode parallelMapWorkers} to run the handler on worker threads instead — it takes a module path rather than
 *   a closure, because a closure cannot cross a thread boundary.
 * @see The "Choosing a primitive" table in the README, which keys the decision off per-row work.
 */
export function parallelMap<T, U>(
	source: AsyncIterable<T> | Iterable<T>,
	fn: (value: T, counter: number) => U | PromiseLike<U>,
	options: ParallelMapSequenceOptions
): AsyncSequence<U> {
	return AsyncSequence.from(source).parallelMap(fn, options)
}
