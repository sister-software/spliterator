/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

import type { AsyncSpliterator } from "#core/AsyncSpliterator"
import { CharacterSequence, type CellScanOptions, type CellScanState } from "#core/CharacterSequence"
import {
	CELL_FLAG_HAS_ESCAPE,
	CELL_FLAG_HAS_QUOTE,
	CELL_FLAG_ROW_END,
	CELL_RESULT_STRIDE,
	WASM_MAX_RESULTS,
} from "#core/wasm_module"
import { normalizeCell } from "#formats/csv-columns"
import { batched, type BatchedAsyncIterable } from "#iterators/AsyncSequence"

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
 * Every row of a wholly in-memory CSV as `string[]`, produced one kernel batch at a time (up to `maxCells` cells, about
 * 200 rows of 20 columns), slicing cells out of `text` at the boundaries the kernel emits. `text` must be `source`
 * decoded with `{ fatal: true, ignoreBOM: true }`: `fatal` is what makes the kernel's UTF-16 unit count exact, and
 * `ignoreBOM` keeps every U+FEFF in the string so the offsets line up; the one BOM the row path strips at the start of
 * each row is stripped here per row.
 *
 * Row emptiness follows `Spliterator`: a row is empty when its byte range after CRLF removal is empty, before any BOM
 * removal, unquoting or trimming. `""`, a BOM-only row and `,,` are not empty.
 *
 * The caller has established eligibility (single ASCII delimiters, scanner loaded). Nothing is scanned until the first
 * `nextBatch`, which throws only on a broken scanner contract.
 *
 * A stepping object rather than a generator because the rows are pushed straight into the caller's array: the in-memory
 * parser hands over a fresh array per batch and yields it ({@linkcode scanCsvCellBatches}), the streaming path hands
 * over one array per engine window ({@linkcode collectCsvCells}) and never copies. A generator resumption per row had
 * been 13% of a streamed parse, and a flattening copy of each batch 9%.
 */
export class CellRowScanner {
	readonly #source: Uint8Array
	readonly #text: string
	readonly #options: CellScanOptions
	readonly #windowSize: number
	readonly #enableQuoteHandling: boolean
	readonly #trim: boolean
	readonly #skipEmpty: boolean

	#state: CellScanState = { scanCursor: 0, units: 0, insideQuotes: false, cellStartUnits: 0, cellFlags: 0 }

	// Rows are built into an exact-size copy of a template the width of the previous row, the way a parser that knows
	// its column count would preallocate them. Growing a row by `push` left a 43-slot store behind 20 cells and two
	// discarded stores per row, and the garbage is what matters here: the scavenger ran once per parse of a 2MB source
	// instead of once per three, and each run copied the result built so far.
	#template: string[] = []
	#row: string[] = []
	#width = 0
	#done = false

