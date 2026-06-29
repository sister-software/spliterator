/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import {
	loadWasmModule,
	WASM_MAX_RESULTS,
	WASM_THRESHOLD,
	type WasmDelimiterScanner,
	type WasmMemory,
} from "./wasm_module.js"

import type { ByteRange } from "./shared.js"

/**
 * Type-predicate to determine if a value is an array-like object.
 */
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
		.map((charCode) => {
			const visible = VisibleDelimiterMap.get(charCode)
			return visible ?? String.fromCharCode(charCode)
		})
		.join("")
}

const encoder = new TextEncoder()

export function normalizeCharacterInput(input: CharacterSequenceInput): Uint8Array {
	switch (typeof input) {
		case "number":
			if (!Number.isInteger(input)) throw new TypeError(`Numeric delimiters must be integers. Received: ${input}`)
			return Uint8Array.from([input])
		case "string":
			return encoder.encode(input)
		case "object":
			if (isArrayLike(input)) return input
			if (Symbol.iterator in input) return Uint8Array.from(input)
			throw new TypeError(`Invalid delimiter type.`)
		default:
			throw new TypeError(`Invalid delimiter type. Received: ${input}`)
	}
}

function ensureWasmCapacity(memory: WasmMemory, required: number): void {
	if (required <= memory.buffer.byteLength) return
	const pageSize = 64 * 1024
	const neededPages = Math.ceil((required - memory.buffer.byteLength) / pageSize)
	memory.grow(neededPages)
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

	/**
	 * Perform a Boyer-Moore-Horspool search for the pattern in the text.
	 *
	 * For multi-byte delimiters with large haystacks, delegates to the WASM SIMD
	 * scanner if available.
	 */
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

				const result = wasm.findDelimiter(
					start,
					CharacterSequence.#wasmPatternOffset - start,
					CharacterSequence.#wasmPatternOffset,
					sequenceLength
				)

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

	/**
	 * Find ALL delimiter positions in the haystack using WASM SIMD, returning
	 * `[start, end]` byte ranges in a single WASM call.
	 *
	 * Falls back to JS BMH iteration if WASM is unavailable.
	 */
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

				const resultsOffset = haystackLen + sequenceLength

				const count = wasm.findAllDelimiters(
					0, haystackLen, haystackLen, sequenceLength, resultsOffset, WASM_MAX_RESULTS
				)

				const resultView = new Int32Array(wasm.memory.buffer, resultsOffset, count * 2)
				const ranges: ByteRange[] = []

				for (let i = 0; i < count; i++) {
					ranges.push([start + resultView[i * 2]!, start + resultView[i * 2 + 1]!])
				}

				return ranges
			}

			if (CharacterSequence.#wasmScanner === undefined) CharacterSequence.#ensureWasm()
		}

		// JS BMH fallback
		const ranges: ByteRange[] = []
		let searchStart = start
		let rangeStart = start

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
