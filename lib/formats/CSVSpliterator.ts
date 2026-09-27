/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import {
	CharacterSequence,
	type CharacterSequenceInput,
	Delimiters,
	normalizeCharacterInput,
} from "../core/CharacterSequence.js"
import { type AsyncSpliteratorInit, Spliterator, type SpliteratorInit } from "../core/Spliterator.js"
import type { AsyncChunkIterator, AsyncDataResource } from "../internal/shared.js"
import { type AdaptiveSourceInit, openDelimitedRows } from "../io/adaptive-source.js"
import { AsyncSequence } from "../iterators/AsyncSequence.js"
import { Sequence } from "../iterators/Sequence.js"
import { normalizeColumnNames } from "./casing.js"
import { cellScanEligibility, decodeForCellScan, scanCsvCells } from "./csv-cells.js"
import { splitRowColumns } from "./csv-columns.js"
import {
	bindTransformers,
	createRowEmitters,
	type RowEmitter,
	type RowOutputMode,
	type RowSpliteratorInit,
	type RowTransformer,
	type RowTransformerEntry,
	type RowTransformerRecord,
	type RowTuple,
} from "./row-emitters.js"

export type { RowTuple } from "./row-emitters.js"

/**
 * An output mode for the CSV generator.
 */
export type CSVOutputMode = RowOutputMode

export type CSVTransformer<T = unknown> = RowTransformer<string, T>

export type CSVTransformerEntry<T = unknown> = RowTransformerEntry<string, T>

export type CSVTransformerRecord = RowTransformerRecord<string>

export type CSVEmitter<T = unknown> = RowEmitter<string, T>

export type CSVSpliteratorEmittedRecord<V = string | number | undefined> = Record<string, V>

export const CSVSpliteratorEmitters: Record<CSVOutputMode, CSVEmitter | null> = createRowEmitters<string>("")

/**
 * CSV-specific options, in addition to {@linkcode RowSpliteratorInit}'s common row-shaping options.
 */
export interface CSVSpliteratorInit extends SpliteratorInit, RowSpliteratorInit<string> {
	/**
	 * The delimiter to use for columns in a row.
	 *
	 * @default Delimiters.Comma
	 */
	columnDelimiter?: CharacterSequenceInput

	/**
	 * Whether to treat double-quoted regions as opaque. A delimiter inside `"…"` does not split. Wrapping quotes are
	 * stripped and doubled quotes (`""`) unescape to `"`.
	 *
	 * @default true
	 */
	enableQuoteHandling?: boolean

	/**
	 * Normalize CRLF row terminators by treating a carriage return immediately preceding a row delimiter as part of that
	 * delimiter.
	 *
	 * @default true
	 */
	crlf?: boolean

	/**
	 * Trim leading and trailing whitespace from every column, header cells included, after quotes are stripped. RFC 4180
	 * treats that whitespace as part of the field; real-world sources pad it. Pass `false` to keep it.
	 *
	 * @default true
	 */
	trim?: boolean

	/**
	 * How columns are found. `"auto"` scans every cell of a wholly in-memory source in one SIMD pass and slices the
	 * decoded text, and otherwise uses `"rows"`. `"rows"` decodes and splits each row, as every version before 7.20 did.
	 * Both produce the same values.
	 *
	 * The bulk path decodes the whole source on the first pull, even for `take(1)`, and a retained cell may keep the
	 * whole decoded string alive. Use `"rows"` to avoid either cost.
	 *
	 * @default "auto"
	 */
	columnScan?: "auto" | "rows"
}

/**
 * The row generator behind {@linkcode CSVSpliterator.from}, kept at module scope so `from` can hand it to a
 * {@linkcode Sequence} while staying lazy — calling a generator function runs none of its body. `from` reads
 * `this.ColumnDelimiter` on the way in, so a subclass's delimiter still wins.
 */
