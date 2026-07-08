/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { ReadableStream, type ReadableWritablePair, type StreamPipeOptions } from "stream/web"

import { BufferController } from "./BufferController.js"
import { CharacterSequence, type CharacterSequenceInput, Delimiters } from "./CharacterSequence.js"
import { IndexQueue } from "./IndexQueue.js"
import { type AsManyWorkersOptions, runSegmentWorkers } from "./segment-workers.js"
import { computeSegments, type SegmentOptions } from "./segments.js"
import type { AsyncChunkIterator, AsyncDataResource, ByteRange } from "./shared.js"

const noop = () => void 0
const sharedEncoder = new TextEncoder()

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
	 * Whether to treat double-quoted regions as opaque: a delimiter inside `"…"` does not split, and the emitted slices
	 * keep their quotes verbatim. Quote _stripping_ and `""` unescaping are the consumer's concern —
	 * {@linkcode CSVSpliterator} does both when this flag is set.
	 *
	 * The asynchronous engine requires a single-byte delimiter for this mode (every {@linkcode Delimiters} entry
	 * qualifies) — a multi-byte delimiter straddling a chunk boundary cannot be rescanned without re-toggling quote
	 * state.
	 *
	 * @default false
	 */
	enableQuoteHandling?: boolean

	/**
	 * Whether to treat a carriage return immediately preceding a delimiter as part of the delimiter — i.e. CRLF
	 * normalization when splitting on `\n`, matching `node:readline`'s `crlfDelay: Infinity`. Only a `\r` directly before
	 * an actual delimiter match is trimmed; a trailing `\r` at end-of-input is preserved.
	 *
	 * {@linkcode CSVSpliterator} defaults this to `true` for row splitting (RFC 4180 mandates CRLF row terminators);
	 * everywhere else the default is `false`.
	 *
	 * @default false
	 */
	crlf?: boolean

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
	 * The buffer chunk size to read from the file, i.e. the high-water mark for the file read operation.
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
 * 	console.log(line)
 * }
 * ```
 *
 * @see {@linkcode Spliterator} for the synchronous version.
 */
export class AsyncSpliterator<R extends Uint8Array | DataView | ArrayBuffer = Uint8Array>
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

		await this.#closeReader()

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
				const spliterator = AsyncSpliterator.from(chunk, init)

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
		this.#crlf = init.crlf ?? false
		this.#enableQuoteHandling = init.enableQuoteHandling ?? false

		if (this.#enableQuoteHandling && this.#needle.length !== 1) {
			throw new RangeError(
				"enableQuoteHandling requires a single-byte delimiter in the asynchronous engine — a multi-byte delimiter straddling a chunk boundary cannot be rescanned without re-toggling quote state."
			)
		}

		this.#controller = new BufferController({
			initialBufferSize: this.#highWaterMark,
		})

		this.#debug = init.debug ?? false
		this.#log = this.#debug ? console.debug.bind(console) : noop
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
	readonly #chunkReader: AsyncIterator<Uint8Array | string>

	/**
	 * The last chunk of data read from the source.
	 */
	#lastReadResult: IteratorResult<Uint8Array | string> | undefined

	/**
	 * A queue of index tuples marking the start and end of delimiter positions.
	 *
	 * Note that indices are relative to the buffer, not the file.
	 *
	 * This means that the start index is always 0, and the end index is the byte length of the buffer.
	 */
	readonly #indices = new IndexQueue()

	/**
	 * The byte sequence to search for, i.e. an encoded delimiter.
	 */
	readonly #needle: CharacterSequence

	/**
	 * The buffer containing the current chunks of data. This will be resized as needed to accommodate the file read
	 * operation.
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
	 * Whether to trim a carriage return immediately preceding each delimiter match.
	 */
	readonly #crlf: boolean

	/**
	 * Whether delimiters inside double-quoted regions are ignored.
	 */
	readonly #enableQuoteHandling: boolean

	/**
	 * The byte sequence for a double quote.
	 */
	readonly #doubleQuoteSequence = new CharacterSequence('"')

	/**
	 * Whether the scan cursor currently sits inside a double-quoted region. Only meaningful with
	 * {@linkcode SpliteratorInit.enableQuoteHandling} — the state must survive both `#fill` rounds and buffer compression,
	 * since a quoted region can span many chunks.
	 */
	#insideQuotes = false

	/**
	 * Raw buffer position up to which matches have been processed. Distinct from the enqueued range ends — those may be
	 * CRLF-trimmed, and quote toggles may sit beyond the last emitted field. Rebased on buffer compression.
	 */
	#searchCursor = 0

	/**
	 * Raw buffer position where the current (not yet terminated) slice begins — i.e. one past the last consumed
	 * delimiter. This is the compression boundary and the start of the EOF tail. Rebased on buffer compression.
	 */
	#pendingSliceStart = 0

	/**
	 * The high water mark for the buffer.
	 *
	 * This defines the size of each read operation, as well as the total size of indices to keep in memory.
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
	 * Trim a carriage return immediately preceding a delimiter match, when {@linkcode SpliteratorInit.crlf} is set.
	 * Affects only the emitted range's end — cursor advancement always uses the raw match offset.
	 */
	#trimEnd(start: number, end: number): number {
		if (this.#crlf && end > start && this.#controller.bytes[end - 1] === Delimiters.CarriageReturn) {
			return end - 1
		}

		return end
	}

	/**
	 * Find and enqueue delimiter positions.
	 *
	 * The search is bounded by `bytesWritten` so we never scan into uninitialized buffer memory and never enqueue ranges
	 * whose `end` exceeds the valid byte length.
	 *
	 * Progress is tracked by `#searchCursor`/`#pendingSliceStart` rather than derived from enqueued range ends — those
	 * ends may be CRLF-trimmed, and (in quote mode) quote toggles may sit beyond the last emitted field.
	 */
	#search() {
		const searchEnd = this.#controller.bytesWritten

		if (!this.#enableQuoteHandling) {
			while (this.#searchCursor <= searchEnd) {
				const delimiterIndex = this.#needle.search(this.#controller.bytes, this.#searchCursor, searchEnd)

				if (delimiterIndex === -1) {
					this.#log(`No viable byte range found in buffer. Breaking.`, { searchCursor: this.#searchCursor })
					break
				}

				const byteRange: ByteRange = [this.#pendingSliceStart, this.#trimEnd(this.#pendingSliceStart, delimiterIndex)]

				this.#log("Found byte range", byteRange)
				this.#indices.enqueue(byteRange)

				this.#searchCursor = delimiterIndex + this.#needle.length
				this.#pendingSliceStart = this.#searchCursor
			}

			return
		}

		// Quote-aware path: a delimiter inside a double-quoted region does not split. The quote
		// state persists across fills and buffer compressions, since a quoted region may span
		// many chunks. The delimiter is single-byte (enforced in the constructor), so a match can
		// never straddle a chunk boundary and the cursor can safely advance to `searchEnd`.
		const matches = this.#needle.searchMatches(
			this.#controller.bytes,
			this.#doubleQuoteSequence,
			this.#searchCursor,
			searchEnd
		)

		for (const match of matches) {
			if (match.patternId === 1) {
				this.#insideQuotes = !this.#insideQuotes
				continue
			}

			if (this.#insideQuotes) continue

			const byteRange: ByteRange = [this.#pendingSliceStart, this.#trimEnd(this.#pendingSliceStart, match.offset)]

			this.#log("Found byte range", byteRange)
			this.#indices.enqueue(byteRange)

			this.#pendingSliceStart = match.offset + this.#needle.length
		}

		this.#searchCursor = searchEnd
	}

	/**
	 * Read a chunk of data from the file.
	 */
	async #read() {
		this.#lastReadResult = await this.#chunkReader.next()

		if (this.#lastReadResult.done) return

		// A string chunk (a `Readable` with an encoding set, a hand-rolled generator of strings)
		// would coerce to garbage via `TypedArray.set` — encode it instead of silently mis-reading.
		const chunk = this.#lastReadResult.value
		const bytes = typeof chunk === "string" ? sharedEncoder.encode(chunk) : chunk

		// Append the chunk to the buffer.
		this.#controller.set(bytes, this.#controller.bytesWritten)
	}

	/**
	 * Fill the buffer with data and search for delimiters.
	 */
	async #fill(): Promise<void> {
		if (this.#lastReadResult?.done) {
			this.#log("Reached end of file. Preparing to finalize.")
			// Enqueue a final slice covering the bytes between the last consumed delimiter and the
			// end of the stream. The slice may be empty (when the stream ends exactly on a
			// delimiter, or when the file is empty); we still enqueue it so that callers with
			// `skipEmpty: false` see the trailing entry produced by `String.prototype.split`.
			// `#pendingSliceStart` — not the last enqueued range's end — is the authority here:
			// range ends may be CRLF-trimmed.
			const tailStart = this.#pendingSliceStart
			const tailEnd = this.#controller.bytesWritten

			if (tailStart <= tailEnd) {
				this.#log("Inserted trailing byte range", [tailStart, tailEnd])
				this.#indices.enqueue([tailStart, tailEnd])
			} else {
				this.#log("Skipped trailing range — start beyond end", { tailStart, tailEnd })
			}

			this.#done = true

			return
		}

		// We're effectively done with that window of the buffer.
		// So we can compress it to save memory.
		const nextBufferStart = this.#pendingSliceStart

		this.#log("Compressing buffer", { nextBufferStart })
		this.#controller.compress(nextBufferStart)

		// After compress, the buffer coordinate space has shifted — rebase the scan cursors.
		// Quote state (`#insideQuotes`) is positionless and survives as-is.
		this.#pendingSliceStart = 0
		this.#searchCursor = Math.max(0, this.#searchCursor - nextBufferStart)

		while ((!this.#lastReadResult || !this.#lastReadResult.done) && this.#indices.byteLength < this.#highWaterMark) {
			await this.#read()
			this.#search()
		}
	}

	/** Signal the underlying chunk reader to stop, destroying an owned read stream (closing its fd). */
	async #closeReader(): Promise<void> {
		try {
			await this.#chunkReader.return?.()
		} catch {
			// The reader may already be closed; ignore.
		}
	}

	async #finalize(): Promise<IteratorReturnResult<undefined>> {
		await this.#closeReader()

		if (this.#debug) {
			/**
			 * The total number of bytes we expect to be omitted from the buffer. This is derived from the number of of yields
			 * and the length of the delimiter.
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
		// Loop rather than recurse: a long run of skipped (empty or dropped) ranges would
		// otherwise grow the call stack one frame per skip and overflow.
		while (true) {
			if (this.#done || this.#yieldCount >= this.#yieldStopCount) return this.#finalize()

			if (this.#indices.size === 0) {
				await this.#fill()
			}

			// The first `#fill` may have read into EOF without entering the EOF branch (the branch only
			// triggers when fill is called with `done` already set). In that case the trailing tail
			// hasn't been enqueued yet, so call fill once more to let the EOF branch flush it.
			if (this.#lastReadResult?.done && this.#indices.size === 0 && !this.#done) {
				await this.#fill()
			}

			const currentByteRange = this.#indices.dequeue()

			if (!currentByteRange) {
				this.#done = true

				return this.#finalize()
			}

			const [start, end] = currentByteRange

			const slice = this.#controller.subarray(start, end)

			if (slice.length === 0 && this.#skipEmpty) {
				continue
			}

			this.#yieldCount++

			if (this.#yieldCount <= this.#yieldDropCount) {
				continue
			}

			this.#yieldedByteLength += end - start

			return {
				value: slice as unknown as R,
				done: false,
			}
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
	 * Compute delimiter-aligned `[start, end)` byte ranges dividing `source` into up to `concurrency` segments. The
	 * boundary primitive for parallel parsing — hand each range to a worker (with its own handle). See
	 * {@linkcode asManyWorkers} for the turnkey worker version.
	 */
	public static segments(source: AsyncDataResource, options: SegmentOptions): Promise<ByteRange[]> {
		return computeSegments(source, options)
	}

	/**
	 * Split `source` into delimiter-aligned segments and return one {@linkcode AsyncSpliterator} per segment. All share
	 * the event loop (no worker threads) — for moderate jobs or to overlap I/O. Returns at most `concurrency` instances.
	 *
	 * @param source - The data resource to read from.
	 * @param options - Delimiter, desired concurrency, and optional probe size.
	 *
	 * @returns One `AsyncSpliterator` per non-empty segment, possibly fewer than `concurrency`.
	 */
	public static async asMany(source: AsyncDataResource, options: SegmentOptions): Promise<AsyncSpliterator[]> {
		const { createChunkIterator } = await import("spliterator/node/fs")
		const segments = await computeSegments(source, options)

		return Promise.all(
			segments.map(async ([start, end]) => {
				// `end` is exclusive here; createChunkIterator's `end` is inclusive.
				const chunkIterator = await createChunkIterator(source, { start, end: end - 1 })

				return new AsyncSpliterator(chunkIterator, { delimiter: options.delimiter, autoDispose: true })
			})
		)
	}

	/**
	 * Parse `source` across worker threads. Each worker owns a handle to a delimiter-aligned segment, runs the `worker`
	 * handler module per record, and streams results back to the main thread as one merged async iterator — for a
	 * single-thread writer. Results interleave across segments.
	 *
	 * The handler returns a value (structured-cloned back), a `Uint8Array` (transferred zero-copy), or `undefined` (the
	 * record is skipped). The handler module's top-level code runs once per worker — load models/handles there.
	 *
	 * @param source A file path or URL (file handles cannot cross threads → `TypeError` otherwise).
	 * @param options Handler module, delimiter, concurrency, and batching/backpressure tuning.
	 */
	public static asManyWorkers<R = unknown>(
		source: AsyncDataResource,
		options: AsManyWorkersOptions
	): AsyncIterableIterator<R> {
		// Validate eagerly so callers fail fast (the generator body is otherwise lazy until consumed).
		if (typeof source !== "string" && !(source instanceof URL)) {
			throw new TypeError("asManyWorkers requires a file path or URL — file handles cannot cross threads.")
		}

		return runSegmentWorkers<R>(source, options)
	}
}
