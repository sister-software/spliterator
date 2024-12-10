/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * A trimmed-down version of the Node.js `Stats` interface.
 */

export interface StatsLike {
	size: number
}

/**
 * A trimmed-down version of the Node.js `FileHandle` interface.
 */
export interface FileHandleLike extends AsyncDisposable {
	/**
	 * The file descriptor, typically an integer provided by the operating system.
	 */
	fd: number

	stat(): Promise<StatsLike>

	close(): Promise<void>
}

/**
 * Commonly used ASCII character codes for newline-delimited files.
 */
export enum Delimiter {
	/**
	 * Newline character – ␊
	 */
	LineFeed = 10,
	/**
	 * Carriage return character – ␍
	 */
	CarriageReturn = 13,
	/**
	 * Comma character – ,
	 */
	Comma = 44,
	/**
	 * Tab character – ␉
	 */
	Tab = 9,
	/**
	 * Space character – ␠
	 */
	Space = 32,
	/**
	 * One character – 1
	 */
	One = 49,
	/**
	 * Zero character – 0
	 */
	Zero = 48,
	/**
	 * Double quote character – "
	 */
	DoubleQuote = 34,
	/**
	 * Record separator character – ␞
	 */
	RecordSeparator = 30,
}

/**
 * Type-predicate to determine if a value is a file handle.
 */
export function isFileHandleLike(input: unknown): input is FileHandleLike {
	return Boolean(input && typeof input === "object" && "fd" in input)
}

/**
 * Given two iterables, zip them together into a single iterable which yields pairs of elements.
 *
 * If one iterable is longer than the other, the shorter iterable will be padded with `undefined`.
 *
 * @param a The first iterable to zip.
 * @param b The second iterable to zip.
 * @yields Pairs of elements from the two iterables.
 * @see {@linkcode zipAsync} for the asynchronous version.
 */
export function* zipSync<T, U>(
	a: Iterable<T>,
	b: Iterable<U>
): Generator<[a: T | undefined, b: U | undefined, idx: number]> {
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
