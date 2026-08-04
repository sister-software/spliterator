/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

/**
 * Given an iterable collection, returns an async iterable, executing the callback on each batch.
 *
 * This is useful for batching asynchronous operations.
 *
 * @param collection The collection to batch.
 * @param batchSize The size of each batch.
 * @param callback The async callback to execute on each batch.
 *
 * @yields The result of each callback execution
 */
export async function* asyncParallelIterator<T, C extends (entry: T) => Promise<unknown>>(
	collection: Iterable<T> | AsyncIterable<T>,
	batchSize: number,
	callback: C,
	abortSignal?: AbortSignal
): AsyncIterable<Awaited<ReturnType<C>>> {
	const iterator =
		Symbol.asyncIterator in collection ? collection[Symbol.asyncIterator]() : collection[Symbol.iterator]()

	const runningTasks = new Map<T, Promise<unknown>>()
	const results = new Map<T, ReturnType<C>>()

	let iterationResult = await iterator.next()

	// oxlint-disable-next-line no-unmodified-loop-condition
	while ((!iterationResult.done || results.size) && !abortSignal?.aborted) {
		for (const [key, result] of results) {
			yield result

			results.delete(key)
		}

		if (runningTasks.size >= batchSize) {
			await Promise.race(runningTasks.values())

			continue
		}

		if (iterationResult.done) {
			await Promise.all(runningTasks.values())

			break
		}

		const entry = iterationResult.value

		const futureResult = callback(entry).then((result) => {
			runningTasks.delete(entry)

			results.set(entry, result as ReturnType<C>)

			return void 0
		})

		runningTasks.set(entry, futureResult)

		iterationResult = await iterator.next()
	}

	if (!abortSignal || !abortSignal.aborted) {
		await Promise.all(runningTasks.values())

		for (const [key, result] of results) {
			yield result

			results.delete(key)
		}
	}
}

/**
 * Given an iterable, returns an array of arrays of the specified size.
 *
 * This is useful for batching asynchronous operations.
 *
 * @param collection The collection to batch.
 * @param batchSize The size of each batch.
 *
 * @returns An iterable of arrays of the specified size.
 * @see {@linkcode takeAsync} for the asynchronous version.
 */
export function* take<T>(collection: Iterable<T>, batchSize: number): Iterable<T[]> {
	const batch: T[] = []

	for (const item of collection) {
		batch.push(item)

		if (batch.length === batchSize) {
			yield batch

			batch.length = 0
		}
	}

	if (batch.length) {
		yield batch
	}
}

/**
 * Given an async iterable collection, returns an async iterable, yielding batches of items.
 *
 * This is useful for emitting asynchronous items in batches, such as when processing a stream of data.
 *
 * @param collection The async iterable collection to batch.
 * @param batchSize The size of each batch.
 *
 * @yields Each batch of items.
 * @see {@linkcode take} for the synchronous version.
 */
export async function* takeAsync<T>(collection: AsyncIterable<T>, batchSize: number): AsyncIterable<T[]> {
	let buffer: T[] = []

	for await (const item of collection) {
		buffer.push(item)

		if (buffer.length === batchSize) {
			yield buffer

			buffer = []
		}
	}

	if (buffer.length) {
		yield buffer
	}
}
