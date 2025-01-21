/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { AsyncSpliterator, AsyncSpliteratorInit, SpliteratorInit } from "./AsyncSpliterator.js"
import {
	CharacterSequence,
	CharacterSequenceInput,
	debugAsVisibleCharacters,
	normalizeCharacterInput,
} from "./CharacterSequence.js"
import { IndexQueue } from "./IndexQueue.js"
import { AsyncChunkIterator, AsyncDataResource, isFileHandleLike, type ByteRange } from "./shared.js"

export { AsyncSpliterator }

export type { AsyncSpliteratorInit, SpliteratorInit }

/**
 * A byte stream delimiting iterator.
 */
export class Spliterator<R extends DataView | ArrayBuffer = Uint8Array> implements IterableIterator<R>, Disposable {
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
	static fromSync<T extends CharacterSequenceInput>(source: T, init: SpliteratorInit = {}): Spliterator {
		return new Spliterator(normalizeCharacterInput(source), init)
	}

	/**
	 * Create a spliterator from an iterable resource such as a buffer, array, or string.
	 *
	 * @param source - The data resource to read from.
	 * @param init - The initialization options for the generator.
	 */
	static from(source: CharacterSequenceInput, init?: SpliteratorInit): Spliterator
	/**
	 * Create a new delimited generator from an asynchronous byte stream.
	 *
	 * @param source - The data resource to read from.
	 * @param init - The initialization options for the generator.
	 *
	 * @returns A new generator instance, yielding byte ranges.
	 */
	static from(source: AsyncChunkIterator, init?: AsyncSpliteratorInit): AsyncSpliterator
	/**
	 * Create a new delimited generator from a resource such as a file handle or URL.
	 *
	 * @param source - The data resource to read from.
	 * @param init - The initialization options for the generator.
	 *
	 * @returns A new generator instance, yielding byte ranges.
	 */
	static from(source: AsyncDataResource, init?: AsyncSpliteratorInit): Promise<AsyncSpliterator>
	/**
	 * Create a new delimited generator from a resource such as a file handle, URL, or byte stream.
	 *
	 * @param source - The data resource to read from.
	 * @param init - The initialization options for the generator.
	 *
	 * @returns A new generator instance, yielding byte ranges.
	 */
	/**
	 * Create a new delimited generator from a resource such as a file handle, URL, or byte stream.
	 *
	 * @param source - The data resource to read from.
	 * @param init - The initialization options for the generator.
	 *
	 * @returns A new generator instance, yielding byte ranges.
	 */
	static from(
		source: CharacterSequenceInput | AsyncDataResource | AsyncChunkIterator,
		init?: SpliteratorInit & AsyncSpliteratorInit
	): Spliterator | AsyncSpliterator | Promise<AsyncSpliterator>
	static from(
		source: CharacterSequenceInput | AsyncDataResource | AsyncChunkIterator,
		init: SpliteratorInit & AsyncSpliteratorInit = {}
	): Spliterator | AsyncSpliterator | Promise<AsyncSpliterator> {
		if (typeof source === "object" && Symbol.asyncIterator in source) {
			return new AsyncSpliterator(source, init)
		}

		if (typeof source === "string" || source instanceof URL || isFileHandleLike(source)) {
			return import("spliterator/node/fs").then(async ({ createChunkIterator }) => {
				const chunkIterator = await createChunkIterator(source, {
					highWaterMark: init.highWaterMark,
				})

				return new AsyncSpliterator(chunkIterator, init)
			})
		}

		return new Spliterator(normalizeCharacterInput(source), init)
	}

	/**
	 * Create a new delimited generator from a data resource.
	 */
	public static toTransformStream(init: SpliteratorInit): TransformStream<Uint8Array, Uint8Array[]> {
		return new TransformStream<Uint8Array, Uint8Array[]>({
			transform(chunk, controller) {
				const spliterator = new Spliterator(chunk, init)

				controller.enqueue(spliterator.toArray())
			},
		})
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
	 * The byte sequence for a double quote.
	 */
	readonly #doubleQuoteSequence: CharacterSequence = new CharacterSequence('"')

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
	 * A bit of a hack to keep track of double quotes.
	 */
	#doubleQuoteStartIndex = -1

	/**
	 * The previous byte range seen while draining the buffer.
	 */
	#previousByteRange: ByteRange | undefined

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

	#drain(): void {
		const sourceByteLength = this.#source.byteLength

		this.#log("Reached end of file. Preparing to finalize.")

		// There's a few special cases we could get this far and not have drained the buffer.
		const lastByteRange = this.#previousByteRange

		if (lastByteRange) {
			const lastByteIndex = lastByteRange[1]

			// There's a special case where the last delimiter is at the end of the *file*.

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
		} else if (this.#yieldCount === 0) {
			// We didn't find any delimiters in the file, so we just enqueue the whole buffer.
			this.#indices.enqueue([0, sourceByteLength])
		}

		this.#done = true
	}

