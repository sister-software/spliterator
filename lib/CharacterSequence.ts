/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import {
	loadWasmModule,
	WASM_MAX_RESULTS,
	WASM_THRESHOLD,
	type MatchResult,
	type WasmDelimiterScanner,
	type WasmMemory,
} from "./wasm_module.js"

import type { ByteRange } from "./shared.js"

export function isArrayLike<T>(input: unknown): input is ArrayLike<T> {
	return Boolean(input && typeof input === "object" && "length" in input)
}

export type CharacterSequenceInput = number | string | DataView | ArrayBuffer | Buffer | Iterable<number>

export const Delimiters = {
	Null: 0, LineFeed: 10, CarriageReturn: 13, Comma: 44, Tab: 9, Space: 32,
	One: 49, Zero: 48, DoubleQuote: 34, RecordSeparator: 30, Pipe: 124,
} as const satisfies Record<string, number>

export const VisibleDelimiterMap = new Map<number, string>([
	[Delimiters.LineFeed, "\u2424"], [Delimiters.CarriageReturn, "\u240D"],
	[Delimiters.Comma, "-"], [Delimiters.Tab, "\u2409"], [Delimiters.Space, "\u2420"],
	[Delimiters.DoubleQuote, '"'], [Delimiters.RecordSeparator, "\u241E"], [Delimiters.Null, "\u2400"],
])

export function debugAsVisibleCharacters(delimiter: Uint8Array): string {
	return Array.from(delimiter).map((c) => VisibleDelimiterMap.get(c) ?? String.fromCharCode(c)).join("")
}

const encoder = new TextEncoder()

export function normalizeCharacterInput(input: CharacterSequenceInput): Uint8Array {
	switch (typeof input) {
		case "number":
			if (!Number.isInteger(input)) throw new TypeError(`Numeric delimiters must be integers.`)
			return Uint8Array.from([input])
		case "string": return encoder.encode(input)
		case "object":
			if (isArrayLike(input)) return input
			if (Symbol.iterator in input) return Uint8Array.from(input)
			throw new TypeError(`Invalid delimiter type.`)
		default: throw new TypeError(`Invalid delimiter type.`)
	}
}

function ensureWasmCapacity(memory: WasmMemory, required: number): void {
	if (required <= memory.buffer.byteLength) return
	const pages = Math.ceil((required - memory.buffer.byteLength) / 65536)
	memory.grow(pages)
}

export class CharacterSequence extends Uint8Array {
	#skipIndex: number[]

	static #wasmScanner: WasmDelimiterScanner | null | undefined
	static #wasmHaystack: Uint8Array | null = null
	static #wasmPatternOffset = 0

