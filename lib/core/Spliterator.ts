/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

import { loadNodeFs } from "../internal/node-modules.js"
import {
	isFileHandleLike,
	isPathBuilderLike,
	type AsyncChunkIterator,
	type AsyncDataResource,
	type ByteRange,
} from "../internal/shared.js"
// oxlint-disable-next-line unicorn/prefer-export-from
import { AsyncSpliterator, type AsyncSpliteratorInit, type SpliteratorInit } from "./AsyncSpliterator.js"
import {
	CharacterSequence,
	Delimiters,
	normalizeCharacterInput,
	type CharacterSequenceInput,
} from "./CharacterSequence.js"
import { IndexQueue } from "./IndexQueue.js"

export { AsyncSpliterator }

export type { AsyncSpliteratorInit, SpliteratorInit }

/**
 * Bytes staged into the SIMD kernel per quote-aware scan call. Large enough that the copy is a small share of the scan,
 * small enough that a source of any size stays bounded per call.
 */
const QUOTE_SCAN_WINDOW = 64 * 1024

/**
 * Bytes handed to `searchAll` per plain multi-byte scan call. Each call stages its window into the SIMD kernel once,
 * where a per-row `search` would stage the remainder of the source on every row.
 */
const MULTI_BYTE_SCAN_WINDOW = 64 * 1024

/**
 * A byte stream delimiting iterator.
 */
