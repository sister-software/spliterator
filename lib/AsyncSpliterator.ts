/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { BufferController } from "./BufferController.js"
import { CharacterSequence, CharacterSequenceInput } from "./CharacterSequence.js"
import { IndexQueue } from "./IndexQueue.js"
import {
	applyReaderPolyfill,
	AsyncDataResource,
	type ByteRange,
	type ByteRangeReader,
	type FileResourceLike,
	isFileResourceLike,
} from "./shared.js"

/**
 * Initialization options for creating a spliterator.
 */
export interface SpliteratorInit {
	/**
	 * The character to delimit by. Typically a newline or comma.
	 */
	delimiter?: CharacterSequenceInput

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
	 * Whether to emit debug information.
	 */
	debug?: boolean
}

/**
 * Initialization options for creating an asynchronous spliterator.
 */
export interface AsyncSpliteratorInit extends SpliteratorInit {
	/**
	 * The buffer chunk size to read from the file, i.e. the high-water mark for the file read
	 * operation.
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
 * An asynchronous spliterator for reading delimited byte streams.
 *
 * ```ts
 * import { AsyncSpliterator } from "spliterator"
 *
 * const file = await AsyncSpliterator.from("data.csv")
 *
 * for await (const line of file) {
 *  console.log(line)
 * }
 * ```
 *
 * @see {@linkcode Spliterator} for the synchronous version.
 */
export class AsyncSpliterator implements AsyncIterableIterator<Uint8Array>, AsyncDisposable {
	//#region Lifecycle

	/**
	 * Create a new delimited generator from a data resource.
	 *
	 * Unlike the constructor, this method can be used to create a generator from a file path or URL.
	 *
	 * @param source - The data resource to read from.
	 * @param init - The initialization options for the generator.
	 */
	static async from(source: AsyncDataResource, init: AsyncSpliteratorInit = {}): Promise<AsyncSpliterator> {
		let file: FileResourceLike

		if (isFileResourceLike(source)) {
			file = source
		} else {
			const { NodeFileResource } = await import("spliterator/node/fs")
			file = await NodeFileResource.open(source)
		}

		return new AsyncSpliterator(file, init)
	}

	/**
	 * Dispose of the spliterator, closing the file handle if necessary.
	 */
	public async [Symbol.asyncDispose](): Promise<void> {
		this.#indices.clear()
		this.#controller.clear()

		if (this.#autoClose) {
			await this.#file[Symbol.asyncDispose]?.()
		}
	}

	/**
	 * Create a new delimited generator from a file handle.
	 *
	 * @param file - The file to read from.
	 * @param init - The initialization options for the generator.
	 * @see {@linkcode AsyncSpliterator.from} to create a new generator from a data resource.
	 */

	constructor(file: FileResourceLike, init: AsyncSpliteratorInit = {}) {
		applyReaderPolyfill(file)
		this.#file = file

		this.#autoClose = init.autoClose ?? false

		this.#needle = new CharacterSequence(init.delimiter)

		this.#readPosition = init.position ?? 0

		this.#totalByteSize = file.size

		this.#yieldByteEstimate = this.#totalByteSize - this.#readPosition

		this.#highWaterMark = Math.max(this.#needle.length * 4, init.highWaterMark ?? 4096)

		this.#yieldDropCount = Math.max(0, init.drop ?? 0)
		this.#yieldStopCount = Math.max(init.take ?? Infinity, 0) + this.#yieldDropCount

		this.#skipEmpty = init.skipEmpty ?? true

		this.#controller = new BufferController({
			initialBufferSize: Math.max(this.#needle.length * 4, this.#highWaterMark),
		})

		this.#debug = init.debug ?? false
		this.#log = this.#debug ? console.debug.bind(console) : () => void 0
	}

	//#endregion

	//#region Private Properties

	/**
	 * The file to read from.
	 */
	readonly #file: FileResourceLike & ByteRangeReader

	/**
	 * Whether to close the file handle when the iterator is completed or disposed.
	 */
	readonly #autoClose: boolean

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
	 * The buffer containing the current chunks of data. This will be resized as needed to accommodate
	 * the file read operation.
	 */
	readonly #controller: BufferController

	/**
	 * The total byte size of the file.
	 */
	readonly #totalByteSize: number

	/**
	 * The total number of bytes we expect to yield.
	 *
	 * We use this to ensure that we don't miss any data when the file is read in chunks.
	 */
	readonly #yieldByteEstimate: number

	/**
	 * How many yields to skip.
	 */
	readonly #yieldDropCount: number

	/**
	 * How many yields to allow before stopping.
	 */
	readonly #yieldStopCount: number

	/**
	 * Whether to skip empty yields.
	 */
	readonly #skipEmpty: boolean

	/**
	 * The high water mark for the buffer.
	 *
	 * This defines the size of each read operation, as well as the total size of indices to keep in
	 * memory.
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

	/**
	 * Find and enqueue delimiter positions.
	 */
	#search() {
		const lastByteRange = this.#indices.peekLast()
		let searchCursor = lastByteRange ? lastByteRange[1] + this.#needle.length : 0

