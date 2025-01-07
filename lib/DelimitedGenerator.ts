/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { CharacterSequence, CharacterSequenceInput } from "./CharacterSequence.js"
import {
	applyReaderPolyfill,
	AsyncDataResource,
	ByteRangeReader,
	FileResourceLike,
	isFileResourceLike,
	TypedArray,
} from "./shared.js"
import { ByteRange, SlidingWindow } from "./SlidingWindow.js"

/**
 * A first-in, first-out queue for marking and dequeuing index tuples.
 */
export class IndexQueue implements IterableIterator<ByteRange> {
	#tuples: number[] = []

	/**
	 * The number of tuples in the queue.
	 */
	public get size(): number {
		return this.#tuples.length / 2
	}

	/**
	 * The total byte length spanned by the tuples in the queue.
	 */
	public get byteLength(): number {
		let byteLength = 0

		for (let i = 0; i < this.#tuples.length; i += 2) {
			byteLength += this.#tuples[i + 1]! - this.#tuples[i]!
		}

		return byteLength
	}

	/**
	 * Append a new tuple to the queue.
	 */
	public enqueue(tuple: ByteRange): void {
		this.#tuples.push(...tuple)
	}

	/**
	 * Get the next tuple in the queue, removing it.
	 */
	public dequeue(): ByteRange | undefined {
		if (this.#tuples.length < 2) return

		const tuple = this.#tuples.splice(0, 2)

		return tuple as ByteRange
	}

	/**
	 * Peek at the next tuple in the queue without removing it.
	 */
	public peek(): ByteRange | undefined {
		if (this.#tuples.length < 2) return

		return this.#tuples.slice(0, 2) as ByteRange
	}

	/**
	 * Peek at the last tuple in the queue without removing it.
	 */
	public peekLast(): ByteRange | undefined {
		if (this.#tuples.length < 2) return

		return this.#tuples.slice(-2) as ByteRange
	}

	/**
	 * Clear the queue.
	 */
	public clear(): void {
		this.#tuples.length = 0
	}

	/**
	 * Alias for `dequeue`, conforming to the iterator protocol.
	 */
	public next(): IteratorResult<ByteRange> {
		const tuple = this.dequeue()

		if (tuple) {
			return { done: false, value: tuple }
		}

		return { done: true, value: undefined }
	}

	public [Symbol.iterator](): IndexQueue {
		return this
	}
}

/**
 * A class to manage a buffer of bytes, growing and shrinking as needed.
 */
export class BufferController {
	/**
	 * The initial size of the buffer.
	 */
	#initialBufferSize: number

	/**
	 * The underlying buffer containing the data.
	 *
	 * This property is mutable for performance reasons. Consumers should treat it as immutable.
	 */
	bytes: Uint8Array

	/**
	 * The total number of bytes currently written to the buffer.
	 *
	 * This property is mutable for performance reasons. Consumers should treat it as immutable.
	 */
	bytesWritten: number

	/**
	 * The minimum byte length of the buffer.
	 */
	public get byteLengthMinimum(): number {
		return Math.max(this.bytesWritten, this.#initialBufferSize)
	}

	constructor(init: { initialBufferSize: number }) {
		this.#initialBufferSize = init.initialBufferSize
		this.bytes = new Uint8Array(this.#initialBufferSize)
		this.bytesWritten = 0
	}

	/**
	 * Grow the buffer to the desired byte length, typically double the current byte length.
	 */
	public grow(desiredByteLength?: number): void {
		desiredByteLength ??= this.bytes.length * 2

		if (desiredByteLength <= this.bytes.length) return

		// console.debug(`Growing buffer from ${this.bytes.length} to ${desiredByteLength} bytes.`)
		const newBytes = new Uint8Array(desiredByteLength)

		newBytes.set(this.bytes)

		this.bytes = newBytes
	}

	/**
	 * Modify the buffer in place, keeping only the bytes between the start and end indices.
	 *
	 * This is performed after we're confident that any data preceeding `start` or following `end` is
	 * no longer needed.
	 *
	 * @param start - The starting byte index of which bytes to keep.
	 * @param end - The ending byte index of which bytes to keep.
	 */
	public compress(start?: number, end?: number): void {
		const byteLength = Math.max(this.byteLengthMinimum, this.bytes.length)

		if (start === undefined) {
			this.bytes = this.bytes.subarray(0, byteLength)
		} else {
			this.bytes = this.bytes.subarray(start, end)
		}

		this.bytesWritten = this.bytes.length
	}

	/**
	 * Clear the buffer, zeroing out all bytes.
	 *
	 * @param begin The starting byte index from which to clear.
	 * @param end The ending byte index to clear.
	 */
	public clear(begin: number = 0, end: number = this.bytesWritten): void {
		this.bytes.fill(0, begin, end)
		this.bytesWritten = 0
	}

	/**
	 * Gets a new Uint8Array view of the ArrayBuffer store for this array, referencing the elements at
	 * begin, inclusive, up to end, exclusive.
	 *
	 * @param begin — The index of the beginning of the array.
	 * @param end — The index of the end of the array
	 * @throws If the start index is greater than the end index.
	 * @throws If the end index is greater than the current byte length.
	 */
	public subarray(begin: number = 0, end: number = this.bytesWritten): Uint8Array {
		if (begin > end) {
			throw new RangeError(`Start index ${begin} is greater than end index ${end}.`)
		}

		if (end > this.bytesWritten) {
			throw new RangeError(`End index ${end} is greater than the current byte length ${this.bytesWritten}.`)
		}

		return this.bytes.subarray(begin, end)
	}
}

/**
 * Options for the delimited iterator.
 */
export interface DelimitedGeneratorInit {
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
	 * An `AbortSignal` to cancel the read operation.
	 */
	signal?: AbortSignal
}

export interface AsyncDelimitedGeneratorInit extends DelimitedGeneratorInit {
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

	debug?: boolean
}

export async function* createByteSequenceSearcher<T extends TypedArray = Uint8Array>(
	source: AsyncDataResource,
	init: AsyncDelimitedGeneratorInit = {}
): AsyncGenerator<T, any, unknown> {
	const { signal, autoClose } = init

	let file: FileResourceLike & ByteRangeReader

	if (isFileResourceLike(source)) {
		applyReaderPolyfill(source)

		file = source
	} else {
		const { NodeFileResource } = await import("@sister.software/ribbon/node/fs")
		file = await NodeFileResource.open(source)
	}

	if (file.size === 0) {
		if (autoClose) {
			await file[Symbol.asyncDispose]?.()
		}

		return
	}

	const needle = new CharacterSequence(init.delimiter)

	/**
	 * The current byte index to perform read operations from.
	 */
	let readPosition = init.position ?? 0

	/**
	 * The total byte size of the file.
	 */
	const totalByteSize = file.size

	/**
	 * The total number of bytes we expect to yield.
	 *
	 * We use this to ensure that we don't miss any data when the file is read in chunks.
	 */
	const yieldByteEstimate = totalByteSize - readPosition

	/**
	 * The total number of bytes we've yielded.
	 */
	let yieldedByteLength = 0
	let yieldCount = 0

	// const blockSize = file.blockSize ?? 4096
	const highWaterMark = init.highWaterMark ?? Math.max(needle.length * 4, 4096)

	const drop = Math.max(0, init.drop ?? 0)
	const take = Math.max(init.take ?? Infinity, 0) + drop
	const skipEmpty = init.skipEmpty ?? true

	/**
	 * A queue of index tuples marking the start and end of delimiter positions.
	 *
	 * Note that indices are relative to the buffer, not the file.
	 *
	 * This means that the start index is always 0, and the end index is the byte length of the
	 * buffer.
	 */
	const indices = new IndexQueue()

	/**
	 * The buffer containing the current chunks of data. This will be resized as needed to accommodate
	 * the file read operation.
	 */
	const controller = new BufferController({ initialBufferSize: Math.max(needle.length * 4, highWaterMark) })

	/**
	 * Drain the buffer, yielding each slice of data.
	 *
	 * Performing this operation will compact the buffer with some internal logic to ensure that we
	 * don't miss any data.
	 *
	 * @yields Each slice of the buffer separated by a delimiter.
	 */
	function* drain(): Generator<T> {
		if (indices.size === 0) return
		if (yieldCount >= take) return

		/** The current dequeued byte range. */
		let currentByteRange: ByteRange | undefined
		/** The last byte range seen. */
		let lastByteRangeSeen: ByteRange | undefined

		while ((currentByteRange = indices.dequeue())) {
			lastByteRangeSeen = currentByteRange

			const [start, end] = currentByteRange

			const slice = controller.subarray(start, end) as T

			if (!skipEmpty || slice.length > 0) {
				yieldCount++

				if (yieldCount > drop) {
					yieldedByteLength += end - start

					yield slice
				}
			}

			if (yieldCount > take) break
		}

		// By yielding out our indices, we're effectively done with that window of the buffer.
		// So we can compress it to save memory.
		const nextBufferStart = lastByteRangeSeen ? lastByteRangeSeen[1] + needle.length : 0
		controller.compress(nextBufferStart)
	}

	async function read() {
		// We're extra careful here to ensure that we don't read past the end of the file.
		// And because `file.read` doesn't expose the number of bytes read,
		// we keep track of this ourselves.
		const nextReadLength = Math.min(highWaterMark, totalByteSize - readPosition)
		// Offset in this context means the byte offset to begin writing to the buffer.
		const offset = controller.bytesWritten

		// Before reading we grow the buffer to ensure that we have enough space.
		const nextBufferSize = Math.max(controller.byteLengthMinimum, offset + nextReadLength)
		controller.grow(nextBufferSize)

		// console.debug("Before read", { cursor: readPosition, nextReadLength, nextBufferSize })

		await file.read({
			buffer: controller.bytes,
			offset,
			position: readPosition,
			length: nextReadLength,
		})

		// console.debug("Inspecting buffer", debugAsVisibleCharacters(controller.bytes))

		controller.bytesWritten += nextReadLength
		readPosition += nextReadLength
	}

	/**
	 * Find and enqueue delimiter positions.
	 */
	function search() {
		const lastByteRange = indices.peekLast()
		let searchCursor = lastByteRange ? lastByteRange[1] + needle.length : 0

		while (searchCursor <= controller.bytesWritten) {
			const delimiterIndex = needle.search(controller.bytes, searchCursor)

			if (delimiterIndex === -1) {
				// console.debug(`No viable byte range found in buffer. Breaking.`)
				break
			}

			// console.debug("Found byte range", [searchCursor, delimiterIndex])
			indices.enqueue([searchCursor, delimiterIndex])

			searchCursor = delimiterIndex + needle.length
		}
	}

	while (readPosition < totalByteSize) {
		if (indices.byteLength >= highWaterMark) {
			// console.debug(`Draining buffer with ${indices.size} indices.`)
			yield* drain()
		}

		await read()
		search()
	}

	// There's a few special cases we could get this far and not have drained the buffer.
	const lastByteRange = indices.peek()

	if (lastByteRange) {
		const lastByteIndex = lastByteRange[1]

		// There's a special case where the last delimiter is at the end of the *file*.

		if (lastByteIndex < controller.bytesWritten) {
			// We need to determine if we're at the end of the *file* and there's no delimiter.
			const possibleDelimiterIndex = needle.search(controller.bytes, controller.bytesWritten - needle.length)

			if (possibleDelimiterIndex !== -1) {
				// We found a delimiter at the end of the file, so we enqueue the byte range.
				indices.enqueue([possibleDelimiterIndex + needle.length, controller.bytesWritten])
			} else {
				// The file didn't end with a delimiter, so we just enqueue the last byte range.
				indices.enqueue([lastByteIndex + needle.length, controller.bytesWritten])
			}
		}
	} else if (yieldCount === 0) {
		// We didn't find any delimiters in the file, so we just enqueue the whole buffer.
		indices.enqueue([0, controller.bytesWritten])
	}

	if (indices.size) {
		yield* drain()
	}

	if (init.debug) {
		/**
		 * The total number of bytes we expect to be omitted from the buffer. This is derived from the
		 * number of of yields and the length of the delimiter.
		 */
		const expectedYieldedDelimitedBytes = (yieldCount - 1) * needle.length
		const omittedBytes = yieldByteEstimate - (yieldedByteLength + expectedYieldedDelimitedBytes)

		console.debug({
			totalByteSize,
			readPosition,
			yieldByteEstimate,
			yieldedByteLength,
			yieldCount,
			expectedYieldedDelimitedBytes,
			omittedBytes,
		})
	}

	if (autoClose) {
		await file[Symbol.asyncDispose]?.()
	}
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
		{
			take = Infinity,
			skipEmpty = true,
			drop = 0,
			position = 0,
			signal,
			delimiter: delimiterInput,
		}: DelimitedGeneratorInit = {}
	): Generator<T extends string ? Uint8Array : T> {
		const haystack = (typeof source === "string" ? new TextEncoder().encode(source) : source) as
			| Exclude<T, string>
			| Uint8Array

		if (position > haystack.length) return

		const delimiter = new CharacterSequence(delimiterInput)
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
		init: AsyncDelimitedGeneratorInit = {}
	): AsyncGenerator<T, any, unknown> {
		const foo = createByteSequenceSearcher<T>(source, init)

		for await (const bar of foo) {
			yield bar
		}
	}
}
