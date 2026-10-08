/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

import type { ByteRange, PathBuilderLike } from "../internal/shared.js"
import {
	CELL_RESULT_HEADER,
	CELL_RESULT_STRIDE,
	loadWasmModule,
	WASM_MAX_RESULTS,
	WASM_THRESHOLD,
	type MatchResult,
	type WasmCellScanResult,
	type WasmDelimiterScanner,
	type WasmMemory,
	type WasmRangeScanResult,
} from "./wasm_module.js"

export function isArrayLike<T>(input: unknown): input is ArrayLike<T> {
	return Boolean(input && typeof input === "object" && "length" in input)
}

export type CharacterSequenceInput =
	| number
	| string
	| DataView
	| ArrayBuffer
	| Buffer
	| Iterable<number>
	| PathBuilderLike

export const Delimiters = {
	Null: 0,
	LineFeed: 10,
	CarriageReturn: 13,
	Comma: 44,
	Tab: 9,
	Space: 32,
	One: 49,
	Zero: 48,
	DoubleQuote: 34,
	RecordSeparator: 30,
	Pipe: 124,
} as const satisfies Record<string, number>

export const VisibleDelimiterMap = new Map<number, string>([
	[Delimiters.LineFeed, "\u2424"],
	[Delimiters.CarriageReturn, "\u240D"],
	[Delimiters.Comma, "-"],
	[Delimiters.Tab, "\u2409"],
	[Delimiters.Space, "\u2420"],
	[Delimiters.DoubleQuote, '"'],
	[Delimiters.RecordSeparator, "\u241E"],
	[Delimiters.Null, "\u2400"],
])

export function debugAsVisibleCharacters(delimiter: Uint8Array): string {
	return Array.from(delimiter)
		.map((c) => VisibleDelimiterMap.get(c) ?? String.fromCharCode(c))
		.join("")
}

const encoder = new TextEncoder()

export function normalizeCharacterInput(input: CharacterSequenceInput): Uint8Array {
	switch (typeof input) {
		case "number":
			if (!Number.isInteger(input)) throw new TypeError(`Numeric delimiters must be integers.`)
			return Uint8Array.from([input])
		case "string":
			return encoder.encode(input)
		case "object":
			// Typed arrays and buffers are adopted by reference where possible. A multi-megabyte
			// haystack must not be copied on the way in. `ArrayBuffer` and `DataView` are declared
			// inputs and previously threw: neither carries `length`, and neither is iterable.
			if (input instanceof Uint8Array) return input
			if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
			if (input instanceof ArrayBuffer) return new Uint8Array(input)
			// A plain array-like (`number[]`) is a different type from Uint8Array. Copy it rather
			// than returning a value whose `search` method would index a boxed array.
			if (isArrayLike<number>(input)) return Uint8Array.from(input)
			if (Symbol.iterator in input) return Uint8Array.from(input)
			throw new TypeError(`Invalid delimiter type.`)
		default:
			throw new TypeError(`Invalid delimiter type.`)
	}
}

function ensureWasmCapacity(memory: WasmMemory, required: number): void {
	if (required <= memory.buffer.byteLength) return
	const pages = Math.ceil((required - memory.buffer.byteLength) / 65_536)
	memory.grow(pages)
}

/**
 * Round `offset` up to the next multiple of 4 — `Int32Array` views require a 4-byte-aligned base.
 */
function alignTo4(offset: number): number {
	return Math.ceil(offset / 4) * 4
}

export interface CellScanState {
	/**
	 * Absolute byte offset to resume from.
	 */
	scanCursor: number
	/**
	 * Absolute UTF-16 units at `scanCursor`.
	 */
	units: number
	insideQuotes: boolean
	/**
	 * Absolute UTF-16 start of the open cell.
	 */
	cellStartUnits: number
	cellHasQuote: boolean
}

