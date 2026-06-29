import { WASM_BASE64 } from "./wasm_base64.js"

// WebAssembly is a Node.js global but not declared in the project's
// tsconfig lib target (ESNext). Declare it minimally.
type BufferSource = ArrayBuffer | ArrayBufferView

declare const WebAssembly: {
	compile(bytes: BufferSource): Promise<WebAssemblyModule>
	instantiate(module: WebAssemblyModule, imports?: object): Promise<WebAssemblyInstance>
}

interface WebAssemblyModule {}

interface WebAssemblyInstance {
	exports: Record<string, unknown>
}

/**
 * The WASM module instance, lazily compiled from the inline base64 bytes.
 *
 * Returns null if the module failed to compile (e.g., SIMD not supported).
 */
export async function loadWasmModule(): Promise<WasmDelimiterScanner | null> {
	if (!WASM_BASE64) return null

	try {
		const bytes = Uint8Array.from(atob(WASM_BASE64), (c) => c.charCodeAt(0))

		const module = await WebAssembly.compile(bytes)
		const instance = await WebAssembly.instantiate(module, {})

		const exports = instance.exports
		const memory = exports.memory as WasmMemory
		const findDelimiter = exports.find_delimiter as WasmFindDelimiter
		const findAllDelimiters = exports.find_all_delimiters as WasmFindAllDelimiters

		return { memory, findDelimiter, findAllDelimiters }
	} catch {
		return null
	}
}

type WasmFindDelimiter = (
	haystackOffset: number,
	haystackLen: number,
	patternOffset: number,
	patternLen: number
) => number

type WasmFindAllDelimiters = (
	haystackOffset: number,
	haystackLen: number,
	patternOffset: number,
	patternLen: number,
	resultsOffset: number,
	maxResults: number
) => number

/**
 * Minimal WASM memory type — avoids depending on the `WebAssembly`
 * namespace which may not be declared in all TS lib targets.
 */
export interface WasmMemory {
	readonly buffer: ArrayBuffer
	grow(pages: number): number
}

export interface WasmDelimiterScanner {
	memory: WasmMemory
	findDelimiter: WasmFindDelimiter
	findAllDelimiters: WasmFindAllDelimiters
}

/**
 * Minimum haystack size (bytes) to use the WASM path.
 *
 * Below this threshold, the copy-into-WASM overhead dominates the SIMD gain.
 * The JS BMH path is faster for tiny chunks.
 */
export const WASM_THRESHOLD = 4096

/**
 * Maximum number of delimiter results a single WASM call can return.
 *
 * Each result is 2 × i32 (8 bytes). For CSV column splitting, 4096 columns
 * per row is far more than any realistic use case.
 */
export const WASM_MAX_RESULTS = 4096
