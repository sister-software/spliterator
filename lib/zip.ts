/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

export type Zipped<T, U> = [a: T | undefined, b: U | undefined, idx: number]

export type ZippedEntries<Z> = Z extends Zipped<infer T, infer U> ? [T, U] : never

export function zippedEntries<T, U>(zipped: Zipped<T, U>): ZippedEntries<Zipped<T, U>> {
	return zipped.slice(0, 2) as ZippedEntries<Zipped<T, U>>
}

/**
 * Given two iterables, zip them together into a single iterable which yields pairs of elements.
 *
 * If one iterable is longer than the other, the shorter iterable will be padded with `undefined`.
 *
 * @param a The first iterable to zip.
 * @param b The second iterable to zip.
 *
 * @yields Pairs of elements from the two iterables.
 * @see {@linkcode zipAsync} for the asynchronous version.
 */
export function* zipSync<T, U>(a: Iterable<T>, b: Iterable<U>): Generator<Zipped<T, U>> {
	const aIterator = a[Symbol.iterator]()
	const bIterator = b[Symbol.iterator]()

	let index = 0

	while (true) {
		const { done: aDone, value: aValue } = aIterator.next()
		const { done: bDone, value: bValue } = bIterator.next()

		if (aDone && bDone) {
			break
		}

		yield [aValue, bValue, index]

		index++
	}
}

/**
 * Given two iterables, zip them together into a single iterable which yields pairs of elements.
 *
 * If one iterable is longer than the other, the shorter iterable will be padded with `undefined`.
 *
 * @param a The first iterable to zip.
 * @param b The second iterable to zip.
 *
 * @yields Pairs of elements from the two iterables.
 * @see {@linkcode zipSync} for the synchronous version.
 */
export async function* zipAsync<T, U>(
	a: AsyncIterable<T> | Iterable<T>,
	b: AsyncIterable<U> | Iterable<U>
): AsyncGenerator<[a: T | undefined, b: U | undefined, idx: number]> {
	const aIterator = Symbol.asyncIterator in a ? a[Symbol.asyncIterator]() : a[Symbol.iterator]()
	const bIterator = Symbol.asyncIterator in b ? b[Symbol.asyncIterator]() : b[Symbol.iterator]()

	let index = 0

	while (true) {
		const { done: aDone, value: aValue } = await aIterator.next()
		const { done: bDone, value: bValue } = await bIterator.next()

		if (aDone && bDone) {
			break
		}

		yield [aValue, bValue, index]

		index++
	}
}