export class Spliterator<R extends Uint8Array | DataView | ArrayBuffer = Uint8Array>
	implements IterableIterator<R>, Disposable
{
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
	public static fromAsync = AsyncSpliterator.from.bind(AsyncSpliterator)

	/**
	 * Create a spliterator from an iterable resource such as a **buffer, array, or string**.
	 *
	 * @param source - The data resource to read from.
	 * @param init - The initialization options for the generator.
	 */
	public static fromSync<T extends CharacterSequenceInput>(source: T, init: SpliteratorInit = {}): Spliterator {
		return new Spliterator(normalizeCharacterInput(source), init)
	}

	/**
	 * Create a spliterator from an iterable resource such as a **buffer or array**.
	 *
	 * @param source - The data resource to read from.
	 * @param init - The initialization options for the generator.
	 * @see {@linkcode Spliterator.fromSync} to ensure synchronous operation for string inputs.
	 */
	public static from(source: DataView | ArrayBuffer | Buffer | Iterable<number>, init?: SpliteratorInit): Spliterator
	/**
	 * Create a new delimited generator from an **asynchronous byte stream**.
	 *
	 * @param source - The data resource to read from.
	 * @param init - The initialization options for the generator.
	 *
	 * @returns A new generator instance, yielding byte ranges.
	 */
	public static from(source: AsyncChunkIterator, init?: AsyncSpliteratorInit): AsyncSpliterator
	/**
	 * Create a new delimited generator from a resource such as a **file handle or URL**.
	 *
	 * @param source - The data resource to read from.
	 * @param init - The initialization options for the generator.
	 *
	 * @returns A new generator instance, yielding byte ranges.
	 * @see {@linkcode Spliterator.fromSync} to ensure synchronous operation for string inputs.
	 */
	public static from(source: AsyncDataResource, init?: AsyncSpliteratorInit): Promise<AsyncSpliterator>
	/**
	 * Create a new delimited generator from a resource such as a **file handle, URL, or byte stream**.
	 *
	 * @param source - The data resource to read from.
	 * @param init - The initialization options for the generator.
	 *
	 * @returns A new generator instance, yielding byte ranges.
	 * @see {@linkcode Spliterator.fromSync} to ensure synchronous operation for string inputs.
	 */
	public static from(
		source: CharacterSequenceInput | AsyncDataResource | AsyncChunkIterator,
		init?: SpliteratorInit & AsyncSpliteratorInit
	): Spliterator | AsyncSpliterator | Promise<AsyncSpliterator>
	public static from(
		source: CharacterSequenceInput | AsyncDataResource | AsyncChunkIterator,
		init: SpliteratorInit & AsyncSpliteratorInit = {}
	): Spliterator | AsyncSpliterator | Promise<AsyncSpliterator> {
		if (typeof source === "object" && Symbol.asyncIterator in source) {
			return new AsyncSpliterator(source, init)
		}

		if (isPathBuilderLike(source) || source instanceof URL || isFileHandleLike(source)) {
			return loadNodeFs().then(async ({ createChunkIterator }) => {
				let chunkIterator: AsyncChunkIterator

				try {
					chunkIterator = await createChunkIterator(source, {
						highWaterMark: init.highWaterMark,
					})
				} catch (error) {
					if (isPathBuilderLike(source) || source instanceof URL) {
						const wrapped = new Error(
							"`Spliterator.from` was called with an invalid async data resource. Did you mean to use `Spliterator.fromSync`?"
						)

						wrapped.cause = error

						throw wrapped
					}

					throw error
				}

				return new AsyncSpliterator(chunkIterator, init)
			})
		}

		return new Spliterator(normalizeCharacterInput(source), init)
	}

	/**
	 * Count delimiter occurrences without materialising the split slices.
	 *
	 * This has `wc -l` semantics for the default line-feed delimiter: a final unterminated record does not add to the
	 * count. Quote-aware mode excludes delimiters inside quoted regions.
	 *
	 * @see {@linkcode countAsync} for files and other asynchronous sources.
	 */
	public static count(source: CharacterSequenceInput, init: SpliteratorInit = {}): number {
		// `skipEmpty: false` makes the iterator expose its unconditional final tail. Every delimiter produces one range
		// before that tail, so subtracting it counts matches while retaining the engine's quote and delimiter semantics.
		const slices = new Spliterator(normalizeCharacterInput(source), {
			...init,
			drop: 0,
			skipEmpty: false,
			take: Infinity,
		})

		let count = -1

		for (const _slice of slices) {
			count++
		}

		return count
	}

	/**
	 * Asynchronously count delimiter occurrences in a file or byte stream.
	 *
	 * @see {@linkcode count} for synchronous byte sources.
	 */
	public static countAsync = AsyncSpliterator.count.bind(AsyncSpliterator)

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
	 * Dispose of the spliterator, releasing its queued ranges. The source is the caller's buffer and is left alone.
	 */
	public [Symbol.dispose](): void {
		this.#indices.clear()
	}

	constructor(source: Uint8Array, init: SpliteratorInit = {}) {
		this.#source = source

		this.#needle = new CharacterSequence(init.delimiter)

		this.#readPosition = Math.min(Math.max(0, init.position ?? 0), source.byteLength)
		this.#startPosition = this.#readPosition
		this.#scanCursor = this.#readPosition

		this.#highWaterMark = Math.max(this.#needle.length * 4, 4096)

		this.#yieldDropCount = Math.max(0, init.drop ?? 0)
		this.#yieldStopCount = Math.max(init.take ?? Infinity, 0) + this.#yieldDropCount
		this.#yieldByteEstimate = this.#source.byteLength - this.#readPosition

		this.#skipEmpty = init.skipEmpty ?? true
		this.#enableQuoteHandling = init.enableQuoteHandling ?? false
		this.#crlf = init.crlf ?? false

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
	 * Indices are relative to the buffer rather than the file.
	 *
	 * This means that the start index is always 0, and the end index is the byte length of the buffer.
	 */
	readonly #indices = new IndexQueue()

	/**
	 * The byte sequence to search for, i.e. an encoded delimiter.
	 */
	readonly #needle: CharacterSequence

	/**
	 * Where iteration began, clamped to the source. A source that yields no range is emitted from here, not from zero.
	 */
	readonly #startPosition: number

	/**
	 * The byte sequence for a double quote.
	 */
	readonly #doubleQuoteSequence: CharacterSequence = new CharacterSequence('"')
	readonly #enableQuoteHandling: boolean

	/**
	 * Whether to trim a carriage return immediately preceding each delimiter match.
	 */
	readonly #crlf: boolean

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
	 * How far the quote-aware scan has read. It runs ahead of {@linkcode #readPosition} while a record is open, because
	 * the kernel is bounded and may return mid-record; the record then resumes from here with {@linkcode #insideQuotes}
	 * carried. Equal to `#readPosition` outside quote mode.
	 */
	#scanCursor: number

	/**
	 * Whether the quote-aware scan stopped inside a double-quoted region.
	 */
	#insideQuotes = false

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

	#log: (...args: unknown[]) => void

	#finalize(): IteratorReturnResult<undefined> {
		if (this.#debug) {
			/**
			 * The total number of bytes we expect to be omitted from the buffer. This is derived from the number of of yields
			 * and the length of the delimiter.
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

		if (this.#readPosition < sourceByteLength) {
			this.#indices.enqueue([this.#readPosition, sourceByteLength])
		} else if (this.#yieldCount === 0 && lastByteRange === undefined) {
			// The scan found and yielded no range, such as for an empty source. Emit the remainder from
			// the starting position as a single field. A run of all-empty fields that `skipEmpty`
			// dropped has a defined `lastByteRange`, so it falls through to the trailing-delimiter
			// case instead of resurfacing the entire delimiter run as one (non-empty) row.
			this.#indices.enqueue([this.#startPosition, sourceByteLength])
		} else {
			// Emit an empty field for a trailing delimiter (match String.split). `#fill` always
			// leaves the tail after the last consumed delimiter to this method, in both the plain
			// and quote-aware paths — a source ending exactly on a delimiter has an empty tail.
			const trailingDelimPos = sourceByteLength - this.#needle.length

			if (trailingDelimPos >= 0 && this.#needle.search(this.#source, trailingDelimPos) !== -1) {
				this.#indices.enqueue([sourceByteLength, sourceByteLength])
			}
		}

		this.#done = true
	}

	/**
	 * Trim a carriage return immediately preceding a delimiter match, when {@linkcode SpliteratorInit.crlf} is set.
	 * Affects only the emitted range's end — `#readPosition` advancement always uses the raw match offset.
	 */
	#trimEnd(start: number, end: number): number {
		if (this.#crlf && end > start && this.#source[end - 1] === Delimiters.CarriageReturn) {
			return end - 1
		}

		return end
	}

	/**
	 * The plain multi-byte path: one `searchAll` per window, so the kernel stages each byte once. `searchAll` returns the
	 * records it completed plus the unterminated tail, which the next window rescans from, so a delimiter straddling the
	 * window edge is found then. A record longer than the window is resolved with one unbounded `search` from its start.
	 */
	#fillMultiByte(): void {
		const sourceByteLength = this.#source.byteLength
		const needleLength = this.#needle.length

		while (this.#readPosition < sourceByteLength && this.#indices.byteLength < this.#highWaterMark) {
			const windowEnd = Math.min(sourceByteLength, this.#readPosition + MULTI_BYTE_SCAN_WINDOW)
			const ranges = this.#needle.searchAll(this.#source, this.#readPosition, windowEnd, true)
			// The last range is the tail after the final delimiter in the window; `#drain` owns it at the end of the source.
			const completed = ranges.length - 1

			if (completed === 0) {
				if (windowEnd >= sourceByteLength) return

				const delimiterIndex = this.#needle.search(this.#source, this.#readPosition)

				if (delimiterIndex === -1) return

				this.#indices.enqueue([this.#readPosition, this.#trimEnd(this.#readPosition, delimiterIndex)])
				this.#readPosition = delimiterIndex + needleLength
				this.#scanCursor = this.#readPosition

				continue
			}

			for (let i = 0; i < completed; i++) {
				const [start, end] = ranges[i]!

				this.#indices.enqueue([start, this.#trimEnd(start, end)])
				this.#readPosition = end + needleLength
			}

			this.#scanCursor = this.#readPosition
		}
	}

	/**
	 * Fill the buffer with data and search for delimiters.
	 */
	#fill(): void {
		const sourceByteLength = this.#source.byteLength

		if (!this.#enableQuoteHandling) {
			if (this.#needle.length > 1) {
				this.#fillMultiByte()

				return
			}

			while (this.#readPosition < sourceByteLength && this.#indices.byteLength < this.#highWaterMark) {
				const delimiterIndex = this.#needle.search(this.#source, this.#readPosition)

				if (delimiterIndex === -1) return

				this.#indices.enqueue([this.#readPosition, this.#trimEnd(this.#readPosition, delimiterIndex)])
				this.#readPosition = delimiterIndex + this.#needle.length
				this.#scanCursor = this.#readPosition
			}

			return
		}

		// Quote-aware path: a delimiter inside a double-quoted region does not split, and the
		// emitted slices keep their quotes verbatim — stripping and `""` unescaping belong to the
		// consumer (CSVSpliterator does both). The tail after the last consumed delimiter is left
		// to `#drain`, same as the plain path.
		//
		// The bounded WASM kernel carries quote state and emits ranges directly, resuming from
		// `#scanCursor` when its result batch fills. It is what keeps a large quoted source from
		// being scanned whole through `searchMatches`: one match object per delimiter, and above
		// the kernel's result cap that call falls back to the JavaScript scanner. Measured on a
		// 1M-row CSV, this path went from 969ms to the plain path's ~85ms.
		//
		// The kernel stages `[scanCursor, end)` into WASM memory on every call, so `end` is a window
		// rather than the end of the source: handing it the whole remainder copied up to the full
		// source per fill, thousands of times over a large one, and cost more than the scan it
		// replaced. The record open at a window's edge resumes through the carried state.
		while (this.#scanCursor < sourceByteLength && this.#indices.byteLength < this.#highWaterMark) {
			const scan = this.#needle.scanRanges(
				this.#source,
				{
					scanCursor: this.#scanCursor,
					pendingSliceStart: this.#readPosition,
					insideQuotes: this.#insideQuotes,
				},
				Math.min(sourceByteLength, this.#scanCursor + QUOTE_SCAN_WINDOW),
				this.#doubleQuoteSequence
			)

			if (!scan) break

			for (let i = 0; i < scan.count; i++) {
				const start = scan.ranges[i * 2]!

				this.#indices.enqueue([start, this.#trimEnd(start, scan.ranges[i * 2 + 1]!)])
			}

			const previousCursor = this.#scanCursor
			this.#scanCursor = scan.scanCursor
			this.#readPosition = scan.pendingSliceStart
			this.#insideQuotes = scan.insideQuotes

			if (this.#scanCursor >= sourceByteLength) return

			if (this.#scanCursor <= previousCursor) break
		}

		if (this.#scanCursor >= sourceByteLength || this.#indices.byteLength >= this.#highWaterMark) return

		// The JavaScript fallback, for a source below the kernel's threshold or a scanner that has
		// not loaded. It resumes from wherever the kernel left off, with its quote state, and scans
		// the rest of the source in one pass.
		const matches = this.#needle.searchMatches(
			this.#source,
			this.#doubleQuoteSequence,
			this.#scanCursor,
			sourceByteLength
		)

		let sliceStart = this.#readPosition
		let insideQuotes = this.#insideQuotes

		for (const match of matches) {
			if (match.patternId === 1) {
				insideQuotes = !insideQuotes

				continue
			}

			// A delimiter inside quotes is part of the slice, so skip it.
			if (insideQuotes) continue

			this.#indices.enqueue([sliceStart, this.#trimEnd(sliceStart, match.offset)])
			sliceStart = match.offset + this.#needle.length
		}

		// Everything has been scanned; the tail after the last consumed delimiter (an unclosed
		// quote swallows the rest of the source) is left to `#drain`.
		this.#scanCursor = sourceByteLength
		this.#readPosition = sliceStart
		this.#insideQuotes = insideQuotes
	}

	//#endregion

	//#region Iterator Methods

	/**
	 * Read the next byte range from the source.
	 */
	public next(): IteratorResult<R> {
		// Loop rather than recurse: a long run of skipped (empty or dropped) ranges would
		// otherwise grow the call stack one frame per skip and overflow.
		while (true) {
			if (this.#done || this.#yieldCount >= this.#yieldStopCount) return this.#finalize()

			if (!this.#indices.size) {
				this.#fill()
			}

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

			if (!slice.length && this.#skipEmpty) {
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
