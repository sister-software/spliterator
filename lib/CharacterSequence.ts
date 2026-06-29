/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import type { ByteRange } from "./shared.js"
import {
	loadWasmModule,
	WASM_MAX_RESULTS,
	WASM_THRESHOLD,
	type MatchResult,
	type WasmDelimiterScanner,
	type WasmMemory,
} from "./wasm_module.js"

export function isArrayLike<T>(input: unknown): input is ArrayLike<T> {
	return Boolean(input && typeof input === "object" && "length" in input)
}

export type CharacterSequenceInput = number | string | DataView | ArrayBuffer | Buffer | Iterable<number>

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
			if (isArrayLike(input)) return input
			if (Symbol.iterator in input) return Uint8Array.from(input)
			throw new TypeError(`Invalid delimiter type.`)
		default:
			throw new TypeError(`Invalid delimiter type.`)
	}
}

function ensureWasmCapacity(memory: WasmMemory, required: number): void {
	if (required <= memory.buffer.byteLength) return
	const pages = Math.ceil((required - memory.buffer.byteLength) / 65536)
	memory.grow(pages)
}

/** Round `offset` up to the next multiple of 4 — `Int32Array` views require a 4-byte-aligned base. */
function alignTo4(offset: number): number {
	return Math.ceil(offset / 4) * 4
}

export class CharacterSequence extends Uint8Array {
	#skipIndex: number[]

	static #wasmScanner: WasmDelimiterScanner | null | undefined
	static #wasmHaystack: Uint8Array | null = null
	static #wasmPatternOffset = 0
	static #wasmReadyPromise: Promise<WasmDelimiterScanner | null> | undefined

