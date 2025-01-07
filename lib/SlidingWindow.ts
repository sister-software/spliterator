/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { CharacterSequence, CharacterSequenceInput } from "./CharacterSequence.js"
import { applyReaderPolyfill, ByteRange, ByteRangeReader, FileResourceLike, TypedArray } from "./shared.js"

export interface SlidingWindowInit {
	/**
	 * The delimiter to use. Defaults to a line feed.
	 */
	delimiter?: CharacterSequenceInput

	/**
	 * The byte index to start searching from.
	 */
	position?: number

	/**
	 * The byte index to stop searching at.
	 */
	byteLength?: number
}

/**
 * A sliding window that iterates over an in-memory buffer, yielding byte ranges.
 *
 * @see {@link AsyncSlidingWindow} for an asynchronous version.
 */
export class SlidingWindow<T extends TypedArray> implements IterableIterator<ByteRange> {
	buffer: T
	#delimiter: CharacterSequence
	#byteLength: number
	#done = false

	/**
	 * The current byte index of the sliding window.
	 */
	cursor: number

	/**
	 * Given a byte array containing delimited data, yield a sliding window of indexes.
	 *
	 * This a low-level utility function that can be used to implement more complex parsing logic.
	 */
	constructor(
		/**
		 * The buffer containing delimited data.
		 */
		buffer: T,
		init: SlidingWindowInit = {}
	) {
		this.buffer = buffer
		this.#delimiter = new CharacterSequence(init.delimiter)
		this.cursor = init.position ?? 0
		this.#byteLength = Math.min(init.byteLength ?? buffer.byteLength, buffer.byteLength)
	}

	public next(): IteratorResult<ByteRange> {
		for (let end = this.cursor; end < this.#byteLength; end++) {
			// We walk through as many bytes as the delimiter has...
			const match = this.#delimiter.every((byte, i) => byte === this.buffer[end + i])

			// We didn't find a match, so we continue.
			if (!match) continue

			const range: ByteRange = [this.cursor, end]

			this.cursor = end + this.#delimiter.length

			return { value: range, done: false }
		}

		if (this.cursor <= this.#byteLength && !this.#done) {
			const range: ByteRange = [this.cursor, this.#byteLength]

			this.cursor = this.#byteLength
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
	#file: FileResourceLike & ByteRangeReader
	#delimiter: CharacterSequence
	#byteLength: number
	#done = false
	#autoClose: boolean

	/**
	 * The current byte index of the sliding window.
	 */
	cursor: number

	/**
	 * Given a byte array containing delimited data, yield a sliding window of indexes.
	 *
	 * This a low-level utility function that can be used to implement more complex parsing logic.
	 */
	constructor(file: FileResourceLike, init: AsyncSlidingWindowInit) {
		applyReaderPolyfill(file)

		this.#file = file
		this.#byteLength = init.byteLength ?? Infinity
		this.#delimiter = new CharacterSequence(init.delimiter)
		this.cursor = init.position ?? 0
		this.#autoClose = init.autoClose ?? false
	}

	/**
	 * Read the next byte range from the file handle.
	 */
	public async next(): Promise<IteratorResult<ByteRange>> {
		const lookahead = this.#delimiter.length

		for (let end = this.cursor; end < this.#byteLength; end++) {
			const byteSlice = await this.#file.read({
				position: end,
				// lenegth: end + lookahead
			})

			const match = byteSlice.every((byte, i) => byte === this.#delimiter[i])

			if (!match) continue

			const range: ByteRange = [this.cursor, end]

			this.cursor = end + lookahead

			return { value: range, done: false }
		}

		// Handle the final window if we haven't reached the byte limit
		// and there's remaining content after the last delimiter
		if (this.cursor <= this.#byteLength && !this.#done) {
			const range: ByteRange = [this.cursor, this.#byteLength]

			this.cursor = this.#byteLength
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

		for (let start = this.cursor; start > 0; start--) {
			const byteSlice = await this.#file.read({ position: start - lookahead, length: start })

			const match = byteSlice.every((byte, i) => byte === this.#delimiter[i])

			if (!match) continue

			const range: ByteRange = [start - lookahead, this.cursor]

			this.cursor = start - lookahead

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
			await this.#file[Symbol.asyncDispose]?.()
		}
	}

	public dispose(): Promise<void> {
		return this[Symbol.asyncDispose]()
	}

	public [Symbol.asyncIterator](): AsyncIterableIterator<ByteRange> {
		return this
	}
}