	static #ensureWasm(): void {
		if (CharacterSequence.#wasmScanner !== undefined) return
		CharacterSequence.#wasmScanner = null
		loadWasmModule().then((mod) => { CharacterSequence.#wasmScanner = mod })
	}

	public search(haystack: Uint8Array, start: number = 0, end: number = haystack.length): number {
		const sequenceLength = this.length

		if (sequenceLength > 1 && end - start >= WASM_THRESHOLD) {
			const wasm = CharacterSequence.#wasmScanner

			if (wasm) {
				const haystackLen = end - start
				const totalNeeded = haystackLen + sequenceLength

				if (haystack !== CharacterSequence.#wasmHaystack) {
					ensureWasmCapacity(wasm.memory, totalNeeded)
					const buffer = new Uint8Array(wasm.memory.buffer, 0, totalNeeded)
					buffer.set(haystack.subarray(start, end), 0)
					buffer.set(this, haystackLen)
					CharacterSequence.#wasmHaystack = haystack
					CharacterSequence.#wasmPatternOffset = haystackLen
				}

				const result = wasm.findDelimiter(start, CharacterSequence.#wasmPatternOffset - start, CharacterSequence.#wasmPatternOffset, sequenceLength)
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
				const resultsSize = WASM_MAX_RESULTS * 2 * 4
				const totalNeeded = haystackLen + sequenceLength + resultsSize
				ensureWasmCapacity(wasm.memory, totalNeeded)
				const buffer = new Uint8Array(wasm.memory.buffer, 0, totalNeeded)
				buffer.set(haystack.subarray(start, end), 0)
				buffer.set(this, haystackLen)

				const count = wasm.findAllDelimiters(0, haystackLen, haystackLen, sequenceLength, haystackLen + sequenceLength, WASM_MAX_RESULTS)
				const rv = new Int32Array(wasm.memory.buffer, haystackLen + sequenceLength, count * 2)
				const ranges: ByteRange[] = []

				for (let i = 0; i < count; i++) ranges.push([start + rv[i * 2]!, start + rv[i * 2 + 1]!])
				return ranges
			}

			if (CharacterSequence.#wasmScanner === undefined) CharacterSequence.#ensureWasm()
		}

		const ranges: ByteRange[] = []
		let searchStart = start, rangeStart = start

		while (searchStart <= end - sequenceLength) {
			let lastIndex = sequenceLength - 1
			while (lastIndex >= 0 && this[lastIndex] === haystack[searchStart + lastIndex]) lastIndex--
			if (lastIndex < 0) { ranges.push([rangeStart, searchStart]); searchStart += sequenceLength; rangeStart = searchStart; continue }
			searchStart += this.#skipIndex[haystack[searchStart + sequenceLength - 1]!]!
		}

		if (rangeStart <= end) ranges.push([rangeStart, end])
		return ranges
	}

	/**
	 * Scan for two patterns simultaneously (delimiter + quote) for CSV parsing.
	 *
	 * Returns sorted MatchResult[] with patternId 0=delimiter, 1=quote.
	 * Uses WASM SIMD double-scan when available; JS fallback otherwise.
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
			const resultsSize = WASM_MAX_RESULTS * 2 * 4
			const totalNeeded = haystackLen + patternsSize + resultsSize

			ensureWasmCapacity(wasm.memory, totalNeeded)
			const buffer = new Uint8Array(wasm.memory.buffer, 0, totalNeeded)
			buffer.set(haystack.subarray(start, end), 0)
			buffer.set(this, haystackLen)
			buffer.set(quotePattern, haystackLen + delimiterLen)

			const count = wasm.findAllMatches(0, haystackLen, haystackLen, delimiterLen, quoteLen, haystackLen + patternsSize, WASM_MAX_RESULTS)
			const rv = new Int32Array(wasm.memory.buffer, haystackLen + patternsSize, count * 2)
			const matches: MatchResult[] = []

			for (let i = 0; i < count; i++) matches.push({ offset: start + rv[i * 2]!, patternId: rv[i * 2 + 1]! })
			return matches
		}

		if (CharacterSequence.#wasmScanner === undefined) CharacterSequence.#ensureWasm()

		// JS fallback: scan independently, merge
		const matches: MatchResult[] = []
		let searchStart = start

		while (searchStart <= end) {
			const delimIdx = this.search(haystack, searchStart, end)
			const quoteIdx = quoteLen === 1 ? haystack.indexOf(quotePattern[0]!, searchStart) : -1
			const adjQuoteIdx = quoteIdx >= 0 && quoteIdx < end ? quoteIdx : -1

			if (delimIdx < 0 && adjQuoteIdx < 0) break

			if (delimIdx >= 0 && (adjQuoteIdx < 0 || delimIdx <= adjQuoteIdx)) {
				matches.push({ offset: delimIdx, patternId: 0 })
				searchStart = delimIdx + delimiterLen
			} else {
				matches.push({ offset: adjQuoteIdx, patternId: 1 })
				searchStart = adjQuoteIdx + quoteLen
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
		this.#skipIndex = new Array(256).fill(this.length)
		for (let i = 0; i < this.length - 1; i++) this.#skipIndex[this[i]!] = this.length - 1 - i
	}
}
