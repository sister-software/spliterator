/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { AsyncSpliterator, AsyncSpliteratorInit, SpliteratorInit } from "./AsyncSpliterator.js"
import { CharacterSequence, CharacterSequenceInput, normalizeCharacterInput } from "./CharacterSequence.js"
import { IndexQueue } from "./IndexQueue.js"
import { type ByteRange } from "./shared.js"

export { AsyncSpliterator }

export type { AsyncSpliteratorInit, SpliteratorInit }

/**
 * A byte stream delimiting iterator.
 */
export class Spliterator implements IterableIterator<Uint8Array>, Disposable {
	//#region Lifecycle

	/**
	 * Create a spliterator from an asynchronous resource such as a file.
	 *
	 * This is an alias for `AsyncSpliterator.from`.
	 *
	 * @param source - The data resource to read from.
	 * @param init - The initialization options for the generator.
	 * @see {@linkcode AsyncSpliterator} for usage.
	 */
	static fromAsync = AsyncSpliterator.from

	/**
	 * Create a spliterator from an iterable resource such as a buffer, array, or string.
	 *
	 * @param source - The data resource to read from.
	 * @param init - The initialization options for the generator.
	 */
	static from<T extends CharacterSequenceInput>(source: T, init: SpliteratorInit = {}): Spliterator {
		return new Spliterator(normalizeCharacterInput(source), init)
	}

	/**
	 * Dispose of the spliterator, closing the file handle if necessary.
	 */
	public [Symbol.dispose](): void {
		this.#indices.clear()
	}

	constructor(source: Uint8Array, init: SpliteratorInit = {}) {
		this.#source = source

		this.#needle = new CharacterSequence(init.delimiter)

		this.#readPosition = init.position ?? 0

		this.#highWaterMark = Math.max(this.#needle.length * 4, 4096)

		this.#yieldDropCount = Math.max(0, init.drop ?? 0)
		this.#yieldStopCount = Math.max(init.take ?? Infinity, 0) + this.#yieldDropCount
		this.#yieldByteEstimate = this.#source.byteLength - this.#readPosition

		this.#skipEmpty = init.skipEmpty ?? true

		this.#debug = init.debug ?? false
		this.#log = this.#debug ? console.debug.bind(console) : () => void 0
	}

	//#endregion

	//#region Private Properties

	/**
	 * The byte source to read from.
	 */
	readonly #source: Uint8Array

	/**
	 * A queue of index tuples marking the start and end of delimiter positions.
	 *
	 * Note that indices are relative to the buffer, not the file.
	 *
	 * This means that the start index is always 0, and the end index is the byte length of the
	 * buffer.
	 */
	readonly #indices = new IndexQueue()

	/**
	 * The byte sequence to search for, i.e. an encoded delimiter.
	 */
	readonly #needle: CharacterSequence

	/**
	 * How many yields to skip.
	 */
	readonly #yieldDropCount: number

	/**
	 * How many yields to allow before stopping.
	 */
	readonly #yieldStopCount: number

	/**
	 * The total number of bytes we expect to yield.
	 *
	 * We use this to ensure that we don't miss any data as we read through the buffer.
	 */
	readonly #yieldByteEstimate: number

	/**
	 * Whether to skip empty yields.
	 */
	readonly #skipEmpty: boolean

	/**
	 * The high water mark for the buffer.
	 *
	 * This defines the total size of indices to keep in memory.
	 */
	readonly #highWaterMark: number

	/**
	 * The total number of bytes we've yielded.
	 */
	#yieldedByteLength = 0

	/**
	 * The total number of yields.
	 */
	#yieldCount = 0

	/**
	 * The current byte index to perform read operations from.
	 */
	#readPosition: number

	/**
	 * The last byte range seen while draining the buffer.
	 */
	#lastByteRangeSeen: ByteRange | undefined

	/**
	 * Whether to output debug information.
	 */
	#debug: boolean

	/**
	 * Whether the iterator is done.
	 */
	#done = false

	//#endregion

	//#region Private Methods

	#log: (...args: any[]) => void