	constructor(source: Uint8Array, text: string, init: CsvCellScanInit) {
		this.#source = source
		this.#text = text
		this.#windowSize = init.windowSize ?? CELL_SCAN_WINDOW
		this.#enableQuoteHandling = init.enableQuoteHandling
		this.#trim = init.trim
		this.#skipEmpty = init.skipEmpty

		this.#options = {
			rowDelimiter: init.rowDelimiter,
			columnDelimiter: init.columnDelimiter,
			quote: init.enableQuoteHandling ? DOUBLE_QUOTE : -1,
			crlf: init.crlf,
			// A zero batch would return without advancing and loop forever; it is a test-only knob, so clamp it.
			maxCells: Math.max(1, init.maxCells ?? WASM_MAX_RESULTS),
		}
	}

	/**
	 * Push the rows of the next kernel batch onto `out`. Returns `false` once the source is exhausted, after the tail row
	 * has been pushed; a `true` return may have pushed nothing when a batch closed no row.
	 */
	public nextBatch(out: string[][]): boolean {
		if (this.#done) return false

		const source = this.#source
		const length = source.byteLength
		const state = this.#state

		if (state.scanCursor >= length) {
			this.#finish(out)

			return false
		}

		const end = Math.min(length, state.scanCursor + this.#windowSize)
		const scan = CharacterSequence.scanCells(source, state, end, this.#options)

		if (!scan) {
			// The scanner is loaded (the caller checked) and the window is not empty, so this cannot happen; treat it
			// as a contract violation rather than looping.
			throw new Error("CellRowScanner: the cell scanner returned no batch for a non-empty window")
		}

		const cells = scan.cells
		const skipEmpty = this.#skipEmpty

		for (let i = 0; i < scan.count; i++) {
			const offset = i * CELL_RESULT_STRIDE
			const start = cells[offset]!
			const cellEnd = cells[offset + 1]!
			const flags = cells[offset + 2]!

			// Evaluated before the store: `row[width++] = cell(...)` would bump `width` before `cell` reads it.
			const value = this.#cell(start, cellEnd, flags)

			this.#row[this.#width++] = value

			if (flags & CELL_FLAG_ROW_END) {
				// Empty means the raw row range is empty: one cell, and it spans nothing after CRLF removal. A row's first
				// cell starts where the row does, so its raw start (before any BOM strip) is the row's start.
				const empty = this.#width === 1 && cellEnd === start
				const finished = this.#finishRow()

				if (!(empty && skipEmpty)) {
					out.push(finished)
				}
			}
		}

		this.#state = scan

		return true
	}

	#cell(start: number, end: number, flags: number): string {
		const text = this.#text

		// The row path decodes each row on its own, which strips one BOM at the row's start.
		if (this.#width === 0 && start < end && text.charCodeAt(start) === BOM) {
			start++
		}

		let value: string

		if (
			this.#enableQuoteHandling &&
			flags & CELL_FLAG_HAS_QUOTE &&
			end - start >= 2 &&
			text.charCodeAt(start) === DOUBLE_QUOTE &&
			text.charCodeAt(end - 1) === DOUBLE_QUOTE
		) {
			// Slice the inside directly: the quoted outer string was one more allocation per cell, and the kernel saw every
			// quote, so it knows whether there is a doubled one to unescape. Agrees with `unquoteColumn`.
			const inner = text.slice(start + 1, end - 1)

			value = flags & CELL_FLAG_HAS_ESCAPE ? inner.replaceAll('""', '"') : inner
		} else {
			value = text.slice(start, end)
		}

		return normalizeCell(value, this.#enableQuoteHandling, this.#trim)
	}

	#finishRow(): string[] {
		const width = this.#width
		const row = this.#row
		const finished = width === row.length ? row : row.slice(0, width)

		if (width !== this.#template.length) {
			this.#template = new Array<string>(width).fill("")
		}

		this.#row = this.#template.slice()
		this.#width = 0

		return finished
	}

	/**
	 * The tail after the last delimiter, as `Spliterator.#drain` leaves it: never CRLF-trimmed.
	 */
	#finish(out: string[][]): void {
		this.#done = true

		const tailStart = this.#state.cellStartUnits
		const tailEnd = this.#text.length

		if (tailStart < tailEnd) {
			const value = this.#cell(tailStart, tailEnd, this.#state.cellFlags)

			this.#row[this.#width++] = value
			out.push(this.#finishRow())
		} else if (this.#width) {
			// A row whose last cell is empty: `a,` at EOF.
			const value = this.#cell(tailStart, tailEnd, 0)

			this.#row[this.#width++] = value
			out.push(this.#finishRow())
		} else if (!this.#skipEmpty) {
			// An empty source, or one ending on a row delimiter: one empty row, matching String.split.
			out.push([""])
		}
	}
}

/**
 * The rows of a wholly in-memory CSV, one non-empty array per kernel batch. The in-memory parser walks these itself so
 * each row crosses one generator, its own, rather than two.
 */
export function* scanCsvCellBatches(source: Uint8Array, text: string, init: CsvCellScanInit): Generator<string[][]> {
	const scanner = new CellRowScanner(source, text, init)
	let batch: string[][] = []

	while (scanner.nextBatch(batch)) {
		if (batch.length) {
			yield batch

			batch = []
		}
	}

	if (batch.length) {
		yield batch
	}
}

/**
 * {@linkcode scanCsvCellBatches} flattened to one row per step. The parity reference for tests and the shape the bulk
 * parser of small sources returns.
 */
export function* scanCsvCells(source: Uint8Array, text: string, init: CsvCellScanInit): Generator<string[]> {
	for (const batch of scanCsvCellBatches(source, text, init)) {
		yield* batch
	}
}

/**
 * Every row of `source` in one array, pushed straight from the scanner: the streaming path's per-window shape.
 */
export function collectCsvCells(source: Uint8Array, text: string, init: CsvCellScanInit): string[][] {
	const scanner = new CellRowScanner(source, text, init)
	const rows: string[][] = []

	while (scanner.nextBatch(rows)) {
		// Each call appends its batch.
	}

	return rows
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

/**
 * Drive the cell scanner over a streaming source one engine window at a time, yielding each window's rows as one batch.
 *
 * Each window the engine hands out spans whole records, so {@linkcode scanCsvCells} runs over it exactly as it would
 * over a whole in-memory source, and nothing carries across windows: the engine cut the records with quote state in
 * hand, and the scanner's own tail handling closes the window's last row. One decode and one `await` per window
 * replaces one of each per row, which is what makes this the streaming counterpart of the in-memory fast path. The rows
 * go out as a batch, which {@linkcode batched} tells the sequence to walk without an `await` per row. Yielding them
 * singly here was measured slower than the per-row path it replaces.
 *
 * A window that is not valid UTF-8 goes through `fallback`, the per-row path, for that window alone: the row path
 * decodes lossily, so the output is the same as if the whole source had taken it.
 *
 * `return()` on the iterable closes the engine. Callers that may never start it must close the engine themselves, since
 * a never-started generator skips its `finally`.
 */
export function scanCsvCellsStreaming(
	engine: AsyncSpliterator,
	init: CsvCellScanInit,
	fallback: (window: Uint8Array) => string[][]
): BatchedAsyncIterable<string[]> {
	return batched(windows(engine, init, fallback))
}

async function* windows(
	engine: AsyncSpliterator,
	init: CsvCellScanInit,
	fallback: (window: Uint8Array) => string[][]
): AsyncGenerator<string[][]> {
	try {
		while (true) {
			const result = await engine.nextWindow()

			if (result.done) return

			const window = result.value
			const text = decodeForCellScan(window)

			yield text === null ? fallback(window) : collectCsvCells(window, text, init)
		}
	} finally {
		await engine.return()
	}
}

/**
 * A batched iterable that yields `first` and then whatever `rest` has left. Used to put back the remainder of a batch
 * whose head row was consumed as the header. `return()` reaches `rest`, so closing still releases the engine.
 */
export function reheadBatches<T>(first: readonly T[], rest: AsyncIterator<readonly T[]>): BatchedAsyncIterable<T> {
	let served = false

	return batched({
		[Symbol.asyncIterator]: () => ({
			next: async () => {
				if (!served) {
					served = true

					return { value: first, done: false }
				}

				return rest.next()
			},
			return: async () => {
				await rest.return?.()

				return { value: undefined, done: true }
			},
		}),
	})
}