function* splitRows(source: CharacterSequenceInput, init: CSVSpliteratorInit, defaultColumnDelimiter: number) {
	const {
		// ---
		header = true,
		// Without a header row there are no column names, so a row can only be an array.
		// Declared before `normalizeKeys`, whose own default reads this one.
		mode = header === false ? "array" : "object",
		transformers: transformersInput = [],
		// Matches `fromAsync`. These two defaulted differently until 4.0.1, so the same options
		// object produced `row.some_name` from one entry point and `row["Some Name"]` from the other.
		normalizeKeys = mode !== "array",
		columnDelimiter: columnDelimiterInput = defaultColumnDelimiter,
		enableQuoteHandling = true,
		// RFC 4180 mandates CRLF row terminators — accept them by default so the last column
		// never carries a stray `\r` on Windows-lineage sources.
		crlf = true,
		trim = true,
		columnScan = "auto",
		take = Infinity,
		drop = 0,
		...rowInit
	} = init

	const emitter = CSVSpliteratorEmitters[mode]
	let transformers: CSVTransformerEntry[] = []
	let yieldCount = 0
	const yieldLimit = take + drop

	const decoder = new TextDecoder()
	const columnDelimiter = new CharacterSequence(columnDelimiterInput ?? defaultColumnDelimiter)
	const bytes = normalizeCharacterInput(source)
	const rowDelimiter = new CharacterSequence(rowInit.delimiter ?? Delimiters.LineFeed)

	const plan = cellScanEligibility({
		columnScan,
		rowDelimiter,
		columnDelimiter,
		enableQuoteHandling,
		position: rowInit.position,
		byteLength: bytes.byteLength,
	})

	// Nothing to yield and no header to read: skip the whole-source decode the fast path would otherwise do first. The row
	// path, which stops after one row here, would yield nothing either.
	if (plan && take <= 0 && !header) return

	// The scanner loads asynchronously; a synchronous caller sees it only if something awaited `whenReady()` first.
	const text = plan && CharacterSequence.hasScanner() ? decodeForCellScan(bytes) : null

	if (plan && text !== null) {
		const cellRows = scanCsvCells(bytes, text, {
			rowDelimiter: plan.rowDelimiter,
			columnDelimiter: plan.columnDelimiter,
			enableQuoteHandling,
			crlf,
			trim,
			skipEmpty: rowInit.skipEmpty ?? true,
		})

		if (header) {
			const result = cellRows.next()

			if (result.done) return

			const headers = normalizeKeys ? normalizeColumnNames(result.value) : result.value

			transformers = bindTransformers(headers, transformersInput)
		}

		for (const columns of cellRows) {
			if (yieldCount < drop) {
				yieldCount++

				continue
			}

			if (yieldCount >= yieldLimit) break

			yield emitter ? emitter(columns, transformers) : columns

			yieldCount++
		}

		return
	}

	// Quote handling applies at both levels: rows must not split on newlines inside quotes,
	// columns must not split on quoted column delimiters.
	const rows = Spliterator.fromSync(bytes, { ...rowInit, crlf, enableQuoteHandling })

	if (header) {
		const result = rows.next()

		if (result.done) return

		const columns = splitRowColumns(result.value, columnDelimiter, decoder, enableQuoteHandling, trim)
		const headers = normalizeKeys ? normalizeColumnNames(columns) : columns

		transformers = bindTransformers(headers, transformersInput)
	}

	for (const row of rows) {
		if (yieldCount < drop) {
			yieldCount++

			continue
		}

		if (yieldCount >= yieldLimit) break

		const columns = splitRowColumns(row, columnDelimiter, decoder, enableQuoteHandling, trim)

		yield emitter ? emitter(columns, transformers) : columns

		yieldCount++
	}
}

/**
 * A static class spliterator for comma-separated values.
 *
 * **Performance:** the SIMD delimiter scan wins when scanning dominates — many rows, a few columns pulled out cheaply,
 * streaming to bound memory. When per-row work is heavy (a full `JSON.parse`, expensive transforms) it can dominate the
 * scan and erase the advantage. Benchmark against a mature native parser before swapping an existing loop for speed.
 * See {@link JSONSpliterator} for the measured case where per-row `JSON.parse` makes the streamed path a net loss.
 *
 * @see {@linkcode CSVSpliterator.from} for synchronous usage.
 * @see {@linkcode CSVSpliterator.fromAsync} for asynchronous usage.
 */
export abstract class CSVSpliterator {
	/**
	 * The column delimiter used by the spliterator.
	 *
	 * @default Delimiters.Comma
	 */
	public static ColumnDelimiter: number = Delimiters.Comma

	constructor() {
		throw new TypeError("Static class cannot be instantiated. Did you mean `CSVSpliterator.from`?")
	}

