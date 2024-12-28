/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

// eslint-disable-next-line no-restricted-imports
import type { Stats } from "node:fs"
// eslint-disable-next-line no-restricted-imports
import type { FileHandle } from "node:fs/promises"

/**
 * A trimmed-down version of the Node.js `Stats` interface.
 */
export type StatsLike = Pick<Stats, "size" | "blksize" | "mtimeMs">

/**
 * A trimmed-down version of the Node.js `FileHandle` interface.
 */
export type FileHandleLike = Pick<FileHandle, "fd" | "stat" | "close" | "read" | "readableWebStream">

/**
 * Typed arrays that may be used as sources for byte streams.
 */
export type TypedArray =
	| Uint8Array
	| Uint8ClampedArray
	| Uint16Array
	| Uint32Array
	| Int8Array
	| Int16Array
	| Int32Array
	| BigUint64Array
	| BigInt64Array
	| Float32Array
	| Float64Array

/**
 * A source of bytes that can be read from.
 */
export type ReadableSource = FileHandleLike | TypedArray

/**
 * Type-predicate to determine if a value is a file handle.
 */
export function isFileHandleLike(input: unknown): input is FileHandleLike {
	return Boolean(input && typeof input === "object" && "fd" in input)
}

export interface FileResourceLike extends File {
	bytes(): Promise<Uint8Array>

	slice(start: number, end: number): FileResourceLike

	[Symbol.asyncDispose]?(): PromiseLike<void>
}

/**
 * Type-predicate to determine if a value is a file resource.
 */
export function isFileResourceLike(input: unknown): input is FileResourceLike {
	return Boolean(input && typeof input === "object" && "slice" in input)
}

/**
 * An asynchronous resource to a delimited byte stream, which can be a...
 *
 * - `string` representing a file path.
 * - `URL` object representing a file path.
 * - `Buffer` containing the file contents.
 * - `TypedArray` containing the file contents.
 * - `FileHandleLike` object representing an open file handle.
 */
export type AsyncDataResource = string | URL | FileHandleLike | FileResourceLike

/**
 * A resource to a delimited byte stream, i.e., a file buffer, handle, or path.
 *
 * @see {@link AsyncDataResource} : File paths, URLs, and handles.
 * @see {@link TypedArray} : Buffers and typed arrays.
 */
export type DataResource = AsyncDataResource | TypedArray

/**
 * A trimmed-down version of the text decoder interface.
 */
export interface TextDecoderLike {
	decode(input: Uint8Array): string
}

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