	static #loadWasm(): Promise<WasmDelimiterScanner | null> {
		if (CharacterSequence.#wasmReadyPromise === undefined) {
			// Reflect "load in progress" synchronously so search()'s fast path stops
			// re-triggering loads on every call while the module compiles.
			if (CharacterSequence.#wasmScanner === undefined) CharacterSequence.#wasmScanner = null

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
	 * Resolve once the WASM SIMD scanner has finished loading, yielding whether it is active.
	 *
	 * The module loads asynchronously, so synchronous callers (`Spliterator.fromSync`, `CSVSpliterator.from`) that run to
	 * completion in a single tick would otherwise always fall back to the JS scanner. Await this first to opt into SIMD
	 * acceleration.
	 */
	public static whenReady(): Promise<boolean> {
		return CharacterSequence.#loadWasm().then((mod) => mod !== null)
	}

	public search(haystack: Uint8Array, start: number = 0, end: number = haystack.length): number {
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
				// Cache the *entire* haystack at offset 0 (so WASM byte `i` === `haystack[i]`),
				// keyed by identity. This keeps repeated searches over the same source (the
				// Spliterator fill loop) copy-free while staying correct for any start/end — the
				// previous "copy [start,end)" scheme mis-mapped offsets when start !== 0 and
				// silently ignored a shrinking `end`.
				if (haystack !== CharacterSequence.#wasmHaystack) {
					const fullLen = haystack.length
					const totalNeeded = fullLen + sequenceLength
					ensureWasmCapacity(wasm.memory, totalNeeded)
					const buffer = new Uint8Array(wasm.memory.buffer, 0, totalNeeded)
					buffer.set(haystack, 0)
					buffer.set(this, fullLen)
					CharacterSequence.#wasmHaystack = haystack
					CharacterSequence.#wasmPatternOffset = fullLen
				}

				const result = wasm.findDelimiter(start, end - start, CharacterSequence.#wasmPatternOffset, sequenceLength)

				return result >= 0 ? start + result : -1
			}

			if (CharacterSequence.#wasmScanner === undefined) CharacterSequence.#ensureWasm()
		}

		CharacterSequence.#wasmHaystack = null
		let startIndex = start

		while (startIndex <= end - sequenceLength) {
			let lastIndex = sequenceLength - 1

			while (lastIndex >= 0 && this[lastIndex] === haystack[startIndex + lastIndex]) lastIndex--

			if (lastIndex < 0) return startIndex
			startIndex += this.#skipIndex[haystack[startIndex + sequenceLength - 1]!]!
		}

		return -1
	}

	public searchAll(haystack: Uint8Array, start: number = 0, end: number = haystack.length): ByteRange[] {
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
				// We just overwrote offset 0; any haystack search() cached there is now stale.
				CharacterSequence.#wasmHaystack = null

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

				for (let i = 0; i < count; i++) ranges.push([start + rv[i * 2]!, start + rv[i * 2 + 1]!])

				// A full results buffer means the scan may have hit the cap and dropped
				// trailing delimiters; fall back to the uncapped JS scan rather than truncate.
				if (count < WASM_MAX_RESULTS) return ranges
			}

			if (CharacterSequence.#wasmScanner === undefined) CharacterSequence.#ensureWasm()
		}

		const ranges: ByteRange[] = []
		let searchStart = start,
			rangeStart = start

		while (searchStart <= end - sequenceLength) {
			let lastIndex = sequenceLength - 1

			while (lastIndex >= 0 && this[lastIndex] === haystack[searchStart + lastIndex]) lastIndex--

			if (lastIndex < 0) {
				ranges.push([rangeStart, searchStart])
				searchStart += sequenceLength
				rangeStart = searchStart
				continue
			}
			searchStart += this.#skipIndex[haystack[searchStart + sequenceLength - 1]!]!
		}

		if (rangeStart <= end) ranges.push([rangeStart, end])

		return ranges
	}

	/**
	 * Scan for two patterns simultaneously (delimiter + quote) for CSV parsing.
	 *
	 * Returns sorted MatchResult[] with patternId 0=delimiter, 1=quote. Uses WASM SIMD double-scan when available; JS
	 * fallback otherwise.
	 */
	public searchMatches(
		haystack: Uint8Array,
		quotePattern: Uint8Array,
		start: number = 0,
		end: number = haystack.length
	): MatchResult[] {
		const delimiterLen = this.length
		const quoteLen = quotePattern.length
		const haystackLen = end - start

		if (delimiterLen === 0 || haystackLen === 0) return []

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
			// We just overwrote offset 0; any haystack search() cached there is now stale.
			CharacterSequence.#wasmHaystack = null

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

			for (let i = 0; i < count; i++) matches.push({ offset: start + rv[i * 2]!, patternId: rv[i * 2 + 1]! })

			// A full results buffer means the scan may have hit the cap and dropped
			// trailing matches; fall back to the uncapped JS scan rather than truncate.
			if (count < WASM_MAX_RESULTS) return matches
		}

		if (CharacterSequence.#wasmScanner === undefined) CharacterSequence.#ensureWasm()

		// JS fallback: scan both patterns independently and merge in offset order. Both
		// searches honour `end` exclusivity and handle multi-byte patterns (the quote is
		// wrapped in a CharacterSequence so it isn't limited to a single byte).
		const matches: MatchResult[] = []
		const quoteSeq = new CharacterSequence(quotePattern)
		let searchStart = start

		while (searchStart <= end) {
			const delimIdx = this.search(haystack, searchStart, end)
			const quoteIdx = quoteSeq.search(haystack, searchStart, end)

			if (delimIdx < 0 && quoteIdx < 0) break

			if (delimIdx >= 0 && (quoteIdx < 0 || delimIdx <= quoteIdx)) {
				matches.push({ offset: delimIdx, patternId: 0 })
				searchStart = delimIdx + delimiterLen
			} else {
				matches.push({ offset: quoteIdx, patternId: 1 })
				searchStart = quoteIdx + quoteLen
			}
		}

		return matches
	}

	public decode(encoding: string = "utf-8"): string {
		return new TextDecoder(encoding).decode(this)
	}

	constructor(input: CharacterSequenceInput = Delimiters.LineFeed) {
		const bytes = normalizeCharacterInput(input)
		super(bytes)
		this.#skipIndex = Array.from({ length: 256 }, () => this.length)

		for (let i = 0; i < this.length - 1; i++) this.#skipIndex[this[i]!] = this.length - 1 - i
	}
}