	/**
	 * Fill the buffer with data and search for delimiters.
	 */
	#fill(): void {
		const sourceByteLength = this.#source.byteLength

		while (this.#readPosition < sourceByteLength && this.#indices.byteLength < this.#highWaterMark) {
			const doubleQuoteStartIndex = this.#doubleQuoteStartIndex

			let nextDoubleQuoteIndex: number
			let delimiterSearchStart = this.#readPosition
			let sliceEnd: number
			let sliceStart: number = this.#readPosition

			// if (doubleQuoteStartIndex !== -1) {
			// 	nextDoubleQuoteIndex = this.#doubleQuoteSequence.search(this.#source, doubleQuoteStartIndex + 1)
			// } else {
			// 	nextDoubleQuoteIndex = this.#doubleQuoteSequence.search(this.#source, this.#readPosition)

			// }

			// 	if (nextDoubleQuoteIndex !== -1) {
			// 		console.log("Next double quote at", nextDoubleQuoteIndex)

			// 		delimiterSearchStart = nextDoubleQuoteIndex + 1
			// 	} else {
			// 		// console.log("No double quote found after previous double quote")

			// 		delimiterSearchStart = this.#readPosition
			// 	}

			// 	this.#doubleQuoteStartIndex = -1
			// } else {
			// 	// console.log("Searching for double quote at read position", this.#readPosition)

			// 	nextDoubleQuoteIndex = this.#doubleQuoteSequence.search(this.#source, this.#readPosition)

			// 	if (nextDoubleQuoteIndex !== -1) {
			// 		console.log("Found double quote at", nextDoubleQuoteIndex)
			// 		this.#doubleQuoteStartIndex = nextDoubleQuoteIndex
			// 		sliceStart = doubleQuoteStartIndex + 1

			// 		delimiterSearchStart = nextDoubleQuoteIndex + 1
			// 	} else {
			// 		// console.log("No double quote found at read position")

			// 		delimiterSearchStart = this.#readPosition
			// 	}
			// }
			let delimiterIndex: number

			while (true) {
				delimiterIndex = this.#needle.search(this.#source, delimiterSearchStart)

				if (delimiterIndex === -1) {
					// this.#log(`No delimiters left. Breaking.`)
					return
				}

				nextDoubleQuoteIndex = this.#doubleQuoteSequence.search(this.#source, delimiterSearchStart, delimiterIndex)

				// Didn't find a double quote before the delimiter.
				if (nextDoubleQuoteIndex === -1 && this.#doubleQuoteStartIndex === -1) {
					// And we haven't found a double quote before.
					sliceEnd = delimiterIndex

					this.#readPosition = sliceEnd + this.#needle.length

					break
				}

				if (nextDoubleQuoteIndex !== -1) {
					// We found a double quote before the delimiter...

					if (this.#doubleQuoteStartIndex === -1) {
						// But this is the first double quote we've found.
						this.#doubleQuoteStartIndex = nextDoubleQuoteIndex

						delimiterSearchStart = delimiterIndex + 1
						continue
					} else {
						sliceStart = this.#doubleQuoteStartIndex + 1
					}
				}

				// We found a double quote before the delimiter, but it's not the first one.
				sliceEnd = delimiterIndex - 1

				this.#readPosition = delimiterIndex + this.#needle.length
				this.#doubleQuoteStartIndex = -1

				break
			}

			const byteRange: ByteRange = [sliceStart, sliceEnd]

			// this.#log("Found byte ranges", byteRange)
			this.#log(
				`${byteRange} --> (${sliceStart - delimiterSearchStart})`,
				debugAsVisibleCharacters(this.#source.subarray(...byteRange))
			)

			this.#indices.enqueue(byteRange)
		}
	}

	//#endregion

	//#region Iterator Methods

	/**
	 * Read the next byte range from the source.
	 */
	public next(): IteratorResult<R> {
		if (this.#done || this.#yieldCount >= this.#yieldStopCount) return this.#finalize()

		if (!this.#indices.size) this.#fill()

		if (!this.#indices.size) {
			this.#drain()
		}

		const currentByteRange = this.#indices.dequeue()
		this.#previousByteRange = currentByteRange

		if (!currentByteRange) {
			this.#done = true
			return this.#finalize()
		}

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
			value: slice as unknown as R,
			done: false,
		}
	}

	/**
	 * Collect all the byte ranges from the file.
	 *
	 * @returns An array of encoded byte ranges.
	 * @see {@linkcode toDecodedArray} to automatically decode the byte ranges.
	 */
	public toArray(): R[] {
		return Array.from(this)
	}

	/**
	 * Collect all the byte ranges from the file as a string.
	 */
	public toDecodedArray(decoder = new TextDecoder()): string[] {
		return Array.from(this, (bytes) => decoder.decode(bytes))
	}

	public [Symbol.iterator](): IterableIterator<R> {
		return this
	}
}
