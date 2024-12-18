/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Utilities for working with newline-delimited files.
 */

import { read } from "node:fs"
import { open } from "node:fs/promises"
import { ReadableStream, ReadableStreamController } from "node:stream/web"
import { Delimiter, DelimiterInput } from "./delmiter.js"
import {
	AsynchronousDataResource as AsyncDataResource,
	FileHandleLike,
	isFileHandleLike,
	TextDecoderLike,
	TypedArray,
} from "./shared.js"

//#region Common

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
export interface DelimitedIteratorOptions {
	/**
	 * The character to use for newlines. Defaults to the system's newline character.
	 */
	delimiter?: DelimiterInput

	/**
	 * The `TextDecoder`-like object to use for decoding incoming data.
	 *
	 * This is not set by default, beec
	 */
	decoder?: TextDecoderLike

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

	/**
	 * Whether to close the file handle after completion.
	 *
	 * @default true
	 */
	closeFileHandle?: boolean
}

//#endregion

//#region Delimited Synchronous

/**
 * A static class for iterator of async delimited data.
 */
export class DelimitedIterator {
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
	static *from<T extends TypedArray>(
		/**
		 * The buffer containing newline-delimited data.
		 */
		haystack: T,
		{ limit = Infinity, skipEmpty = true, drop = 0, byteOffset = 0, signal, ...options }: DelimitedIteratorOptions = {}
	): Generator<T> {
		const delimiter = Delimiter.from(options.delimiter ?? Delimiter.LineFeed)
		let emittedCount = 0

		if (byteOffset > haystack.length) {
			return
		}

		if (limit === 0) {
			return
		}

		const windowIterator = DelimitedIterator.slidingWindow(haystack, delimiter, byteOffset, haystack.length)

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
}

//#endregion

//#region Delimited Asynchronous

/**
 * Given a file handle and a range of bytes, read the range into a buffer.
 *
 * @param fileHandle The file handle to read from.
 * @param position The initial byte position to start reading from.
 * @param end The ending byte index.
 * @param destination A buffer to write the data to. If not provided, a new buffer will be created.
 */
export function readRange<Destination extends TypedArray = Uint8Array>(
	fileHandle: FileHandleLike,
	position: number,
	end: number,
	destination?: Destination
): Promise<Destination> {
	const length = end - position

	if (length <= 0) {
		throw new Error(`Invalid range length ${length}. Start: ${position}, End: ${end}`)
	}

	destination ||= new Uint8Array(length) as Destination

	return new Promise((resolve, reject) => {
		read(
			// ---
			fileHandle.fd,
			destination,
			0,
			length,
			position,
			(error) => {
				if (error) {
					reject(error)
				} else {
					resolve(destination)
				}
			}
		)
	})
}

/**
 * A static class for iterator of async delimited data.
 */
export class AsyncDelimitedIterator {
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
	static async *slidingWindow<T extends AsyncDataResource>(
		haystack: T,
		needle: DelimiterInput = Delimiter.LineFeed,
		offset = 0,
		byteLimit: number = Infinity
	): AsyncGenerator<DelimitedWindow> {
		const fileHandle = isFileHandleLike(haystack) ? haystack : await open(haystack)
		const stats = await fileHandle.stat()

		byteLimit = Math.min(byteLimit, stats.size)

		const delimiter = Delimiter.from(needle)
		let cursor = offset

		while (offset < byteLimit) {
			const buffer = await readRange(fileHandle, offset, offset + delimiter.length)

			let i = 0

			for (i = 0; i < delimiter.length; i++) {
				if (buffer[i] !== delimiter[i]) {
					break
				}
			}

			if (i !== delimiter.length) {
				offset++

				continue
			}

			yield [cursor, offset]

			offset += delimiter.length
			cursor = offset
		}
	}

	/**
	 * Given a byte array containing delimited data, yield a slice of the buffer between delimiters.
	 *
	 * This a low-level utility function that can be used to implement more complex parsing logic.
	 *
	 * @yields Each slice of the buffer separated by a delimiter.
	 */
	static async *from<T extends TypedArray = Uint8Array>(
		/**
		 * The buffer containing newline-delimited data.
		 */
		haystack: AsyncDataResource,
		{ limit = Infinity, skipEmpty = true, drop = 0, byteOffset = 0, signal, ...options }: DelimitedIteratorOptions = {}
	): AsyncGenerator<T> {
		const fileHandle = isFileHandleLike(haystack) ? haystack : await open(haystack)
		const stats = await fileHandle.stat()

		byteOffset = Math.min(byteOffset, stats.size)

		const delimiter = Delimiter.from(options.delimiter ?? Delimiter.LineFeed)
		let emittedCount = 0

		if (limit === 0) {
			return
		}

		const windowIterator = AsyncDelimitedIterator.slidingWindow(haystack, delimiter, byteOffset, Infinity)

		for await (const [start, end] of windowIterator) {
			if (start === end) {
				if (skipEmpty) continue

				yield new Uint8Array(0) as T

				emittedCount++

				continue
			}

			const slice = await readRange(fileHandle, start, end)

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
}

//#endregion

//#region LineReader

/**
 * A reader for newline-delimited files.
 *
 * ```js
 * const reader = new LineReader("example.csv")
 *
 * for await (const line of reader) {
 *   console.log(line.toString())
 * }
 * ```
 */
export class LineReader<T extends TypedArray = Uint8Array> extends ReadableStream<T> implements AsyncDisposable {
	/**
	 * Create a new `LineReader` instance.
	 */
	constructor(
		/**
		 * The path to the CSV, NDJSON, or other newline-delimited file.
		 */
		source: TypedArray | AsyncDataResource,
		/**
		 * Options for the reader.
		 */
		options: DelimitedIteratorOptions = {}
	) {
		const { skipEmpty = true } = options
		let generator: Generator<T, T, T> | AsyncGenerator<T, T, T>

		if (Array.isArray(source)) {
			generator = DelimitedIterator.from(source as unknown as T, options)
		} else {
			generator = AsyncDelimitedIterator.from(source as AsyncDataResource, options)
		}

		const pull = async (controller: ReadableStreamController<T>) => {
			const { value, done } = await generator.next()

			if (typeof value === "undefined") {
				if (!skipEmpty) {
					controller.enqueue(new Uint8Array(0) as T)
				}
			} else {
				controller.enqueue(value)
			}

			if (done) {
				controller.close()
			}
		}

		super({
			pull,
		})
	}

	public async [Symbol.asyncDispose](): Promise<void> {
		await this.cancel()
	}
}
