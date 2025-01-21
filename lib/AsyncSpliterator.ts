/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { ReadableStream, ReadableWritablePair, StreamPipeOptions } from "stream/web"
import { BufferController } from "./BufferController.js"
import { CharacterSequence, CharacterSequenceInput } from "./CharacterSequence.js"
import { IndexQueue } from "./IndexQueue.js"
import { AsyncChunkIterator, AsyncDataResource, type ByteRange } from "./shared.js"

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
	 * Whether to automatically dispose of the source once the iterator is done.
	 *
	 * @default true
	 */
	autoDispose?: boolean
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
export class AsyncSpliterator<R extends DataView | ArrayBuffer = Uint8Array>
	implements AsyncIterableIterator<R>, AsyncDisposable
{
	//#region Lifecycle

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
	static from(
		source: AsyncDataResource | AsyncChunkIterator,
		init?: AsyncSpliteratorInit
	): AsyncSpliterator | Promise<AsyncSpliterator>
	static from(
		source: AsyncDataResource | AsyncChunkIterator,
		init: AsyncSpliteratorInit = {}
	): AsyncSpliterator | Promise<AsyncSpliterator> {
		if (typeof source === "object" && Symbol.asyncIterator in source) {
			return new AsyncSpliterator(source, init)
		}

		return import("spliterator/node/fs").then(async ({ createChunkIterator }) => {
			const chunkIterator = await createChunkIterator(source, {
				highWaterMark: init.highWaterMark,
			})

			return new AsyncSpliterator(chunkIterator, init)
		})
	}

	/**
	 * Dispose of the spliterator, closing the file handle if necessary.
	 */
	public async [Symbol.asyncDispose](): Promise<void> {
		this.#indices.clear()
		this.#controller.clear()

		if (this.#autoDispose) {
			await this.#source[Symbol.asyncDispose]?.()
		}
	}

	/**
	 * Create a new delimited generator from a data resource.
	 */
	public static toTransformStream(init: SpliteratorInit): TransformStream<AsyncChunkIterator, Uint8Array> {
		return new TransformStream<AsyncChunkIterator, Uint8Array>({
			async transform(chunk, controller) {
				const spliterator = await AsyncSpliterator.from(chunk, init)

				for await (const slice of spliterator) {
					controller.enqueue(slice)
				}
			},
		})
	}

	/**
	 * Create a new delimited generator from an asynchronous byte stream.
	 *
	 * @param source - The file to read from.
	 * @param init - The initialization options for the generator.
	 * @see {@linkcode AsyncSpliterator.from} to create a new generator from a data resource.
	 */
	constructor(source: AsyncChunkIterator, init: AsyncSpliteratorInit = {}) {
		this.#source = source
		this.#chunkReader = source[Symbol.asyncIterator]()

		this.#autoDispose = init.autoDispose ?? false

		this.#needle = new CharacterSequence(init.delimiter)

		this.#highWaterMark = Math.max(this.#needle.length * 4, init.highWaterMark ?? 4096 * 16)

		this.#yieldDropCount = Math.max(0, init.drop ?? 0)
		this.#yieldStopCount = Math.max(init.take ?? Infinity, 0) + this.#yieldDropCount

		this.#skipEmpty = init.skipEmpty ?? true

		this.#controller = new BufferController({
			initialBufferSize: this.#highWaterMark,
		})

		this.#debug = init.debug ?? false
		this.#log = this.#debug ? console.debug.bind(console) : () => void 0
	}

	//#endregion

	//#region Private Properties

	/**
	 * Whether to call `Symbol.asyncDispose` on the source once the iterator is done.
	 */
	readonly #autoDispose: boolean

	/**
	 * The source of the data.
	 */
	readonly #source: AsyncChunkIterator

	/**
	 * The chunk reader for the file.
	 */
	readonly #chunkReader: AsyncIterator<Uint8Array>

	/**
	 * The last chunk of data read from the source.
	 */
	#lastReadResult: IteratorResult<Uint8Array> | undefined

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

	// /**
	//  * The current byte index to perform read operations from.
	//  */
	// #readPosition: number

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
		this.#lastReadResult = await this.#chunkReader.next()

		if (this.#lastReadResult.done) return

		// Append the chunk to the buffer.
		this.#controller.set(this.#lastReadResult.value, this.#controller.bytesWritten)
	}

	/**
	 * Fill the buffer with data and search for delimiters.
	 */
	async #fill(): Promise<void> {
		if (this.#lastReadResult?.done) {
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

		while ((!this.#lastReadResult || !this.#lastReadResult.done) && this.#indices.byteLength < this.#highWaterMark) {
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

			this.#log({
				yieldedByteLength: this.#yieldedByteLength,
				yieldCount: this.#yieldCount,
				expectedYieldedDelimitedBytes,
			})
		}

		if (this.#autoDispose) {
			await this.#source[Symbol.asyncDispose]?.()
		}

		return {
			done: true,
			value: undefined,
		}
	}

	//#endregion

	//#region Iterator Methods

	public async next(): Promise<IteratorResult<R>> {
		if (this.#done || this.#yieldCount >= this.#yieldStopCount) return this.#finalize()

		if (this.#indices.size === 0) {
			await this.#fill()
		}

		const currentByteRange = this.#indices.dequeue()
		this.#lastByteRangeSeen = currentByteRange

		if (!currentByteRange) {
			this.#done = true
			return this.#finalize()
		}

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
			value: slice as unknown as R,
			done: false,
		}
	}

	/**
	 * Collect all the byte ranges from the file.
	 *
	 * **This method will read the entire file into memory.**
	 */
	public toArray(): Promise<R[]> {
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

	/**
	 * Wraps the spliterator in a readable stream.
	 *
	 * This is useful for piping the spliterator to other streams.
	 *
	 * @returns A readable stream of byte ranges.
	 */
	public toReadableStream(): ReadableStream<R> {
		const iterator = this[Symbol.asyncIterator]()

		return new ReadableStream({
			pull: async (controller) => {
				const { done, value } = await iterator.next()

				if (done) {
					controller.close()
				} else {
					controller.enqueue(value)
				}
			},
			cancel: () => this[Symbol.asyncDispose]?.(),
		})
	}

	/**
	 * Pipes the spliterator to a writable stream.
	 *
	 * ```ts
	 * const spliterator = await AsyncSpliterator.from("data.csv")
	 *
	 * const textStream = spliterator.pipeTo(new TextDecoderStream())
	 * ```
	 *
	 * @see {@linkcode toReadableStream} to first convert the spliterator to a readable stream.
	 */
	public pipeThrough<T>(transform: ReadableWritablePair<T, R>, options?: StreamPipeOptions): ReadableStream<T> {
		return this.toReadableStream().pipeThrough(transform, options)
	}

	/**
	 * Iterate over the byte ranges in the file, yielding each range. between delimiters.
	 */
	public [Symbol.asyncIterator]() {
		return this
	}

	public return(): Promise<IteratorReturnResult<undefined>> {
		return this.#finalize()
	}

	//#endregion

	//#region Experimental

	/**
	 * Given a file handle containing delimited data and a desired slice count, returns an array of
	 * slices of the buffer between delimiters.
	 *
	 * This is an advanced function so an analogy is provided:
	 *
	 * Suppose you had to manually search through a very large book page by page to find where each
	 * chapter begins and ends. For a book with 1,000,000 pages, a single person would take a long
	 * time to go through it all.
	 *
	 * You could add more people to the task by laying out all the pages, measuring the length and
	 * assigning each person a length of pages to traverse.
	 *
	 * There's a few ways to go about this:
	 *
	 * We could approach this in serial -- having the first worker start from page 1 and scanning
	 * until they find the beginning of the next chapter, handing off the range to the next worker.
	 * This is how `AsyncSpliterator` works.
	 *
	 * However this is inefficient because no matter how many workers we have, they must wait for the
	 * previous worker to finish before they can start. Ideally, a desired number of workers would be
	 * able to scan their own _length_ of pages simultaneously, and settle up on the boundaries of the
	 * chapters they find.
	 *
	 * `AsyncSpliterator.asMany` is like the second approach, spltting the book into mostly equal
	 * lengths and having each worker scan their own length of pages.
	 *
	 * @param source - The file handle to read from.
	 * @param delimiter - The character to delimit by. Typically a newline or comma.
	 * @param concurrency - The _desired_ number of `AsyncSpliterator` instances to create.
	 *
	 * @returns An array of `AsyncSpliterator` instances, possibly less than the desired concurrency.
	 * @internal
	 */
	public static async asMany(
		source: AsyncDataResource,
		delimiter: CharacterSequenceInput,
		concurrency: number
	): Promise<AsyncSpliterator[]> {
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		concurrency = Math.max(1, concurrency)
		const needle = new CharacterSequence(delimiter)

		const spliterators: AsyncSpliterator[] = []

		const { createChunkIterator, readFileSize } = await import("spliterator/node/fs")
		const fileSize = await readFileSize(source)
		// const file = createChunkIterator(source, {
		// 	start: 0,
		// })

		// The idea here is  we're going to split the file into `concurrency` chunks.

		if (Date.now()) {
			throw new Error("Not implemented.")
		}

		return spliterators
	}
}
