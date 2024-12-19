/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Delimiter, DelimiterInput } from "./delmiter.js"
import { AsyncDataResource, FileHandleLike, FileSystemProvider, TypedArray } from "./shared.js"

/**
 * A tuple representing a window of bytes in a buffer.
 */
export type DelimitedWindow = [
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
 * Options for the delimited iterator.
 */
export interface DelimitedGeneratorOptions {
	/**
	 * The character to use for newlines.
	 */
	delimiter?: DelimiterInput

	/**
	 * The byte offset to start reading from.
	 *
	 * This is an advanced option that is not typically used.
	 *
	 * @default 0
	 */
	byteOffset?: number

	/**
	 * Whether to emit repeated delimiters as empty buffers.
	 *
	 * Setting this to `false` matches the behavior of `String.prototype.split`.
	 *
	 * @default true
	 */
	skipEmpty?: boolean

	/**
	 * Count of skipped matches before emitting a data.
	 *
	 * @default 0
	 */
	drop?: number

	/**
	 * The maximum number of data slices to yield. Useful for limiting the number of lines read from a
	 * file.
	 *
	 * Note that skipped slices are not counted towards the limit.
	 *
	 * @default Infinity
	 */
	limit?: number

	/**
	 * An `AbortSignal` to cancel the read operation.
	 */
	signal?: AbortSignal
}

export interface AsyncDelimitedGeneratorOptions extends DelimitedGeneratorOptions {
	/**
	 * A file system provider for reading data.
	 */
	fs?: FileSystemProvider
	/**
	 * Whether to close the file handle after completion.
	 *
	 * @default true
	 */
	closeFileHandle?: boolean
}

/**
 * A static class for iterator of async delimited data.
 */
export abstract class DelimitedGenerator {
	constructor() {
		throw new TypeError("Static class cannot be instantiated. Did you mean `DelimitedGenerator.from`?")
	}

	//#region Synchrnous methods

	/**
	 * Given a byte array containing delimited data, yield a sliding window of indexes.
	 *
	 * This a low-level utility function that can be used to implement more complex parsing logic.
	 *
	 * @param haystack The buffer containing newline-delimited data.
	 * @param needle The delimiter to use. Defaults to a line feed.
	 * @param offset The byte index to start searching from.
	 * @param byteLimit The byte index to stop searching at.
	 * @yields Each window of the buffer that contains a delimiter.
	 */
	static *slidingWindow<T extends TypedArray>(
		haystack: T,
		needle: DelimiterInput = Delimiter.LineFeed,
		offset = 0,
		byteLimit = haystack.length
	): Generator<DelimitedWindow> {
		// First, we normalize the delimiter into an array of bytes.
		const delimiter = Delimiter.from(needle)
		// Our cursor starts at the offset and increments every time we find a matching sub array.
		let cursor = offset

		while (offset < byteLimit) {
			let i = 0

			// We walk through as many bytes as the delimiter has...
			for (i = 0; i < delimiter.length; i++) {
				if (haystack[offset + i] !== delimiter[i]) {
					break // Character doesn't match the delimiter.
				}
			}

			if (i !== delimiter.length) {
				offset++

				continue // We didn't find a match, so we continue.
			}

			yield [cursor, offset]

			offset += delimiter.length
			cursor = offset
		}

		if (cursor <= byteLimit) {
			yield [cursor, byteLimit]
		}
	}

	/**
	 * Given a byte array containing delimited data, yield a slice of the buffer between delimiters.
	 *
	 * This a low-level utility function that can be used to implement more complex parsing logic.
	 *
	 * @yields Each slice of the buffer separated by a delimiter.
	 */
	static *from<T extends TypedArray | string>(
		/**
		 * The byte array or string containing delimited data.
		 */
		source: T,
		{ limit = Infinity, skipEmpty = true, drop = 0, byteOffset = 0, signal, ...options }: DelimitedGeneratorOptions = {}
	): Generator<T extends string ? Uint8Array : T> {
		const haystack = (typeof source === "string" ? new TextEncoder().encode(source) : source) as
			| Exclude<T, string>
			| Uint8Array
		const delimiter = Delimiter.from(options.delimiter ?? Delimiter.LineFeed)
		let emittedCount = 0

		if (byteOffset > haystack.length) {
			return
		}

		if (limit === 0) {
			return
		}

		const windowIterator = DelimitedGenerator.slidingWindow(haystack, delimiter, byteOffset, haystack.length)

		for (const [start, end] of windowIterator) {
			const slice = haystack.subarray(start, end)

			if (slice.length === 0 && skipEmpty) {
				continue
			} else if (
				slice.length === delimiter.length &&
				slice.every((_byte, i) => slice[i] === delimiter[i]) &&
				skipEmpty
			) {
				continue
			}

			if (emittedCount < drop) {
				emittedCount++
				continue
			}

			yield slice as T extends string ? Uint8Array : T

			emittedCount++

			if (signal?.aborted) {
				break
			}

			if (emittedCount === limit) {
				break
			}
		}
	}

	//#endregion

	//#region Asynchronous methods

	/**
	 * Given a byte array containing delimited data, yield a sliding window of indexes.
	 *
	 * This a low-level utility function that can be used to implement more complex parsing logic.
	 *
	 * @param fileHandle The file handle to read from.
	 * @param fs A file system provider for reading data.
	 * @param needle The delimiter to use. Defaults to a line feed.
	 * @param offset The byte index to start searching from.
	 * @param byteLimit The byte index to stop searching at.
	 * @yields Each window of the buffer that contains a delimiter.
	 */
	static async *slidingWindowAsync(
		fileHandle: FileHandleLike,
		fs: FileSystemProvider,
		needle: DelimiterInput = Delimiter.LineFeed,
		offset = 0,
		byteLimit: number = Infinity
	): AsyncGenerator<DelimitedWindow> {
		const delimiter = Delimiter.from(needle)
		let cursor = offset

		while (offset < byteLimit) {
			const range = await fs.read(fileHandle, offset, offset + delimiter.length)

			const match = range.every((byte, i) => byte === delimiter[i])

			if (!match) {
				offset++

				continue
			}

			yield [cursor, offset]

			offset += delimiter.length
			cursor = offset
		}

		if (cursor <= byteLimit) {
			yield [cursor, byteLimit]
		}
	}

	/**
	 * Given a byte array containing delimited data, yield a slice of the buffer between delimiters.
	 *
	 * This a low-level utility function that can be used to implement more complex parsing logic.
	 *
	 * @yields Each slice of the buffer separated by a delimiter.
	 */
	static async *fromAsync<T extends TypedArray = Uint8Array>(
		/**
		 * The buffer containing newline-delimited data.
		 */
		source: AsyncDataResource,
		{
			limit = Infinity,
			skipEmpty = true,
			drop = 0,
			byteOffset = 0,
			signal,
			fs,
			...options
		}: AsyncDelimitedGeneratorOptions = {}
	): AsyncGenerator<T, any, unknown> {
		fs ||= await import("@sister.software/ribbon/node/fs")

		const fileHandle = await fs.open(source)
		const stats = await fileHandle.stat()

		const delimiter = Delimiter.from(options.delimiter ?? Delimiter.LineFeed)
		let emittedCount = 0

		if (limit === 0) return

		const windowIterator = DelimitedGenerator.slidingWindowAsync(fileHandle, fs, delimiter, byteOffset, stats.size)

		for await (const [start, end] of windowIterator) {
			if (start === end) {
				if (skipEmpty) {
					continue
				}

				yield new Uint8Array(0) as T

				emittedCount++

				continue
			}

			const slice = await fs.read(fileHandle, start, end)

			if (slice.length === 0 && skipEmpty) {
				continue
			} else if (
				slice.length === delimiter.length &&
				slice.every((_byte, i) => slice[i] === delimiter[i]) &&
				skipEmpty
			) {
				continue
			}

			if (emittedCount < drop) {
				emittedCount++

				continue
			}

			yield slice as T

			emittedCount++

			if (signal?.aborted) {
				break
			}

			if (emittedCount === limit) {
				break
			}
		}
	}

	//#endregion
}
