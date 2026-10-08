/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

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
		const scanDelimitedRanges = e.scan_delimited_ranges as WasmScanDelimitedRanges
		const scanCsvCells = e.scan_csv_cells as WasmScanCsvCells

		return { memory, findDelimiter, findAllDelimiters, findAllMatches, scanDelimitedRanges, scanCsvCells }
	} catch {
		return null
	}
}

type WasmFindDelimiter = (ho: number, hl: number, po: number, pl: number) => number

type WasmFindAllDelimiters = (ho: number, hl: number, po: number, pl: number, ro: number, mr: number) => number

type WasmFindAllMatches = (
	ho: number,
	hl: number,
	p1o: number,
	p1l: number,
	p2l: number,
	ro: number,
	mr: number
) => number

// oxlint-disable-next-line eslint/max-params
type WasmScanDelimitedRanges = (
	ho: number,
	hl: number,
	ss: number,
	pss: number,
	delimiter: number,
	quote: number,
	insideQuotes: number,
	ro: number,
	mr: number
) => number

// oxlint-disable-next-line eslint/max-params
type WasmScanCsvCells = (
	ho: number,
	hl: number,
	rowDelimiter: number,
	columnDelimiter: number,
	quote: number,
	crlf: number,
	insideQuotes: number,
	cellStartUnits: number,
	cellHasQuote: number,
	previousByte: number,
	ro: number,
	mc: number
) => number

export interface WasmMemory {
	readonly buffer: ArrayBuffer
	grow(pages: number): number
}

export interface WasmDelimiterScanner {
	memory: WasmMemory
	findDelimiter: WasmFindDelimiter
	findAllDelimiters: WasmFindAllDelimiters
	findAllMatches: WasmFindAllMatches
	scanDelimitedRanges: WasmScanDelimitedRanges
	scanCsvCells: WasmScanCsvCells
}

/**
 * Match result from find_all_matches: [offset, pattern_id].
 */
export interface MatchResult {
	/**
	 * Byte offset of the match within the haystack.
	 */
	offset: number
	/**
	 * 0 = pattern 1 (delimiter), 1 = pattern 2 (quote).
	 */
	patternId: number
}

/**
 * Minimum haystack size (bytes) at which the WASM SIMD scanner is used instead of the JS scan, once the module has
 * loaded. Empirically WASM wins well below this — ~8x for single-byte `searchAll` and ~3x for multi-byte `search` at
 * 512 bytes, with sub-µs fixed overhead — so 512 captures typical delimited rows while skipping only the tiny-buffer
 * regime where it doesn't matter.
 */
export const WASM_THRESHOLD = 512
export const WASM_MAX_RESULTS = 4096

/**
 * Layout of `scan_csv_cells`'s result block: five header ints, then three per cell.
 */
export const CELL_RESULT_HEADER = 5
export const CELL_RESULT_STRIDE = 3
export const CELL_FLAG_ROW_END = 1
export const CELL_FLAG_HAS_QUOTE = 2

/**
 * State returned by the bounded, resumable range scanner.
 */
export interface WasmRangeScanResult {
	/**
	 * A shared-memory view of `[start, end]` pairs. Consume it before the next WASM scan.
	 */
	ranges: Int32Array
	count: number
	scanCursor: number
	pendingSliceStart: number
	insideQuotes: boolean
}

/**
 * One owned batch from the CSV cell scanner, rebased to absolute offsets by `CharacterSequence.scanCells`.
 */
export interface WasmCellScanResult {
	/**
	 * `[start, end, flags]` triples in UTF-16 units of the decoded source. A copy, safe to hold across further scans.
	 */
	cells: Int32Array
	count: number
	/**
	 * Absolute byte offset the scan stopped at.
	 */
	scanCursor: number
	/**
	 * Absolute UTF-16 unit count at `scanCursor`.
	 */
	units: number
	insideQuotes: boolean
	/**
	 * Absolute UTF-16 start of the cell open at `scanCursor`.
	 */
	cellStartUnits: number
	cellHasQuote: boolean
}
