/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { normalizeColumnNames } from "./casing.js"
import { CharacterSequence, type CharacterSequenceInput, Delimiters } from "./CharacterSequence.js"
import { type AsyncChunkIterator, type AsyncDataResource, zipSync } from "./shared.js"
import { type AsyncSpliteratorInit, Spliterator, type SpliteratorInit } from "./Spliterator.js"

/**
 * An output mode for the CSV generator.
 */
export type CSVOutputMode = "array" | "object" | "entries"
export type CSVTransformer<T = unknown> = (value: string) => T

export type CSVTransformerEntry<T = unknown> = [columnName: string, transformer: CSVTransformer<T>]
export type CSVTransformerRecord = Record<string, CSVTransformer | undefined>

export type CSVEmitter<T = unknown> = (columns: Iterable<string>, headerColumns?: Iterable<CSVTransformerEntry>) => T

const identity: CSVTransformer<string> = (value) => value

const doubleQuoteSequence = new CharacterSequence('"')

/**
 * Decode a single column, stripping wrapping quotes and unescaping doubled quotes (`""` → `"`) when quote handling is
 * on. The unescape allocates only when the field was actually quoted.
 */
function decodeColumn(bytes: Uint8Array, decoder: TextDecoder, enableQuoteHandling: boolean): string {
	const value = decoder.decode(bytes)

	if (enableQuoteHandling && value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1).replaceAll('""', '"')
	}

	return value
}

/**
 * Split one row's bytes into decoded column strings.
 *
 * Without quote handling this is a plain delimiter scan. With it, a column delimiter inside a double-quoted region does
 * not split, and each field is unquoted/unescaped via {@linkcode decodeColumn}. Empty columns are always preserved — a
 * 30-column row must stay 30 columns regardless of the caller's row-level `skipEmpty`.
 */
function splitRowColumns(
	row: Uint8Array,
	columnDelimiter: CharacterSequence,
	decoder: TextDecoder,
	enableQuoteHandling: boolean
): string[] {
	if (!enableQuoteHandling) {
		return columnDelimiter.searchAll(row).map(([start, end]) => decoder.decode(row.subarray(start, end)))
	}

	const columns: string[] = []
	let sliceStart = 0
	let insideQuotes = false

	for (const match of columnDelimiter.searchMatches(row, doubleQuoteSequence)) {
		if (match.patternId === 1) {
			insideQuotes = !insideQuotes
			continue
		}

		if (insideQuotes) continue

		columns.push(decodeColumn(row.subarray(sliceStart, match.offset), decoder, enableQuoteHandling))
		sliceStart = match.offset + columnDelimiter.length
	}

	columns.push(decodeColumn(row.subarray(sliceStart), decoder, enableQuoteHandling))

	return columns
}

export type CSVSpliteratorEmittedRecord<V = string | number | undefined> = {
	[key: string]: V
}

/**
 * A row emitted by the CSV generator, as a 3-tuple:
 *
 * - The key of the column.
 * - The value of the column.
 * - The index of the row.
 */
export type RowTuple<V = string | number> = [key: string, value: V, idx: number]

export const CSVSpliteratorEmitters = {
	array: null,

	entries(columns: Iterable<string>, headerColumns: Iterable<CSVTransformerEntry> = []): RowTuple<unknown>[] {
		return Array.from(zipSync(headerColumns, columns), ([transformer, value], idx) => {
			const key = transformer?.[0]
			const transform = transformer?.[1] ?? identity

			return [key ?? `column_${idx}`, transform(value ?? ""), idx]
		})
	},
	object(
		columns: Iterable<string>,
		headerColumns: Iterable<CSVTransformerEntry> = []
	): CSVSpliteratorEmittedRecord<unknown> {
		const record: CSVSpliteratorEmittedRecord<unknown> = {}

		for (const [transformer, value, idx] of zipSync(headerColumns, columns)) {
			const key = transformer?.[0] ?? `column_${idx}`
			const transform = transformer?.[1] ?? identity

			record[key] = transform(value ?? "")
		}

		return record
	},
} as const satisfies Record<CSVOutputMode, CSVEmitter | null>