	/**
	 * Count logical data rows without decoding columns or constructing emitted records.
	 *
	 * Row boundaries follow {@linkcode from}, including quote handling and CRLF normalization. The header (when enabled),
	 * `drop`, and `take` have the same effect they do when yielding rows.
	 *
	 * @see {@linkcode countAsync} for files and other asynchronous sources.
	 */
	public static count(source: CharacterSequenceInput, init: CSVSpliteratorInit = {}): number {
		const {
			header = true,
			enableQuoteHandling = true,
			crlf = true,
			trim: _trim,
			drop = 0,
			take = Infinity,
			...rowInit
		} = init

		const rows = Spliterator.fromSync(source, { ...rowInit, crlf, enableQuoteHandling })

		if (header && rows.next().done) return 0

		let skipped = 0
		let count = 0

		while (count < take) {
			const row = rows.next()

			if (row.done) break

			if (skipped < drop) {
				skipped++

				continue
			}

			count++
		}

		return count
	}

	/**
	 * Count logical data rows without decoding columns or constructing emitted records.
	 *
	 * Row boundaries follow {@linkcode fromAsync}, including quote handling and CRLF normalization. The header (when
	 * enabled), `drop`, and `take` have the same effect they do when yielding rows. A path or URL is opened independently
	 * and can subsequently be passed to {@linkcode fromAsync}; an arbitrary async iterable is inherently consumed.
	 */
	public static async countAsync(
		source: AsyncDataResource | AsyncChunkIterator,
		init: CSVSpliteratorInit & AdaptiveSourceInit = {}
	): Promise<number> {
		const {
			header = true,
			enableQuoteHandling = true,
			crlf = true,
			trim: _trim,
			drop = 0,
			take = Infinity,
			...rowInit
		} = init

		const rows = await openDelimitedRows(source, { ...rowInit, crlf, enableQuoteHandling })
		const iterator = Symbol.asyncIterator in rows ? rows[Symbol.asyncIterator]() : rows[Symbol.iterator]()

		try {
			if (header && (await iterator.next()).done) return 0

			let skipped = 0
			let count = 0

			while (count < take) {
				const row = await iterator.next()

				if (row.done) break

				if (skipped < drop) {
					skipped++

					continue
				}

				count++
			}

			return count
		} finally {
			await iterator.return?.()
		}
	}

	public static from<T extends object = CSVSpliteratorEmittedRecord>(
		source: CharacterSequenceInput,
		options?: CSVSpliteratorInit & { mode?: "object"; header?: true }
	): Sequence<T>
	/**
	 * @yields Each row as a 3-tuple [key, value, idx].
	 */

	public static from<T extends RowTuple[] = RowTuple[]>(
		source: CharacterSequenceInput,
		options?: CSVSpliteratorInit & { mode: "entries" }
	): Sequence<T>
	/**
	 * Given a byte array or string, yield each row as an array of columns.
	 *
	 * @yields Each row as an array of columns.
	 */
	public static from<T extends string[] = string[]>(
		source: CharacterSequenceInput,
		options?: CSVSpliteratorInit & ({ mode: "array" } | { mode?: "array"; header: false })
	): Sequence<T>
	/**
	 * Given a byte array or string, yield each row as an array of columns.
	 *
	 * @yields Each row as an array of columns.
	 */
	public static from(source: CharacterSequenceInput, init: CSVSpliteratorInit = {}) {
		return new Sequence(splitRows(source, init, this.ColumnDelimiter))
	}

	/**
	 * @yields Each row as an object with the header names as keys.
	 */
	public static fromAsync<T extends object = CSVSpliteratorEmittedRecord>(
		source: AsyncDataResource | AsyncChunkIterator,
		options?: CSVSpliteratorInit & AsyncSpliteratorInit & { mode?: "object"; header?: true }
	): AsyncSequence<T>

