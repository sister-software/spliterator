/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { CharacterSequence, type CellScanState } from "../core/CharacterSequence.js"
import { CELL_FLAG_HAS_QUOTE, CELL_FLAG_ROW_END, CELL_RESULT_STRIDE, WASM_MAX_RESULTS } from "../core/wasm_module.js"
import { normalizeCell, unquoteColumn } from "./csv-columns.js"

/**
 * Bytes staged into the kernel per call. The kernel copies `[cursor, end)` into WASM memory each time, so the window
 * bounds that copy; the record open at a window's edge resumes through the carried state.
 */
export const CELL_SCAN_WINDOW = 64 * 1024

const BOM = 0xfe_ff

export interface CsvCellScanInit {
	rowDelimiter: number
	columnDelimiter: number
	enableQuoteHandling: boolean
	crlf: boolean
	trim: boolean
	skipEmpty: boolean
	/**
	 * @default CELL_SCAN_WINDOW
	 */
	windowSize?: number
	/**
	 * @default WASM_MAX_RESULTS
	 */
	maxCells?: number
}

/**
 * Yield every row of a wholly in-memory CSV as `string[]`, slicing cells out of `text` at the boundaries the kernel
 * emits. `text` must be `source` decoded with `{ fatal: true, ignoreBOM: true }`: `fatal` is what makes the kernel's
 * UTF-16 unit count exact, and `ignoreBOM` keeps every U+FEFF in the string so the offsets line up; the one BOM the row
 * path strips at the start of each row is stripped here per row.
 *
 * Row emptiness follows `Spliterator`: a row is empty when its byte range after CRLF removal is empty, before any BOM
 * removal, unquoting or trimming. `""`, a BOM-only row and `,,` are not empty.
 *
 * The caller has established eligibility (single ASCII delimiters, scanner loaded); this generator yields nothing until
 * first pulled and throws only on a broken scanner contract.
 */
export function* scanCsvCells(source: Uint8Array, text: string, init: CsvCellScanInit): Generator<string[]> {
	const { rowDelimiter, columnDelimiter, enableQuoteHandling, crlf, trim, skipEmpty } = init
	const windowSize = init.windowSize ?? CELL_SCAN_WINDOW
	// A zero batch would return without advancing and loop forever; it is a test-only knob, so clamp it.
	const maxCells = Math.max(1, init.maxCells ?? WASM_MAX_RESULTS)
	const options = { rowDelimiter, columnDelimiter, quote: enableQuoteHandling ? 0x22 : -1, crlf, maxCells }
	const length = source.byteLength

	let state: CellScanState = { scanCursor: 0, units: 0, insideQuotes: false, cellStartUnits: 0, cellHasQuote: false }
	let row: string[] = []

	const cell = (start: number, end: number, hasQuote: boolean): string => {
		// The row path decodes each row on its own, which strips one BOM at the row's start.
		if (!row.length && start < end && text.charCodeAt(start) === BOM) {
			start++
		}

		let value = text.slice(start, end)

		if (hasQuote && enableQuoteHandling) {
			value = unquoteColumn(value)
		}

		return normalizeCell(value, enableQuoteHandling, trim)
	}

	while (state.scanCursor < length) {
		const end = Math.min(length, state.scanCursor + windowSize)
		const scan = CharacterSequence.scanCells(source, state, end, options)

		if (!scan) {
			// The scanner is loaded (the caller checked) and the window is not empty, so this cannot happen; treat it
			// as a contract violation rather than looping.
			throw new Error("scanCsvCells: the cell scanner returned no batch for a non-empty window")
		}

		const cells = scan.cells

		for (let i = 0; i < scan.count; i++) {
			const offset = i * CELL_RESULT_STRIDE
			const start = cells[offset]!
			const cellEnd = cells[offset + 1]!
			const flags = cells[offset + 2]!

			row.push(cell(start, cellEnd, (flags & CELL_FLAG_HAS_QUOTE) !== 0))

			if (flags & CELL_FLAG_ROW_END) {
				// Empty means the raw row range is empty: one cell, and it spans nothing after CRLF removal. A row's first
				// cell starts where the row does, so its raw start (before any BOM strip) is the row's start.
				const empty = row.length === 1 && cellEnd === start

				if (!(empty && skipEmpty)) {
					yield row
				}

				row = []
			}
		}

		state = scan
	}

	// The tail after the last delimiter, as `Spliterator.#drain` leaves it: never CRLF-trimmed.
	const tailStart = state.cellStartUnits
	const tailEnd = text.length

	if (tailStart < tailEnd) {
		row.push(cell(tailStart, tailEnd, state.cellHasQuote))
		yield row
	} else if (row.length) {
		// A row whose last cell is empty: `a,` at EOF.
		row.push(cell(tailStart, tailEnd, false))
		yield row
	} else if (!skipEmpty) {
		// An empty source, or one ending on a row delimiter: one empty row, matching String.split.
		yield [""]
	}
}

/**
 * The largest source the fast path decodes whole. V8 refuses strings above ~2^29 characters; a source near that size
 * takes the row path rather than throwing a `RangeError` from the decoder, which is not the error the fallback
 * catches.
 */
export const MAX_CELL_SCAN_BYTES = 2 ** 29 - 2 ** 20

export interface CellScanPlan {
	rowDelimiter: number
	columnDelimiter: number
}

const CARRIAGE_RETURN = 0x0d
const DOUBLE_QUOTE = 0x22

/**
 * Whether the fast path may run, and with which bytes. Cheap and decode-free; the decode is the one remaining gate.
 */
export function cellScanEligibility(init: {
	columnScan: "auto" | "rows"
	rowDelimiter: Uint8Array
	columnDelimiter: Uint8Array
	enableQuoteHandling: boolean
	position: number | undefined
	byteLength: number
}): CellScanPlan | null {
	if (init.columnScan !== "auto") return null

	if (init.rowDelimiter.length !== 1 || init.columnDelimiter.length !== 1) return null

	const row = init.rowDelimiter[0]!
	const column = init.columnDelimiter[0]!

	// ASCII only: a single byte above 0x7F can split a UTF-8 sequence, which would break the unit count.
	if (row > 0x7f || column > 0x7f) return null

	if (row === column) return null

	if (row === CARRIAGE_RETURN || column === CARRIAGE_RETURN) return null

	if (init.enableQuoteHandling && (row === DOUBLE_QUOTE || column === DOUBLE_QUOTE)) return null

	if (init.position !== undefined && init.position !== 0) return null

	if (init.byteLength > MAX_CELL_SCAN_BYTES) return null

	return { rowDelimiter: row, columnDelimiter: column }
}

const fatalDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

/**
 * Decode the whole source for slicing. `null` means invalid UTF-8, the one failure the fast path defers to the row path
 * on. Any other error propagates.
 */
export function decodeForCellScan(bytes: Uint8Array): string | null {
	try {
		return fatalDecoder.decode(bytes)
	} catch (error) {
		if (error instanceof TypeError) return null

		throw error
	}
}