export interface CSVSpliteratorInit extends SpliteratorInit {
	/**
	 * The mode determines the shape of the data emitted by the generator.
	 *
	 * - `object` will emit each row as an object with the header names as keys.
	 * - `array` will emit each row as an array.
	 * - `entries` will emit each row as an array of key-value pairs.
	 *
	 * Note that {@linkcode CSVSpliteratorInit.header} defaults to `true` in every mode — the first row is consumed as the
	 * header even in `array` mode. Pass `header: false` for headerless data.
	 *
	 * When {@linkcode SpliteratorInit.enableQuoteHandling} is set, quoting is handled end-to-end: rows do not split on
	 * delimiters inside quotes (embedded newlines stay in their row), columns do not split on quoted column delimiters,
	 * wrapping quotes are stripped, and doubled quotes (`""`) unescape to `"`.
	 *
	 * {@linkcode SpliteratorInit.crlf} defaults to `true` here (unlike everywhere else): RFC 4180 mandates CRLF row
	 * terminators, so a correct CSV parser must accept them without leaking `\r` into the last column.
	 */
	mode?: CSVOutputMode

	/**
	 * The delimiter to use for columns in a row.
	 *
	 * @default Delimiter.Comma
	 */
	columnDelimiter?: CharacterSequenceInput

	/**
	 * Whether to normalize the keys of the header row.
	 *
	 * This will convert all header names to lowercase and replace spaces with underscores, making them more suitable for
	 * use as object keys.
	 */
	normalizeKeys?: boolean

	/**
	 * Whether to treat the first row as a header.
	 *
	 * @default true
	 */
	header?: boolean

	transformers?: Iterable<CSVTransformerEntry> | CSVTransformerRecord
}