	#finalize(): IteratorReturnResult<undefined> {
		if (this.#debug) {
			/**
			 * The total number of bytes we expect to be omitted from the buffer. This is derived from the
			 * number of of yields and the length of the delimiter.
			 */
			const expectedYieldedDelimitedBytes = (this.#yieldCount - 1) * this.#needle.length
			const omittedBytes = this.#yieldByteEstimate - (this.#yieldedByteLength + expectedYieldedDelimitedBytes)

			this.#log({
				totalByteSize: this.#source.byteLength,
				readPosition: this.#readPosition,
				yieldByteEstimate: this.#yieldByteEstimate,
				yieldedByteLength: this.#yieldedByteLength,
				yieldCount: this.#yieldCount,
				expectedYieldedDelimitedBytes,
				omittedBytes,
			})
		}

		return {
			done: true,
			value: undefined,
		}
	}

	/**
	 * Fill the buffer with data and search for delimiters.
	 */
	#fill(): void {
		const sourceByteLength = this.#source.byteLength

		if (this.#readPosition === sourceByteLength) {
			this.#log("Reached end of file. Preparing to finalize.")

			// There's a few special cases we could get this far and not have drained the buffer.
			const lastByteRange = this.#lastByteRangeSeen

			if (lastByteRange) {
				const lastByteIndex = lastByteRange[1]

				// There's a special case where the last delimiter is at the end of the *file*.

				if (lastByteIndex < sourceByteLength) {
					// We need to determine if we're at the end of the *file* and there's no delimiter.
					const possibleDelimiterIndex = this.#needle.search(this.#source, sourceByteLength - this.#needle.length)

					if (possibleDelimiterIndex !== -1) {
						this.#log("Inserted byte range at the last delimiter", [possibleDelimiterIndex, sourceByteLength])
						// We found a delimiter at the end of the file, so we enqueue the byte range.
						this.#indices.enqueue([possibleDelimiterIndex + this.#needle.length, sourceByteLength])
					} else {
						this.#log("Inserted byte range at the last byte", [lastByteIndex, sourceByteLength])
						// The file didn't end with a delimiter, so we just enqueue the last byte range.
						this.#indices.enqueue([lastByteIndex + this.#needle.length, sourceByteLength])
					}
				} else {
					this.#log(
						`Weird situation. We're at the end of the file, but the last byte range ${lastByteIndex} is greater than the buffer length ${sourceByteLength}.`
					)
				}
			} else if (this.#yieldCount === 0) {
				// We didn't find any delimiters in the file, so we just enqueue the whole buffer.
				this.#indices.enqueue([0, sourceByteLength])
			}

			this.#done = true

			return
		}

		while (this.#readPosition < sourceByteLength && this.#indices.byteLength < this.#highWaterMark) {
			// Unlike the async version, we can keep reading until our indices match the high water mark.
			const delimiterIndex = this.#needle.search(this.#source, this.#readPosition)

			if (delimiterIndex === -1) {
				this.#log(`No viable byte range found in buffer. Breaking.`)
				break
			}

			this.#log("Found byte range", [this.#readPosition, delimiterIndex])

			this.#indices.enqueue([this.#readPosition, delimiterIndex])

			this.#readPosition = delimiterIndex + this.#needle.length
		}
	}

	//#endregion

	//#region Iterator Methods

	/**
	 * Read the next byte range from the source.
	 */
	public next(): IteratorResult<Uint8Array> {
		if (this.#done || this.#yieldCount >= this.#yieldStopCount) return this.#finalize()

		if (this.#indices.size === 0) {
			this.#fill()
		}

		const currentByteRange = this.#indices.dequeue()!
		this.#lastByteRangeSeen = currentByteRange

		const [start, end] = currentByteRange

		const slice = this.#source.subarray(start, end)

		if (slice.length === 0 && this.#skipEmpty) {
			return this.next()
		}

		this.#yieldCount++

		if (this.#yieldCount <= this.#yieldDropCount) {
			return this.next()
		}

		this.#yieldedByteLength += end - start

		return {
			value: slice,
			done: false,
		}
	}

	/**
	 * Collect all the byte ranges from the file.
	 */
	public toArray(): Uint8Array[] {
		return Array.from(this)
	}

	/**
	 * Collect all the byte ranges from the file as a string.
	 */
	public toDecodedArray(decoder = new TextDecoder()): string[] {
		return Array.from(this, (bytes) => decoder.decode(bytes))
	}

	public [Symbol.iterator](): IterableIterator<Uint8Array> {
		return this
	}
}
