/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

// eslint-disable-next-line no-restricted-imports
import { type Stats } from "node:fs"
// eslint-disable-next-line no-restricted-imports
import type { FileHandle } from "node:fs/promises"

/**
 * A trimmed-down version of the Node.js `Stats` interface.
 */
export type StatsLike = Pick<Stats, "size" | "blksize" | "mtimeMs">

/**
 * A trimmed-down version of the Node.js `FileHandle` interface.
 */
export type FileHandleLike = Pick<
	FileHandle,
	"fd" | "stat" | "close" | "read" | "readableWebStream" | "createReadStream"
>

/**
 * A tuple representing a window of bytes in a buffer.
 */
export type ByteRange = [
	/**
	 * The starting byte index of the window.
	 */
	start: number,
	/**
	 * The ending byte index of the window.
	 */
	end: number,
]

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

/**
 * Type-helper to determine the destination type for a typed array.
 *
 * This is useful to infer the ultimate return type of a function which optionally accepts a typed
 * array destination.
 */
export type TypedArrayFallback<T> = T extends TypedArray ? T : Uint8Array

/**
 * Options for reading a range of bytes from a source.
 */
export interface ReadBytesOptions {
	/**
	 * The offset from where to begin writing to the buffer.
	 *
	 * This is useful when reading multiple buffers into a single buffer.
	 *
	 * @default 0
	 */
	offset?: number

	/**
	 * How many bytes to read.
	 *
	 * @default `length of buffer`
	 */
	length?: number

	/**
	 * From where to start reading.
	 */
	position?: number
}

/**
 * A trait for reading a range of bytes from a source.
 *
 * While possible with a variety of platform-specific APIs, this trait provides a common interface
 * for reading byte ranges.
 */
export interface ByteRangeReader extends AsyncIterator<Uint8Array> {
	/**
	 * Reads a range of bytes from a source.
	 */
	read(options?: ReadBytesOptions): Promise<Uint8Array>
	read<B extends TypedArray>(options: ReadBytesOptions & { buffer: B }): Promise<B>
}

/**
 * An isomorphic file resource which can be read from and disposed.
 *
 * Generally, this interface aligns with the `File` interface in the browser.
 */
export interface FileResourceLike extends File {
	/**
	 * Read the entire file as a byte array.
	 */
	bytes(): Promise<Uint8Array>

	/**
	 * Slice the file into a new file resource.
	 *
	 * @param start - The byte offset to start the slice.
	 * @param end - The byte offset to end the slice.
	 */
	slice(start: number, end: number): FileResourceLike

	/**
	 * The block size of the file, if known.
	 */
	blockSize?: number

	[Symbol.asyncDispose]?(): PromiseLike<void>
}

/**
 * Type-predicate to determine if a value is a file resource.
 */
export function isFileResourceLike(input: unknown): input is FileResourceLike {
	return Boolean(input && typeof input === "object" && "slice" in input)
}

/**
 * Given a file resource, adds a `read` method to read a range of bytes.
 *
 * This allows the web `File` interface to be used as a byte range reader.
 */
export function applyReaderPolyfill<T extends FileResourceLike>(file: T): asserts file is T & ByteRangeReader {
	if ("read" in file && typeof file.read === "function") {
		return
	}

	Object.assign(file, {
		async read<B extends TypedArray>(options: ReadBytesOptions & { buffer?: B } = {}): Promise<TypedArrayFallback<B>> {
			const { position: start = 0, length = file.size, offset = 0 } = options
			const windowed = file.slice(start, start + length)

			const bytes = (await windowed.bytes()) as TypedArrayFallback<B>

			if (options.buffer) {
				const destination = options.buffer as TypedArrayFallback<B>
				destination.set(bytes as any, offset)

				return destination
			}

			return bytes
		},
	})
}

/**
 * An asynchronous iterable byte stream.
 *
 * Note that as an iterable this will drained of all bytes when iterated over.
 */
export interface AsyncChunkIterator extends AsyncIterable<Uint8Array> {
	/**
	 * Disposes of the byte stream, releasing any resources.
	 *
	 * This method is optional and may not be implemented by all byte streams.
	 */
	[Symbol.asyncDispose]?(): PromiseLike<void>
}

/**
 * An asynchronous resource to a delimited byte stream, which can be a...
 *
 * - `string` representing a file path.
 * - {@linkcode URL} object representing a file path.
 * - {@linkcode FileHandleLike} object representing an open file handle.
 * - {@linkcode AsyncChunkIterator} object representing an asynchronous byte stream.
 */
export type AsyncDataResource = string | URL | FileHandleLike

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
