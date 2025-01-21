/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { CharacterSequence, CharacterSequenceInput } from "./CharacterSequence.js"
import { ByteRange, TypedArray } from "./shared.js"

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
