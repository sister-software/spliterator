/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Delimiter, DelimiterBytes, DelimiterInput } from "./delmiter.js"
import { FileHandleLike, FileSystemProvider, TypedArray } from "./shared.js"

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

export interface SlidingWindowInit {
	/**
	 * The delimiter to use. Defaults to a line feed.
	 */
	delimiter?: DelimiterInput

	/**
	 * The byte index to start searching from.
	 */
	position?: number

	/**
	 * The byte index to stop searching at.
	 */
	limit?: number
}

/**
 * A sliding window that iterates over an in-memory buffer, yielding byte ranges.
 *
 * @see {@link AsyncSlidingWindow} for an asynchronous version.
 */
export class SlidingWindow<T extends TypedArray> implements IterableIterator<ByteRange> {
	source: T
	#delimiter: DelimiterBytes
	#limit: number
	#cursor: number
	#done = false

	/**
	 * The current byte index of the sliding window.
	 */
	public get cursor(): number {
		return this.#cursor
	}

	public set cursor(value: number) {
		this.#cursor = value
	}

	/**
	 * Given a byte array containing delimited data, yield a sliding window of indexes.
	 *
	 * This a low-level utility function that can be used to implement more complex parsing logic.
	 */
	constructor(
		/**
		 * The buffer containing delimited data.
		 */
		source: T,
		init: SlidingWindowInit = {}
	) {
		this.source = source
		this.#delimiter = Delimiter.from(init.delimiter ?? Delimiter.LineFeed)
		this.#cursor = init.position ?? 0
		this.#limit = Math.min(init.limit ?? source.length)
	}

	public next(): IteratorResult<ByteRange> {
		for (let end = this.#cursor; end < this.#limit; end++) {
			// We walk through as many bytes as the delimiter has...
			const match = this.#delimiter.every((byte, i) => byte === this.source[end + i])

			// We didn't find a match, so we continue.
			if (!match) continue

			const range: ByteRange = [this.#cursor, end]

			this.#cursor = end + this.#delimiter.length

			return { value: range, done: false }
		}

		if (this.#cursor <= this.#limit && !this.#done) {
			const range: ByteRange = [this.#cursor, this.#limit]

			this.#cursor = this.#limit
			this.#done = true

			return { value: range, done: false }
		}

		return {
			value: undefined,
			done: true,
		}
	}

	public [Symbol.iterator](): IterableIterator<ByteRange> {
		return this
	}
}

/**
 * Options for initializing an asynchronous sliding window.
 */
export interface AsyncSlidingWindowInit extends SlidingWindowInit {
	/**
	 * A file system provider for reading data.
	 */
	fs: FileSystemProvider

	/**
	 * Whether to close the file handle when the iterator is completed or disposed.
	 */
	autoClose?: boolean
}

/**
 * An asynchronous sliding window that iterates over a file handle, yielding byte ranges.
 *
 * @see {@link SlidingWindow} for a synchronous version.
 */
export class AsyncSlidingWindow implements AsyncIterableIterator<ByteRange>, AsyncDisposable {
	#fileHandle: FileHandleLike
	#fs: FileSystemProvider
	#delimiter: DelimiterBytes
	#limit: number
	#cursor: number
	#done = false
	#autoClose: boolean

	/**
	 * The current byte index of the sliding window.
	 */
	public get cursor(): number {
		return this.#cursor
	}

	public set cursor(value: number) {
		this.#cursor = value
	}

	/**
	 * Given a byte array containing delimited data, yield a sliding window of indexes.
	 *
	 * This a low-level utility function that can be used to implement more complex parsing logic.
	 */
	constructor(fileHandle: FileHandleLike, init: AsyncSlidingWindowInit) {
		this.#fileHandle = fileHandle
		this.#fs = init.fs
		this.#limit = init.limit ?? Infinity
		this.#delimiter = Delimiter.from(init.delimiter ?? Delimiter.LineFeed)
		this.#cursor = init.position ?? 0
		this.#autoClose = init.autoClose ?? false
	}

	/**
	 * Read the next byte range from the file handle.
	 */
	public async next(): Promise<IteratorResult<ByteRange>> {
		const lookahead = this.#delimiter.length

		for (let end = this.#cursor; end < this.#limit; end++) {
			const byteSlice = await this.#fs.read(this.#fileHandle, end, end + lookahead)

			const match = byteSlice.every((byte, i) => byte === this.#delimiter[i])

			if (!match) continue

			const range: ByteRange = [this.#cursor, end]

			this.#cursor = end + lookahead

			return { value: range, done: false }
		}

		// Handle the final window if we haven't reached the byte limit
		// and there's remaining content after the last delimiter
		if (this.#cursor <= this.#limit && !this.#done) {
			const range: ByteRange = [this.#cursor, this.#limit]

			this.#cursor = this.#limit
			this.#done = true

			return { value: range, done: false }
		}

		return {
			value: undefined,
			done: true,
		}
	}

	/**
	 * Read the previous byte range from the file handle.
	 *
	 * This is useful for backtracking in the event that a delimiter is split across two windows.
	 */
	public async previous(): Promise<IteratorResult<ByteRange>> {
		const lookahead = this.#delimiter.length

		for (let start = this.#cursor; start > 0; start--) {
			const byteSlice = await this.#fs.read(this.#fileHandle, start - lookahead, start)

			const match = byteSlice.every((byte, i) => byte === this.#delimiter[i])

			if (!match) continue

			const range: ByteRange = [start - lookahead, this.#cursor]

			this.#cursor = start - lookahead

			return { value: range, done: false }
		}

		return {
			value: undefined,
			done: true,
		}
	}

	/**
	 * Given a collection of sliding windows, iterate over them and coalesce adjacent windows.
	 *
	 * @yields Each coalesced window.
	 */
	static async *collect(slidingWindows: AsyncSlidingWindow[]): AsyncGenerator<ByteRange[]> {
		let results: IteratorResult<ByteRange>[]
		let done: boolean | undefined

		do {
			results = await Promise.all(
				slidingWindows.map((window) => {
					return window.next()
				})
			)

			const emitted: ByteRange[] = []

			for (const result of results) {
				done = result.done

				if (result.done) continue

				emitted.push(result.value)
			}

			yield emitted
		} while (!done)
	}

	public async [Symbol.asyncDispose](): Promise<void> {
		if (this.#autoClose) {
			await this.#fileHandle[Symbol.asyncDispose]?.()
		}
	}

	public dispose(): Promise<void> {
		return this[Symbol.asyncDispose]()
	}

	public [Symbol.asyncIterator](): AsyncIterableIterator<ByteRange> {
		return this
	}
}
