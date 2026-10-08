/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 *
 * Transport-agnostic core of `parallelMap` — a record-dispatch worker pool.
 * `runPool` keeps every worker busy mapping batches pulled from one shared source,
 *  with no `worker_threads` dependency so it unit-tests against fake workers.
 */

import { mergeAsyncIterators } from "#parallel/merge-async-iterators"

/**
 * One pool slot. `process` ships a batch to its worker and resolves with that batch's results.
 */
export interface PoolWorker<T, R> {
	process(batch: T[]): Promise<R[]>
	/**
	 * Called once the slot's loop ends, however it ends. A pooled slot returns its lease here.
	 */
	release?(): void
}

/**
 * A slot that is obtained when its loop starts rather than before the pool runs. Lets a call over a shared
 * {@linkcode WorkerPool} begin with the workers it has instead of waiting for all it asked for, which is what kept two
 * concurrent calls from deadlocking each other.
 */
export type PoolSlot<T, R> = PoolWorker<T, R> | (() => Promise<PoolWorker<T, R>>)

/**
 * Serialize pulls from `source` into batches of up to `batchSize`. Returns a `next()` that is safe to call concurrently
 * (each call awaits the prior pull) — concurrent worker loops share one source without racing the underlying iterator.
 * Resolves `null` once the source is exhausted.
 */
function makeBatcher<T>(
	source: AsyncIterable<T> | Iterable<T>,
	batchSize: number
): { next: () => Promise<T[] | null>; close: () => Promise<void> } {
	const iterator =
		Symbol.asyncIterator in source
			? source[Symbol.asyncIterator]()
			: (source[Symbol.iterator]() as unknown as AsyncIterator<T>)

	let chain: Promise<unknown> = Promise.resolve()
	let exhausted = false

	const next = () => {
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

			return batch.length ? batch : null
		})

		// Keep the chain alive regardless of this pull's outcome so the next call still serializes.
		chain = pull.then(
			() => undefined,
			() => undefined
		)

		return pull
	}

	// Serialized behind any in-flight pull, so the source is never closed mid-`next()`.
	const close = async (): Promise<void> => {
		await chain

		if (exhausted) return

		exhausted = true

		await iterator.return?.()
	}

	return { next, close }
}

/**
 * Drive a pool of `workers` over `source`: each worker loops — pull a batch, map it, emit results — until the source is
 * exhausted. Results stream out in completion order (a worker's whole batch yields before it pulls the next, which
 * bounds in-flight work to the pool size). A worker error propagates and tears the pool down.
 */
export function runPool<T, R>(
	slots: Array<PoolSlot<T, R>>,
	source: AsyncIterable<T> | Iterable<T>,
	batchSize: number
): AsyncIterableIterator<R> {
	const batcher = makeBatcher(source, batchSize)
	// Set the moment the consumer leaves or a worker fails, before the loops are asked to return: a slot still waiting
	// on its thunk cannot receive that `return()` until it resumes, and must not pull a batch when it does.
	let stopping = false

	async function* workerLoop(slot: PoolSlot<T, R>): AsyncIterableIterator<R> {
		const worker = typeof slot === "function" ? await slot() : slot

		try {
			for (;;) {
				if (stopping) return

				const batch = await batcher.next()

				if (batch === null || stopping) return

				const results = await worker.process(batch)

				yield* results
			}
		} catch (error) {
			stopping = true

			throw error
		} finally {
			worker.release?.()
		}
	}

	async function* run(): AsyncIterableIterator<R> {
		try {
			yield* mergeAsyncIterators(slots.map((slot) => workerLoop(slot)))
		} finally {
			// Early exit, a worker error, or exhaustion: the source's `return()` runs in every case.
			await batcher.close()
		}
	}

	const iterator = run()
	// An async generator always has `return`; the type says optional for iterators in general.
	const forward = iterator.return!.bind(iterator)

	iterator.return = (value) => {
		stopping = true

		return forward(value)
	}

	return iterator
}
