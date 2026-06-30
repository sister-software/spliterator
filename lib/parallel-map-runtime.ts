/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 *
 * Transport-agnostic core of `parallelMap` — a record-dispatch worker pool. `runPool` keeps every
 * worker busy mapping batches pulled from one shared source, with no `worker_threads` dependency so it
 * unit-tests against fake workers.
 */

import { mergeAsyncIterators } from "./merge-async-iterators.js"

/** One pool slot. `process` ships a batch to its worker and resolves with that batch's results. */
export interface PoolWorker<T, R> {
	process(batch: T[]): Promise<R[]>
}

/**
 * Serialize pulls from `source` into batches of up to `batchSize`. Returns a `next()` that is safe to call concurrently
 * (each call awaits the prior pull) — concurrent worker loops share one source without racing the underlying iterator.
 * Resolves `null` once the source is exhausted.
 */
function makeBatcher<T>(source: AsyncIterable<T> | Iterable<T>, batchSize: number): () => Promise<T[] | null> {
	const iterator =
		Symbol.asyncIterator in source
			? source[Symbol.asyncIterator]()
			: (source[Symbol.iterator]() as unknown as AsyncIterator<T>)

	let chain: Promise<unknown> = Promise.resolve()
	let exhausted = false

	return () => {
		const pull = chain.then(async () => {
			if (exhausted) return null

			const batch: T[] = []

			while (batch.length < batchSize) {
				const { value, done } = await iterator.next()

				if (done) {
					exhausted = true
					break
				}

				batch.push(value)
			}

			return batch.length > 0 ? batch : null
		})

		// Keep the chain alive regardless of this pull's outcome so the next call still serializes.
		chain = pull.then(
			() => undefined,
			() => undefined
		)

		return pull
	}
}

/**
 * Drive a pool of `workers` over `source`: each worker loops — pull a batch, map it, emit results — until the source is
 * exhausted. Results stream out in completion order (a worker's whole batch yields before it pulls the next, which
 * bounds in-flight work to the pool size). A worker error propagates and tears the pool down.
 */
export function runPool<T, R>(
	workers: Array<PoolWorker<T, R>>,
	source: AsyncIterable<T> | Iterable<T>,
	batchSize: number
): AsyncIterableIterator<R> {
	const nextBatch = makeBatcher(source, batchSize)

	async function* workerLoop(worker: PoolWorker<T, R>): AsyncIterableIterator<R> {
		for (;;) {
			const batch = await nextBatch()

			if (batch === null) return

			const results = await worker.process(batch)

			yield* results
		}
	}

	return mergeAsyncIterators(workers.map((worker) => workerLoop(worker)))
}
