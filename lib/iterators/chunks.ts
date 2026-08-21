/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

/**
 * Group an iterable's values into arrays of `size`, with a shorter final batch if the collection does not divide
 * evenly.
 *
 * Distinct from `Iterator.prototype.take`, which yields the first `size` _values_. Named for the [iterator chunking
 * proposal](https://github.com/tc39/proposal-iterator-chunking).
 *
 * @param collection The collection to batch.
 * @param size The size of each batch.
 *
 * @yields Each batch of values.
 * @see {@linkcode AsyncSequence.chunks} for the asynchronous form.
 */
export function* chunks<T>(collection: Iterable<T>, size: number): Generator<T[]> {
	const normalized = Math.trunc(size)

	if (!Number.isFinite(normalized) || normalized < 1) {
		throw new RangeError(`chunks(${size}): size must be a positive finite number`)
	}

	let batch: T[] = []

	for (const item of collection) {
		batch.push(item)

		if (batch.length === normalized) {
			yield batch

			batch = []
		}
	}

	if (batch.length) {
		yield batch
	}
}
