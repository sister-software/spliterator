/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Delimiter, DelimiterInput } from "./delmiter.js"
import { AsyncDataResource, FileSystemProvider, TypedArray } from "./shared.js"
import { AsyncSlidingWindow, SlidingWindow } from "./SlidingWindow.js"

/**
 * Options for the delimited iterator.
 */
export interface DelimitedGeneratorOptions {
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

	//#region Synchronous methods

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

		if (byteOffset > haystack.length) return

		const delimiter = Delimiter.from(options.delimiter ?? Delimiter.LineFeed)
		let emittedCount = 0
		const fallbackEmpty = new Uint8Array(0) as T extends string ? Uint8Array : T

		if (limit === 0) return

		const slidingWindow = new SlidingWindow(haystack, delimiter, byteOffset, haystack.length)

		for (const [start, end] of slidingWindow) {
			if (start === end) {
				if (skipEmpty) continue

				yield fallbackEmpty

				emittedCount++

				continue
			}

			const slice = haystack.subarray(start, end)

			if (skipEmpty) {
				if (slice.length === 0) continue

				if (slice.length === delimiter.length && slice.every((byte, i) => byte === delimiter[i])) {
					continue
				}
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
		if (limit === 0) return

		fs ||= await import("@sister.software/ribbon/node/fs")

		const fileHandle = await fs.open(source)
		const stats = await fileHandle.stat()
		const fallbackEmpty = new Uint8Array(0) as T

		const delimiter = Delimiter.from(options.delimiter ?? Delimiter.LineFeed)
		let emittedCount = 0

		const slidingWindow = new AsyncSlidingWindow(fileHandle, fs, delimiter, byteOffset, stats.size)

		for await (const [start, end] of slidingWindow) {
			if (start === end) {
				if (skipEmpty) continue

				yield fallbackEmpty

				emittedCount++

				continue
			}

			const slice = await fs.read(fileHandle, start, end)

			if (skipEmpty) {
				if (slice.length === delimiter.length && slice.every((byte, i) => byte === delimiter[i])) {
					continue
				}
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
