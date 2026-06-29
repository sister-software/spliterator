import { WASM_BASE64 } from "./wasm_base64.js"

type BufferSource = ArrayBuffer | ArrayBufferView

declare const WebAssembly: {
	compile(bytes: BufferSource): Promise<WebAssemblyModule>
	instantiate(module: WebAssemblyModule, imports?: object): Promise<WebAssemblyInstance>
}

interface WebAssemblyModule {}

interface WebAssemblyInstance {
	exports: Record<string, unknown>
}

export async function loadWasmModule(): Promise<WasmDelimiterScanner | null> {
	if (!WASM_BASE64) return null

	try {
		const bytes = Uint8Array.from(atob(WASM_BASE64), (c) => c.charCodeAt(0))
		const module = await WebAssembly.compile(bytes)
		const instance = await WebAssembly.instantiate(module, {})
		const e = instance.exports

		const memory = e.memory as WasmMemory
		const findDelimiter = e.find_delimiter as WasmFindDelimiter
		const findAllDelimiters = e.find_all_delimiters as WasmFindAllDelimiters
		const findAllMatches = e.find_all_matches as WasmFindAllMatches

		return { memory, findDelimiter, findAllDelimiters, findAllMatches }
	} catch {
		return null
	}
}

type WasmFindDelimiter = (ho: number, hl: number, po: number, pl: number) => number

type WasmFindAllDelimiters = (ho: number, hl: number, po: number, pl: number, ro: number, mr: number) => number

type WasmFindAllMatches = (ho: number, hl: number, p1o: number, p1l: number, p2l: number, ro: number, mr: number) => number

export interface WasmMemory {
	readonly buffer: ArrayBuffer
	grow(pages: number): number
}

export interface WasmDelimiterScanner {
	memory: WasmMemory
	findDelimiter: WasmFindDelimiter
	findAllDelimiters: WasmFindAllDelimiters
	findAllMatches: WasmFindAllMatches
}

/** Match result from find_all_matches: [offset, pattern_id]. */
export interface MatchResult {
	/** Byte offset of the match within the haystack. */
	offset: number
	/** 0 = pattern 1 (delimiter), 1 = pattern 2 (quote). */
	patternId: number
}

export const WASM_THRESHOLD = 4096
export const WASM_MAX_RESULTS = 4096