		while (searchCursor <= this.#controller.bytesWritten) {
			const delimiterIndex = this.#needle.search(this.#controller.bytes, searchCursor)

			if (delimiterIndex === -1) {
				this.#log(`No viable byte range found in buffer. Breaking.`)
				break
			}

			this.#log("Found byte range", [searchCursor, delimiterIndex])
			this.#indices.enqueue([searchCursor, delimiterIndex])

			searchCursor = delimiterIndex + this.#needle.length
		}
	}

	/**
	 * Read a chunk of data from the file.
	 */
	async #read() {
		// We're extra careful here to ensure that we don't read past the end of the file.
		// And because `file.read` doesn't expose the number of bytes read,
		// we keep track of this ourselves.
		const nextReadLength = Math.min(this.#highWaterMark, this.#totalByteSize - this.#readPosition)
		// Offset in this context means the byte offset to begin writing to the buffer.
		const offset = this.#controller.bytesWritten

		// Before reading we grow the buffer to ensure that we have enough space.
		const nextBufferSize = Math.max(this.#controller.byteLengthMinimum, offset + nextReadLength)
		this.#controller.grow(nextBufferSize)

		this.#log("Before read", { cursor: this.#readPosition, nextReadLength, nextBufferSize, offset })

		await this.#file.read({
			buffer: this.#controller.bytes,
			offset,
			position: this.#readPosition,
			length: nextReadLength,
		})

		this.#controller.bytesWritten += nextReadLength

		// this.#log(
		// 	"Inspecting buffer",
		// 	debugAsVisibleCharacters(this.#controller.bytes.subarray(0, this.#controller.bytesWritten))
		// )

		this.#readPosition += nextReadLength
	}

	/**
	 * Fill the buffer with data and search for delimiters.
	 */
	async #fill(): Promise<void> {
		if (this.#readPosition === this.#totalByteSize) {
			this.#log("Reached end of file. Preparing to finalize.")

			// There's a few special cases we could get this far and not have drained the buffer.
			const lastByteRange = this.#lastByteRangeSeen

			if (lastByteRange) {
				const lastByteIndex = lastByteRange[1]

				// There's a special case where the last delimiter is at the end of the *file*.

				if (lastByteIndex < this.#controller.bytesWritten) {
					// We need to determine if we're at the end of the *file* and there's no delimiter.
					const possibleDelimiterIndex = this.#needle.search(
						this.#controller.bytes,
						this.#controller.bytesWritten - this.#needle.length
					)

					if (possibleDelimiterIndex !== -1) {
						this.#log("Inserted byte range at the last delimiter", [
							possibleDelimiterIndex,
							this.#controller.bytesWritten,
						])
						// We found a delimiter at the end of the file, so we enqueue the byte range.
						this.#indices.enqueue([possibleDelimiterIndex + this.#needle.length, this.#controller.bytesWritten])
					} else {
						this.#log("Inserted byte range at the last byte", [lastByteIndex, this.#controller.bytesWritten])
						// The file didn't end with a delimiter, so we just enqueue the last byte range.
						this.#indices.enqueue([lastByteIndex + this.#needle.length, this.#controller.bytesWritten])
					}
				} else {
					this.#log(
						`Weird situation. We're at the end of the file, but the last byte range ${lastByteIndex} is greater than the buffer length ${this.#controller.bytesWritten}.`
					)
				}
			} else if (this.#yieldCount === 0) {
				// We didn't find any delimiters in the file, so we just enqueue the whole buffer.
				this.#indices.enqueue([0, this.#controller.bytesWritten])
			}

			this.#done = true

			return
		}

		// We're effectively done with that window of the buffer.
		// So we can compress it to save memory.
		const nextBufferStart = this.#lastByteRangeSeen ? this.#lastByteRangeSeen[1] + this.#needle.length : 0

		this.#log("Compressing buffer", { nextBufferStart })
		this.#controller.compress(nextBufferStart)

		while (this.#readPosition < this.#totalByteSize && this.#indices.byteLength < this.#highWaterMark) {
			await this.#read()
			this.#search()
		}
	}

	async #finalize(): Promise<IteratorReturnResult<undefined>> {
		if (this.#debug) {
			/**
			 * The total number of bytes we expect to be omitted from the buffer. This is derived from the
			 * number of of yields and the length of the delimiter.
			 */
			const expectedYieldedDelimitedBytes = (this.#yieldCount - 1) * this.#needle.length
			const omittedBytes = this.#yieldByteEstimate - (this.#yieldedByteLength + expectedYieldedDelimitedBytes)

			this.#log({
				totalByteSize: this.#totalByteSize,
				readPosition: this.#readPosition,
				yieldByteEstimate: this.#yieldByteEstimate,
				yieldedByteLength: this.#yieldedByteLength,
				yieldCount: this.#yieldCount,
				expectedYieldedDelimitedBytes,
				omittedBytes,
			})
		}

		if (this.#autoClose) {
			await this.#file[Symbol.asyncDispose]?.()
		}

		return {
			done: true,
			value: undefined,
		}
	}

	//#endregion

	//#region Iterator Methods

	public async next(): Promise<IteratorResult<Uint8Array>> {
		if (this.#done || this.#yieldCount >= this.#yieldStopCount) return this.#finalize()

		if (this.#indices.size === 0) {
			await this.#fill()
		}

		const currentByteRange = this.#indices.dequeue()!
		this.#lastByteRangeSeen = currentByteRange

		const [start, end] = currentByteRange

		const slice = this.#controller.subarray(start, end)

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
	 *
	 * **This method will read the entire file into memory.**
	 */
	public toArray(): Promise<Uint8Array[]> {
		return Array.fromAsync(this)
	}

	/**
	 * Collect all the byte ranges from the file as a string.
	 *
	 * **This method will read the entire file into memory.**
	 */
	public toDecodedArray(decoder = new TextDecoder()): Promise<string[]> {
		return Array.fromAsync(this, (bytes) => decoder.decode(bytes))
	}

	public [Symbol.asyncIterator]() {
		return this
	}

	public return(): Promise<IteratorReturnResult<undefined>> {
		return this.#finalize()
	}
}