export interface CellScanOptions {
	/**
	 * One ASCII byte.
	 */
	rowDelimiter: number
	/**
	 * One ASCII byte.
	 */
	columnDelimiter: number
	/**
	 * One byte, or -1 for no quote handling.
	 */
	quote: number
	crlf: boolean
	/**
	 * Default `WASM_MAX_RESULTS`.
	 */
	maxCells?: number
}

export class CharacterSequence extends Uint8Array {
	#skipIndex: number[]

	static #wasmScanner: WasmDelimiterScanner | null | undefined
	static #wasmReadyPromise: Promise<WasmDelimiterScanner | null> | undefined

	static #loadWasm(): Promise<WasmDelimiterScanner | null> {
		if (CharacterSequence.#wasmReadyPromise === undefined) {
			// Reflect "load in progress" synchronously so search()'s fast path stops
			// re-triggering loads on every call while the module compiles.
			if (CharacterSequence.#wasmScanner === undefined) {
				CharacterSequence.#wasmScanner = null
			}

			CharacterSequence.#wasmReadyPromise = loadWasmModule().then((mod) => {
				CharacterSequence.#wasmScanner = mod

				return mod
			})
		}

		return CharacterSequence.#wasmReadyPromise
	}

	static #ensureWasm(): void {
		void CharacterSequence.#loadWasm()
	}

	/**
	 * Whether the SIMD scanner is loaded right now. A synchronous caller uses this to choose a path without awaiting.
	 */
	public static hasScanner(): boolean {
		return Boolean(CharacterSequence.#wasmScanner)
	}

	/**
	 * Resolve once the WASM SIMD scanner has finished loading, yielding whether it is active.
	 *
	 * The module loads asynchronously, so synchronous callers (`Spliterator.fromSync`, `CSVSpliterator.from`) that run to
	 * completion in a single tick would otherwise always fall back to the JS scanner. Await this first to opt into SIMD
	 * acceleration.
	 */
	public static whenReady(): Promise<boolean> {
		return CharacterSequence.#loadWasm().then((mod) => mod !== null)
	}

	public search(haystack: Uint8Array, start = 0, end: number = haystack.length): number {
		const sequenceLength = this.length

		// Single-byte delimiters (newline, comma, tab — the common case) are far faster via
		// the native indexOf than the per-match Boyer-Moore-Horspool loop below. indexOf has
		// no end bound, so clamp the result to keep `end` exclusive.
		if (sequenceLength === 1) {
			const index = haystack.indexOf(this[0]!, start)

			return index !== -1 && index < end ? index : -1
		}

		if (sequenceLength > 1 && end - start >= WASM_THRESHOLD) {
			const wasm = CharacterSequence.#wasmScanner

			if (wasm) {
				// `[start, end)` is staged on every call. An identity-keyed cache of the whole haystack was tried and
				// scanned stale bytes: `BufferController` appends into the same `Uint8Array` in place, so the same
				// object carries new contents from one fill to the next. Callers that search many times over one
				// buffer use `searchAll` over a window instead, which stages once per window.
				const haystackLen = end - start
				const totalNeeded = haystackLen + sequenceLength
				ensureWasmCapacity(wasm.memory, totalNeeded)
				const buffer = new Uint8Array(wasm.memory.buffer, 0, totalNeeded)
				buffer.set(haystack.subarray(start, end), 0)
				buffer.set(this, haystackLen)

				const result = wasm.findDelimiter(0, haystackLen, haystackLen, sequenceLength)

				return result >= 0 ? start + result : -1
			}

			if (CharacterSequence.#wasmScanner === undefined) {
				CharacterSequence.#ensureWasm()
			}
		}

		let startIndex = start

		while (startIndex <= end - sequenceLength) {
			let lastIndex = sequenceLength - 1

			while (lastIndex >= 0 && this[lastIndex] === haystack[startIndex + lastIndex]) {
				lastIndex--
			}

			if (lastIndex < 0) return startIndex
			startIndex += this.#skipIndex[haystack[startIndex + sequenceLength - 1]!]!
		}

		return -1
	}

	/**
	 * Every delimited range in `[start, end)`: the completed records, then the unterminated tail after the last delimiter
	 * (empty when the haystack ends on one).
	 *
	 * With `allowPartial`, a window denser than the kernel's result capacity returns the records it completed plus the
	 * tail from the last consumed delimiter, instead of rescanning the window in JavaScript. A caller that resumes from
	 * the tail's start, as the engines' fill loops do, loses nothing and pays one kernel pass per window.
	 */
	public searchAll(haystack: Uint8Array, start = 0, end = haystack.length, allowPartial = false): ByteRange[] {
		const sequenceLength = this.length
		const haystackLen = end - start

		if (sequenceLength >= 1 && haystackLen >= WASM_THRESHOLD) {
			const wasm = CharacterSequence.#wasmScanner

			if (wasm) {
				const resultsOffset = alignTo4(haystackLen + sequenceLength)
				const resultsSize = WASM_MAX_RESULTS * 2 * 4
				const totalNeeded = resultsOffset + resultsSize
				ensureWasmCapacity(wasm.memory, totalNeeded)
				const buffer = new Uint8Array(wasm.memory.buffer, 0, totalNeeded)
				buffer.set(haystack.subarray(start, end), 0)
				buffer.set(this, haystackLen)

				const count = wasm.findAllDelimiters(
					0,
					haystackLen,
					haystackLen,
					sequenceLength,
					resultsOffset,
					WASM_MAX_RESULTS
				)

				const rv = new Int32Array(wasm.memory.buffer, resultsOffset, count * 2)
				const ranges: ByteRange[] = []

				for (let i = 0; i < count; i++) {
					ranges.push([start + rv[i * 2]!, start + rv[i * 2 + 1]!])
				}

				// A full results buffer may indicate that trailing delimiters were dropped.
				// Use the uncapped JS scan instead of returning truncated results.
				if (count < WASM_MAX_RESULTS) return ranges

				if (allowPartial) {
					// A full buffer holds either `max` records, or `max - 1` records and the tail. A record is always
					// followed by its delimiter, so only the tail can end at `end`.
					const lastEnd = ranges.at(-1)![1]

					if (lastEnd !== end) {
						ranges.push([lastEnd + sequenceLength, end])
					}

					return ranges
				}
			}

			if (CharacterSequence.#wasmScanner === undefined) {
				CharacterSequence.#ensureWasm()
			}
		}

		const ranges: ByteRange[] = []

		let searchStart = start,
			rangeStart = start

		while (searchStart <= end - sequenceLength) {
			let lastIndex = sequenceLength - 1

			while (lastIndex >= 0 && this[lastIndex] === haystack[searchStart + lastIndex]) {
				lastIndex--
			}

			if (lastIndex < 0) {
				ranges.push([rangeStart, searchStart])
				searchStart += sequenceLength
				rangeStart = searchStart

				continue
			}

			searchStart += this.#skipIndex[haystack[searchStart + sequenceLength - 1]!]!
		}

		if (rangeStart <= end) {
			ranges.push([rangeStart, end])
		}

		return ranges
	}

	/**
	 * Scan completed ranges in one bounded, resumable WASM call.
	 *
	 * This is the low-allocation streaming primitive: unlike {@link searchMatches}, it carries quote state and range
	 * boundaries through the native scan and exposes the packed result view directly. The returned view aliases shared
	 * WASM memory and must be consumed before another scanner call.
	 *
	 * Only `[state.scanCursor, end)` is staged into WASM memory — re-staging the scanned prefix on every call is what
	 * made a record spanning many reads quadratic. Everything returned is in `haystack` coordinates regardless.
	 *
	 * `state.pendingSliceStart` must not exceed `state.scanCursor`; a record begins at or before the point scanning has
	 * reached. `AsyncSpliterator` maintains that across reads and buffer compression.
	 *
	 * Returns `null` when the SIMD module is unavailable, the delimiter/quote is not one byte, or the buffer is below the
	 * WASM threshold. Callers must retain their existing JavaScript path as the fallback.
	 */
	public scanRanges(
		haystack: Uint8Array,
		state: { scanCursor: number; pendingSliceStart: number; insideQuotes: boolean },
		end: number = haystack.length,
		quotePattern?: Uint8Array,
		maxRanges = WASM_MAX_RESULTS
	): WasmRangeScanResult | null {
		if (this.length !== 1 || (quotePattern && quotePattern.length !== 1) || end < WASM_THRESHOLD || maxRanges < 1) {
			return null
		}

		const wasm = CharacterSequence.#wasmScanner

		if (!wasm) {
			if (CharacterSequence.#wasmScanner === undefined) {
				CharacterSequence.#ensureWasm()
			}

			return null
		}

		// Stage only the bytes the kernel will actually read. It never dereferences below its
		// `scan_start` — `pending_slice_start` is written into emitted ranges, never used as a read
		// offset — so the already-scanned prefix is dead weight. Copying it anyway made a record
		// spanning many reads quadratic: 76GB staged for one 100MB quoted CSV field, once per read.
		const windowStart = Math.min(state.scanCursor, end)
		const windowLength = end - windowStart

		const resultsOffset = alignTo4(windowLength)
		const resultValueCount = 3 + maxRanges * 2
		const totalNeeded = resultsOffset + resultValueCount * Int32Array.BYTES_PER_ELEMENT

		ensureWasmCapacity(wasm.memory, totalNeeded)
		new Uint8Array(wasm.memory.buffer, 0, windowLength).set(haystack.subarray(windowStart, end))

		const count = wasm.scanDelimitedRanges(
			0,
			windowLength,
			0,
			// A record may have opened before this window. Window coordinates cannot represent that
			// start, so the kernel receives zero. The first emitted range receives the carried
			// absolute start below.
			0,
			this[0]!,
			quotePattern?.[0] ?? -1,
			state.insideQuotes ? 1 : 0,
			resultsOffset,
			maxRanges
		)

		const result = new Int32Array(wasm.memory.buffer, resultsOffset, 3 + count * 2)
		const ranges = result.subarray(3)

		// Rebase window coordinates back onto the buffer. The view aliases WASM memory and belongs to
		// this call, so it is edited in place rather than copied out.
		for (let i = count * 2 - 1; i >= 0; i--) {
			ranges[i] = ranges[i]! + windowStart
		}

		if (count > 0) {
			ranges[0] = state.pendingSliceStart
		}

		return {
			ranges,
			count,
			scanCursor: windowStart + result[0]!,
			// When the kernel emits no range, it echoes the zero input instead of the open record's
			// start. Keep the carried value in that case.
			pendingSliceStart: count > 0 ? windowStart + result[1]! : state.pendingSliceStart,
			insideQuotes: result[2] === 1,
		}
	}

	/**
	 * Scan CSV cells over `[state.scanCursor, end)` in one bounded kernel call, returning an owned batch rebased to
	 * absolute byte and UTF-16 offsets. The kernel counts UTF-16 units as it scans, which is what lets the caller slice a
	 * decoded string by these offsets without an ASCII gate; the decode must be `fatal` so the count is exact.
	 *
	 * The batch is copied out of WASM memory before returning, so a caller may hold it across further scans, including a
	 * nested parse run by user code while a row is being consumed.
	 *
	 * Returns `null` when the scanner is unavailable or the window is empty. Callers keep their own fallback.
	 */
	public static scanCells(
		haystack: Uint8Array,
		state: CellScanState,
		end: number,
		options: CellScanOptions
	): WasmCellScanResult | null {
		const windowStart = Math.min(state.scanCursor, end)
		const windowLength = end - windowStart

		if (windowLength <= 0) return null

		const wasm = CharacterSequence.#wasmScanner

		if (!wasm) {
			if (CharacterSequence.#wasmScanner === undefined) {
				CharacterSequence.#ensureWasm()
			}

			return null
		}

		const maxCells = options.maxCells ?? WASM_MAX_RESULTS
		const resultsOffset = alignTo4(windowLength)
		const resultValueCount = CELL_RESULT_HEADER + maxCells * CELL_RESULT_STRIDE
		const totalNeeded = resultsOffset + resultValueCount * Int32Array.BYTES_PER_ELEMENT

		ensureWasmCapacity(wasm.memory, totalNeeded)
		new Uint8Array(wasm.memory.buffer, 0, windowLength).set(haystack.subarray(windowStart, end))

		const previousByte = windowStart > 0 ? haystack[windowStart - 1]! : -1

		const count = wasm.scanCsvCells(
			0,
			windowLength,
			options.rowDelimiter,
			options.columnDelimiter,
			options.quote,
			options.crlf ? 1 : 0,
			state.insideQuotes ? 1 : 0,
			// Window-relative; negative when the open cell began before this window.
			state.cellStartUnits - state.units,
			state.cellHasQuote ? 1 : 0,
			previousByte,
			resultsOffset,
			maxCells
		)

		const block = new Int32Array(wasm.memory.buffer, resultsOffset, CELL_RESULT_HEADER + count * CELL_RESULT_STRIDE)
		// Copy: the view aliases shared memory that the next scanner call overwrites.
		const cells = block.slice(CELL_RESULT_HEADER)
		const unitBase = state.units

		for (let i = 0; i < count; i++) {
			cells[i * CELL_RESULT_STRIDE] = cells[i * CELL_RESULT_STRIDE]! + unitBase
			cells[i * CELL_RESULT_STRIDE + 1] = cells[i * CELL_RESULT_STRIDE + 1]! + unitBase
		}

		return {
			cells,
			count,
			scanCursor: windowStart + block[0]!,
			units: unitBase + block[1]!,
			insideQuotes: block[2] === 1,
			cellStartUnits: unitBase + block[3]!,
			cellHasQuote: block[4] === 1,
		}
	}

	/**
	 * Scan for two patterns simultaneously (delimiter + quote) for CSV parsing.
	 *
	 * Returns sorted MatchResult[] with patternId 0=delimiter and 1=quote. Uses WASM SIMD double-scan when available. The
	 * JS scanner is the fallback.
	 */
	public searchMatches(
		haystack: Uint8Array,
		quotePattern: Uint8Array,
		start = 0,
		end: number = haystack.length
	): MatchResult[] {
		const delimiterLen = this.length
		const quoteLen = quotePattern.length
		const haystackLen = end - start

		// An empty quote pattern would make the kernel report a match at `i32::MAX`.
		if (!delimiterLen || !quoteLen || !haystackLen) return []

		const wasm = CharacterSequence.#wasmScanner

		if (wasm && haystackLen >= WASM_THRESHOLD) {
			const patternsSize = delimiterLen + quoteLen
			const resultsOffset = alignTo4(haystackLen + patternsSize)
			const resultsSize = WASM_MAX_RESULTS * 2 * 4
			const totalNeeded = resultsOffset + resultsSize

			ensureWasmCapacity(wasm.memory, totalNeeded)
			const buffer = new Uint8Array(wasm.memory.buffer, 0, totalNeeded)
			buffer.set(haystack.subarray(start, end), 0)
			buffer.set(this, haystackLen)
			buffer.set(quotePattern, haystackLen + delimiterLen)

			const count = wasm.findAllMatches(
				0,
				haystackLen,
				haystackLen,
				delimiterLen,
				quoteLen,
				resultsOffset,
				WASM_MAX_RESULTS
			)

			const rv = new Int32Array(wasm.memory.buffer, resultsOffset, count * 2)
			const matches: MatchResult[] = []

			for (let i = 0; i < count; i++) {
				matches.push({ offset: start + rv[i * 2]!, patternId: rv[i * 2 + 1]! })
			}

			// A full results buffer may indicate that trailing matches were dropped.
			// Use the uncapped JS scan instead of returning truncated results.
			if (count < WASM_MAX_RESULTS) return matches
		}

		if (CharacterSequence.#wasmScanner === undefined) {
			CharacterSequence.#ensureWasm()
		}

		// JS fallback: scan both patterns independently and merge in offset order. Both
		// searches honour `end` exclusivity and handle multi-byte patterns (the quote is
		// wrapped in a CharacterSequence so it isn't limited to a single byte).
		//
		// Each pattern's next hit is carried across iterations and re-searched only once the
		// cursor has passed it. Re-searching both every iteration is quadratic: a `search` that
		// finds no match after scanning to `end`, and a source containing no
		// quote at all pays that whole scan once per delimiter. A `-1` is final for the rest of
		// the range and must never be re-searched.
		const matches: MatchResult[] = []
		const quoteSeq = CharacterSequence.asSequence(quotePattern)
		let searchStart = start
		let delimiterIndex = this.search(haystack, searchStart, end)
		let quoteIndex = quoteSeq.search(haystack, searchStart, end)

		while (delimiterIndex >= 0 || quoteIndex >= 0) {
			if (delimiterIndex >= 0 && (quoteIndex < 0 || delimiterIndex <= quoteIndex)) {
				matches.push({ offset: delimiterIndex, patternId: 0 })
				searchStart = delimiterIndex + delimiterLen
				delimiterIndex = this.search(haystack, searchStart, end)

				// Patterns longer than a byte can overlap, so a carried quote hit that the delimiter's
				// span just swallowed is stale. Single-byte patterns never enter this branch.
				if (quoteIndex >= 0 && quoteIndex < searchStart) {
					quoteIndex = quoteSeq.search(haystack, searchStart, end)
				}
			} else {
				matches.push({ offset: quoteIndex, patternId: 1 })
				searchStart = quoteIndex + quoteLen
				quoteIndex = quoteSeq.search(haystack, searchStart, end)

				if (delimiterIndex >= 0 && delimiterIndex < searchStart) {
					delimiterIndex = this.search(haystack, searchStart, end)
				}
			}
		}

		return matches
	}

	/**
	 * Adopt a pattern as a sequence, reusing it when it already is one.
	 *
	 * Constructing a sequence builds a 256-entry skip table, so wrapping unconditionally puts that allocation on every
	 * call of a per-row scan. Every in-tree caller of {@linkcode searchMatches} already holds a long-lived sequence for
	 * its quote pattern.
	 */
	public static asSequence(pattern: Uint8Array): CharacterSequence {
		return pattern instanceof CharacterSequence ? pattern : new CharacterSequence(pattern)
	}

	public decode(encoding = "utf8"): string {
		return new TextDecoder(encoding).decode(this)
	}

	/**
	 * `slice`, `subarray`, `map` and friends build plain `Uint8Array`s. The species default would call this constructor
	 * with a length, which it would read as a one-byte delimiter.
	 */
	static get [Symbol.species](): Uint8ArrayConstructor {
		return Uint8Array
	}

	constructor(input: CharacterSequenceInput = Delimiters.LineFeed) {
		const bytes = normalizeCharacterInput(input)

		if (!bytes.length) {
			throw new TypeError("A delimiter must be at least one byte. An empty delimiter would never advance.")
		}

		super(bytes)
		// `new Array(256).fill(…)` rather than `Array.from({length: 256}, …)` produces the same result without a
		// per-entry callback, and this runs for every sequence constructed.
		// oxlint-disable-next-line unicorn/no-new-array
		this.#skipIndex = new Array<number>(256).fill(this.length)

		for (let i = 0; i < this.length - 1; i++) {
			this.#skipIndex[this[i]!] = this.length - 1 - i
		}
	}
}