/**
 * A static class spliterator for comma-separated values.
 *
 * **Performance:** the SIMD delimiter scan wins when scanning dominates — many rows, a few columns pulled out cheaply,
 * streaming to bound memory. When per-row work is heavy (a full `JSON.parse`, expensive transforms) it can dominate the
 * scan and erase the advantage; benchmark against a mature native parser before swapping an existing loop for speed.
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

	static from<T extends CSVSpliteratorEmittedRecord = CSVSpliteratorEmittedRecord>(
		source: CharacterSequenceInput,
		options?: CSVSpliteratorInit & { mode: "object" }
	): Generator<T>
	/**
	 * @yields Each row as a 3-tuple [key, value, idx].
	 */

	static from<T extends RowTuple[] = RowTuple[]>(
		source: CharacterSequenceInput,
		options?: CSVSpliteratorInit & { mode: "entries" }
	): Generator<T>
	/**
	 * Given a byte array or string, yield each row as an array of columns.
	 *
	 * @yields Each row as an array of columns.
	 */
	static from<T extends string[] = string[]>(
		source: CharacterSequenceInput,
		options?: CSVSpliteratorInit & { mode?: "array" }
	): Generator<T>
	/**
	 * Given a byte array or string, yield each row as an array of columns.
	 *
	 * @yields Each row as an array of columns.
	 */
	static *from(source: CharacterSequenceInput, init: CSVSpliteratorInit = {}) {
		const {
			// ---
			header = true,
			transformers: transformersInput = [],
			normalizeKeys,
			mode = "array",
			columnDelimiter: columnDelimiterInput = this.ColumnDelimiter,
			enableQuoteHandling = false,
			// RFC 4180 mandates CRLF row terminators — accept them by default so the last column
			// never carries a stray `\r` on Windows-lineage sources.
			crlf = true,
			take = Infinity,
			drop = 0,
			...rowInit
		} = init

		const emitter = CSVSpliteratorEmitters[mode]
		let transformers: CSVTransformerEntry[] = []
		let yieldCount = 0
		const yieldLimit = take + drop

		const decoder = new TextDecoder()
		const columnDelimiter = new CharacterSequence(columnDelimiterInput ?? this.ColumnDelimiter)

		// Quote handling applies at both levels: rows must not split on newlines inside quotes,
		// columns must not split on quoted column delimiters.
		const rows = Spliterator.fromSync(source, { ...rowInit, crlf, enableQuoteHandling })

		if (header) {
			const result = rows.next()

			if (result.done) return

			const columns = splitRowColumns(result.value, columnDelimiter, decoder, enableQuoteHandling)
			const headers = normalizeKeys ? normalizeColumnNames(columns) : columns

			if (Array.isArray(transformersInput)) {
				transformers = Array.from(zipSync(headers, transformersInput), ([columnName, transformer]) => [
					columnName!,
					transformer ?? identity,
				])
			} else {
				transformers = headers.map((columnName) => {
					const transform = (transformersInput as CSVTransformerRecord)[columnName] || identity

					return [columnName, transform]
				})
			}
		}

		for (const row of rows) {
			if (yieldCount < drop) {
				yieldCount++
				continue
			}

			if (yieldCount >= yieldLimit) break

			const columns = splitRowColumns(row, columnDelimiter, decoder, enableQuoteHandling)

			yield emitter ? emitter(columns, transformers) : columns

			yieldCount++
		}
	}

	/**
	 * @yields Each row as an object with the header names as keys.
	 */
	static fromAsync<T extends CSVSpliteratorEmittedRecord = CSVSpliteratorEmittedRecord>(
		source: AsyncDataResource | AsyncChunkIterator,
		options?: CSVSpliteratorInit & AsyncSpliteratorInit & { mode: "object" }
	): AsyncGenerator<T>

	/**
	 * @yields Each row as a 3-tuple [key, value, idx].
	 */
	static fromAsync<T extends RowTuple[] = RowTuple[]>(
		source: AsyncDataResource | AsyncChunkIterator,
		options?: CSVSpliteratorInit & AsyncSpliteratorInit & { mode: "entries" }
	): AsyncGenerator<T>
	/**
	 * @yields Each row as an array of columns.
	 */
	static fromAsync<T extends string[] = string[]>(
		source: AsyncDataResource | AsyncChunkIterator,
		options?: CSVSpliteratorInit & AsyncSpliteratorInit & { mode?: "array" }
	): AsyncGenerator<T>
	/**
	 * Given an asychronous data source, splits the data by rows(usually by newline) and then by columns (usually by
	 * comma).
	 *
	 * @param source The data source to split.
	 * @param init Options for the spliterator.
	 *
	 * @yields Each row, shaped according to the `mode` option.
	 */
	static fromAsync(
		source: AsyncDataResource | AsyncChunkIterator,
		init?: CSVSpliteratorInit & AsyncSpliteratorInit
	): AsyncGenerator<unknown>
	/**
	 * Given an asychronous data source, splits the data by rows (usually by newline) and then by columns (usually by
	 * comma).
	 *
	 * @param source The data source to split.
	 * @param init Options for the spliterator.
	 *
	 * @yields Each row, shaped according to the `mode` option.
	 */
	static async *fromAsync(
		source: AsyncDataResource | AsyncChunkIterator,
		init: CSVSpliteratorInit & AsyncSpliteratorInit = {}
	) {
		const {
			// ---
			header = true,
			mode = "array",
			transformers: transformersInput = [],
			normalizeKeys = mode !== "array",
			columnDelimiter: columnDelimiterInput,
			enableQuoteHandling = false,
			// RFC 4180 mandates CRLF row terminators — accept them by default so the last column
			// never carries a stray `\r` on Windows-lineage sources.
			crlf = true,
			take = Infinity,
			drop = 0,
			...rowInit
		} = init

		const emitter = CSVSpliteratorEmitters[mode]
		let transformers: CSVTransformerEntry[] = []
		let yieldCount = 0
		const yieldLimit = take + drop

		const columnDelimiter = new CharacterSequence(columnDelimiterInput ?? this.ColumnDelimiter)

		const decoder = new TextDecoder()

		// Quote handling applies at both levels: rows must not split on newlines inside quotes,
		// columns must not split on quoted column delimiters.
		const rows = await Spliterator.from(source, { ...rowInit, crlf, enableQuoteHandling })

		if (header) {
			const result = await rows.next()

			if (result.done) return

			const columns = splitRowColumns(result.value, columnDelimiter, decoder, enableQuoteHandling)
			const headers = normalizeKeys ? normalizeColumnNames(columns) : columns

			if (Array.isArray(transformersInput)) {
				transformers = Array.from(zipSync(headers, transformersInput), ([columnName, transformer]) => [
					columnName!,
					transformer ?? identity,
				])
			} else {
				transformers = headers.map((columnName) => {
					const transform = (transformersInput as CSVTransformerRecord)[columnName] || identity

					return [columnName, transform]
				})
			}
		}

		for await (const row of rows) {
			if (yieldCount < drop) {
				yieldCount++
				continue
			}

			if (yieldCount >= yieldLimit) break

			const columns = splitRowColumns(row, columnDelimiter, decoder, enableQuoteHandling)

			yield emitter ? emitter(columns, transformers) : columns

			yieldCount++
		}
	}
}
