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
 * The caller has established eligibility (single ASCII delimiters, scanner loaded); this generator throws nothing of
 * its own and yields nothing until first pulled.
 */
export function* scanCsvCells(source: Uint8Array, text: string, init: CsvCellScanInit): Generator<string[]> {
	const { rowDelimiter, columnDelimiter, enableQuoteHandling, crlf, trim, skipEmpty } = init
	const windowSize = init.windowSize ?? CELL_SCAN_WINDOW
	const maxCells = init.maxCells ?? WASM_MAX_RESULTS
	const options = { rowDelimiter, columnDelimiter, quote: enableQuoteHandling ? 0x22 : -1, crlf, maxCells }
	const length = source.byteLength

	let state: CellScanState = { scanCursor: 0, units: 0, insideQuotes: false, cellStartUnits: 0, cellHasQuote: false }
	let row: string[] = []
	// UTF-16 start of the row being assembled, for the emptiness test.
	let rowStart = 0
	let rowsEmitted = 0

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
			const start = cells[i * CELL_RESULT_STRIDE]!
			const cellEnd = cells[i * CELL_RESULT_STRIDE + 1]!
			const flags = cells[i * CELL_RESULT_STRIDE + 2]!

			row.push(cell(start, cellEnd, (flags & CELL_FLAG_HAS_QUOTE) !== 0))

			if (flags & CELL_FLAG_ROW_END) {
				// Empty means the raw row range is empty: one cell, and it spans nothing after CRLF removal.
				const empty = row.length === 1 && cellEnd === rowStart

				if (!(empty && skipEmpty)) {
					yield row

					rowsEmitted++
				}

				row = []
				// The next row starts where the next cell starts; when this cell closed the batch, the carried state
				// holds that offset.
				rowStart = i + 1 < scan.count ? cells[(i + 1) * CELL_RESULT_STRIDE]! : scan.cellStartUnits
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
	} else if (rowsEmitted === 0 && length === 0) {
		// An empty source is one empty row, dropped by skipEmpty.
		if (!skipEmpty) {
			yield [""]
		}
	} else if (!skipEmpty) {
		// The source ended on a row delimiter: one trailing empty row, matching String.split.
		yield [""]
	}
}
