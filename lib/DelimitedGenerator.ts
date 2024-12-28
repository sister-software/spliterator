/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Delimiter, DelimiterInput } from "./delmiter.js"
import { AsyncDataResource, FileResourceLike, isFileResourceLike, TypedArray } from "./shared.js"
import { SlidingWindow } from "./SlidingWindow.js"

/**
 * Options for the delimited iterator.
 */
export interface DelimitedGeneratorInit {
	/**
	 * The character to delimit by. Typically a newline or comma.
	 */
	delimiter?: DelimiterInput

	/**
	 * The byte offset to start reading from.
	 *
	 * This is an advanced option that is not typically used.
	 *
	 * @default 0
	 */
	position?: number

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
	 * The maximum number of data slices to yield.
	 *
	 * Useful for limiting the number of emitted slices, i.e. lines in a file.
	 *
	 * Note that skipped slices are not counted towards the limit.
	 *
	 * @default Infinity
	 */
	take?: number

	/**
	 * An `AbortSignal` to cancel the read operation.
	 */
	signal?: AbortSignal
}

export interface AsyncDelimitedGeneratorInit extends DelimitedGeneratorInit {
	/**
	 * The total number of bytes to be buffered between reads.
	 *
	 * Typically, this is a multiple of the source's block size or a power of 2.
	 *
	 * @default BlockSize * 16
	 * @minimum The delimiter byte length * 4 or block size of the file system. Whichever is greater.
	 * @maximum The byte length of the file.
	 */
	highWaterMark?: number

	/**
	 * Whether to close the file handle after completion.
	 *
	 * @default true
	 */
	autoClose?: boolean
}

/**
 * A static class for iterator of async delimited data.
 */
export abstract class DelimitedGenerator {
	constructor() {
		throw new TypeError("Static class cannot be instantiated. Did you mean `DelimitedGenerator.from`?")
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
		{ take = Infinity, skipEmpty = true, drop = 0, position = 0, signal, ...options }: DelimitedGeneratorInit = {}
	): Generator<T extends string ? Uint8Array : T> {
		const haystack = (typeof source === "string" ? new TextEncoder().encode(source) : source) as
			| Exclude<T, string>
			| Uint8Array

		if (position > haystack.length) return

		const delimiter = Delimiter.from(options.delimiter ?? Delimiter.LineFeed)
		let taken = 0
		const fallbackEmpty = new Uint8Array(0) as T extends string ? Uint8Array : T

		if (take === 0) return

		const slidingWindow = new SlidingWindow(haystack, { delimiter, position })

		for (const [start, end] of slidingWindow) {
			if (start === end) {
				if (skipEmpty) continue

				yield fallbackEmpty

				taken++

				continue
			}

			const slice = haystack.subarray(start, end)

			if (skipEmpty) {
				if (slice.length === 0) continue

				if (slice.length === delimiter.length && slice.every((byte, i) => byte === delimiter[i])) {
					continue
				}
			}

			taken++
			if (taken < drop) continue

			yield slice as T extends string ? Uint8Array : T

			taken++

			if (signal?.aborted) break

			if (taken === take) break
		}
	}

	/**
	 * Given a file handle containing delimited data, yield a slice of the buffer between delimiters.
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
		{ take = Infinity, skipEmpty = true, drop = 0, signal, ...init }: Partial<AsyncDelimitedGeneratorInit> = {}
	): AsyncGenerator<T, any, unknown> {
		// Anything to take?
		if (take === 0) return

		let fileHandle: FileResourceLike

		if (isFileResourceLike(source)) {
			fileHandle = source
		} else {
			const { NodeFileResource } = await import("@sister.software/ribbon/node/fs")
			fileHandle = await NodeFileResource.open(source)
		}

		const byteLength = fileHandle.size
		const delimiter = Delimiter.from(init.delimiter ?? Delimiter.LineFeed)

		const findDelimiterStartIndex = (buffer: Uint8Array, searchStart: number) => {
			for (let i = searchStart; i < buffer.length; i++) {
				if (buffer[i] === delimiter[0]) return i
			}

			return -1
		}

		const blockSize = 4096
		const highWaterMark = init.highWaterMark ?? blockSize * 16

		// The cursor is where we are in the file.
		let cursor = init.position ?? 0
		const autoClose = init.autoClose ?? false
		let buffers = new Uint8Array(0)

		let taken = 0

		// Our task is similar to the synchronous version, but we can't use SlidingWindow.
		// We need to read from the file handle in chunks and look for the delimiter.
		// 1. Fill our buffer up to the high water mark.
		// 2. Read from the buffer one byte at time, looking for the delimiter.
		// 3. If we find the delimiter, yield a subarray starting from our last delimiter to the current position.
		// 4. If we reach the end of the buffer before the end of the file, read another chunk and concatenate it with the previous buffer. Continue from step 2 until we reach the end of the file.
		// 5. If we reach the end of the file without finding the delimiter, yield the remaining buffer.

		while (cursor < byteLength) {
			// Abort signal check
			if (signal?.aborted) {
				throw new Error("Operation aborted")
			}

			// Read the next chunk into the buffer
			const readSize = Math.min(highWaterMark, byteLength - cursor)
			// const chunk = new Uint8Array(readSize)

			// await fileHandle.read({ buffer: chunk, position: cursor, length: readSize })
			const chunk = await fileHandle.slice(cursor, cursor + readSize).bytes()
			// await fs.read(fileHandle, cursor, readSize, chunk)
			const bytesRead = chunk.byteLength

			cursor += bytesRead

			// Append the new chunk to the buffer
			const combinedBuffer = new Uint8Array(buffers.length + bytesRead)
			combinedBuffer.set(buffers)
			combinedBuffer.set(chunk.subarray(0, bytesRead), buffers.length)
			buffers = combinedBuffer

			// Look for delimiters within the buffer
			let delimiterIndex = 0
			let start = 0

			while ((delimiterIndex = findDelimiterStartIndex(buffers, start)) !== -1) {
				delimiterIndex += start

				// Check if the full delimiter matches
				if (
					buffers.subarray(delimiterIndex, delimiterIndex + delimiter.length).every((byte, i) => byte === delimiter[i])
				) {
					const slice = buffers.subarray(0, delimiterIndex)
					buffers = buffers.subarray(delimiterIndex + delimiter.length)

					// Skip empty slices if needed
					if (skipEmpty && slice.length === 0) {
						start = 0
						continue
					}

					// Drop slices if required
					if (taken < drop) {
						taken++
						start = 0
						continue
					}

					// Yield the slice
					console.debug(">>>", new TextDecoder().decode(slice))
					yield slice as T

					taken++
					if (taken === take) return

					start = 0
				} else {
					// If not a complete delimiter, continue searching
					start = delimiterIndex + 1
				}
			}
		}

		// Yield the remaining buffer
		if (buffers.length > 0 && !skipEmpty) {
			console.log("Final >>>", new TextDecoder().decode(buffers))
			yield buffers as T
		}

		// Auto-close the file handle if needed
		// if (autoClose) {
		// 	fileHandle.
		// 	await fileHandle.close()
		// }
	}
}