	/**
	 * @yields Each row as a 3-tuple [key, value, idx].
	 */
	public static fromAsync<T extends RowTuple[] = RowTuple[]>(
		source: AsyncDataResource | AsyncChunkIterator,
		options?: CSVSpliteratorInit & AsyncSpliteratorInit & { mode: "entries" }
	): AsyncSequence<T>
	/**
	 * @yields Each row as an array of columns.
	 */
	public static fromAsync<T extends string[] = string[]>(
		source: AsyncDataResource | AsyncChunkIterator,
		options?: CSVSpliteratorInit & AsyncSpliteratorInit & ({ mode: "array" } | { mode?: "array"; header: false })
	): AsyncSequence<T>
	/**
	 * Given an asynchronous data source, split the data by rows (usually newline-delimited) and then by columns (usually
	 * comma).
	 *
	 * @param source The data source to split.
	 * @param init Options for the spliterator.
	 *
	 * @yields Each row, shaped according to the `mode` option.
	 */
	public static fromAsync(
		source: AsyncDataResource | AsyncChunkIterator,
		init?: CSVSpliteratorInit & AsyncSpliteratorInit
	): AsyncSequence<unknown>
	/**
	 * Given an asynchronous data source, split the data by rows (usually newline-delimited) and then by columns (usually
	 * comma).
	 *
	 * @param source The data source to split.
	 * @param init Options for the spliterator.
	 *
	 * @yields Each row, shaped according to the `mode` option.
	 */
	public static fromAsync(
		source: AsyncDataResource | AsyncChunkIterator,
		init: CSVSpliteratorInit & AdaptiveSourceInit = {}
	): AsyncSequence<unknown> {
		const defaultColumnDelimiter = this.ColumnDelimiter

		const {
			// ---
			header = true,
			// Without a header row there are no column names, so a row can only be an array.
			mode = header === false ? "array" : "object",
			transformers: transformersInput = [],
			normalizeKeys = mode !== "array",
			columnDelimiter: columnDelimiterInput,
			enableQuoteHandling = true,
			// RFC 4180 mandates CRLF row terminators — accept them by default so the last column
			// never carries a stray `\r` on Windows-lineage sources.
			crlf = true,
			trim = true,
			columnScan = "auto",
			take = Infinity,
			drop = 0,
			...rowInit
		} = init

		const emitter = CSVSpliteratorEmitters[mode]
		const columnDelimiter = new CharacterSequence(columnDelimiterInput ?? defaultColumnDelimiter)
		const rowDelimiter = new CharacterSequence(rowInit.delimiter ?? Delimiters.LineFeed)
		const skipEmpty = rowInit.skipEmpty ?? true
		const decoder = new TextDecoder()

		// Populated by the header pass below before the first row op runs, since the source thunk resolves on the first
		// pull and the ops only run against what it returns.
		let transformers: CSVTransformerEntry[] = []

		/**
		 * The bulk branch: eligibility, then the fatal decode as the last gate. Invalid UTF-8 hands the same bytes to the
		 * row engine, which the map op below still understands. Runs after `whenReady`, on the first pull.
		 */
		const bulkParser = (bytes: Uint8Array): Iterable<Uint8Array | string[]> => {
			const plan = cellScanEligibility({
				columnScan,
				rowDelimiter,
				columnDelimiter,
				enableQuoteHandling,
				position: rowInit.position,
				byteLength: bytes.byteLength,
			})

			const text = plan && CharacterSequence.hasScanner() ? decodeForCellScan(bytes) : null

			if (!plan || text === null) {
				return Spliterator.fromSync(bytes, { ...rowInit, crlf, enableQuoteHandling })
			}

			return scanCsvCells(bytes, text, {
				rowDelimiter: plan.rowDelimiter,
				columnDelimiter: plan.columnDelimiter,
				enableQuoteHandling,
				crlf,
				trim,
				skipEmpty,
			})
		}

		const toColumns = (row: Uint8Array | string[]): string[] =>
			Array.isArray(row) ? row : splitRowColumns(row, columnDelimiter, decoder, enableQuoteHandling, trim)

		const openRows = async (): Promise<AsyncIterable<Uint8Array> | Iterable<Uint8Array | string[]>> => {
			// Quote handling applies at both levels: rows must not split on newlines inside quotes,
			// columns must not split on quoted column delimiters.
			const rows = await openDelimitedRows(source, { ...rowInit, crlf, enableQuoteHandling }, bulkParser)

			if (header) {
				// Both engines return `this` from their iterator method. Consuming the header row here advances the cursor the
				// row ops will read. Returning `rows` afterwards resumes at row two rather than row one.
				const iterator = Symbol.asyncIterator in rows ? rows[Symbol.asyncIterator]() : rows[Symbol.iterator]()

				try {
					const result = await iterator.next()

					if (result.done) return rows

					const columns = toColumns(result.value)
					const headers = normalizeKeys ? normalizeColumnNames(columns) : columns

					transformers = bindTransformers(headers, transformersInput)
				} catch (error) {
					try {
						await iterator.return?.()
					} catch {
						// The original error is the one worth reporting.
					}

					throw error
				}
			}

			return rows
		}

		let sequence: AsyncSequence<unknown> = AsyncSequence.from<Uint8Array | string[]>(openRows).map((row) => {
			const columns = toColumns(row)

			return emitter ? emitter(columns, transformers) : columns
		})

		if (drop > 0) {
			sequence = sequence.drop(drop)
		}

		if (Number.isFinite(take)) {
			sequence = sequence.take(take)
		}

		return sequence
	}
}
