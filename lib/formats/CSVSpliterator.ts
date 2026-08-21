/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { CharacterSequence, type CharacterSequenceInput, Delimiters } from "../core/CharacterSequence.js"
import { type AsyncSpliteratorInit, Spliterator, type SpliteratorInit } from "../core/Spliterator.js"
import type { AsyncChunkIterator, AsyncDataResource } from "../internal/shared.js"
import { type AdaptiveSourceInit, openDelimitedRows } from "../io/adaptive-source.js"
import { AsyncSequence } from "../iterators/AsyncSequence.js"
import { normalizeColumnNames } from "./casing.js"
import {
	bindTransformers,
	createRowEmitters,
	type RowEmitter,
	type RowOutputMode,
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

const doubleQuoteSequence = new CharacterSequence('"')
const DOUBLE_QUOTE_CODE = 0x22

/**
 * Decode a single column, stripping wrapping quotes and unescaping doubled quotes (`""` → `"`) when quote handling is
 * on. The unescape allocates only when the field was actually quoted.
 */
function decodeColumn(bytes: Uint8Array, decoder: TextDecoder, enableQuoteHandling: boolean): string {
	const value = decoder.decode(bytes)

	return enableQuoteHandling ? unquoteColumn(value) : value
}

/**
 * Strip wrapping quotes and unescape doubled quotes (`""` → `"`). Allocates only when the field was actually quoted.
 *
 * Shared by both split paths rather than transcribed into each — the two must agree on what a quoted field means, and a
 * constant they both reference would not have proved that.
 */
function unquoteColumn(value: string): string {
	if (value.length >= 2 && value.charCodeAt(0) === DOUBLE_QUOTE_CODE && value.endsWith('"')) {
		return value.slice(1, -1).replaceAll('""', '"')
	}

	return value
}

/**
 * The column delimiter as a string, when it survives a byte→string→byte round trip.
 *
 * `null` for a delimiter that does not — a lone `0xFF`, a truncated multi-byte sequence — because `TextDecoder` maps
 * those to U+FFFD and a string search would then match the replacement character instead of the delimiter. Those
 * delimiters keep the byte scan below. Cached on the sequence: deriving it costs a decode plus an encode, which is
 * per-row work if recomputed and per-parse work if not.
 */
const delimiterStringCache = new WeakMap<CharacterSequence, string | null>()

function delimiterAsString(columnDelimiter: CharacterSequence): string | null {
	const cached = delimiterStringCache.get(columnDelimiter)

	if (cached !== undefined) return cached

	const decoded = new TextDecoder().decode(columnDelimiter)
	const reencoded = new TextEncoder().encode(decoded)

	const lossless =
		reencoded.length === columnDelimiter.length && reencoded.every((byte, i) => byte === columnDelimiter[i])

	const value = lossless ? decoded : null

	delimiterStringCache.set(columnDelimiter, value)

	return value
}

/**
 * Split one decoded row on `delimiter`, honouring double quotes.
 *
 * Callers MUST have established that `line` contains a quote — {@linkcode splitRowColumns} does, and takes
 * `String.prototype.split` when it does not. That split is not merely the cheaper branch: a quote-free row also cannot
 * have a quoted field, so it needs no unquote pass either, and hoisting the check lets the caller skip both. On a
 * 12-column FCC availability file 96% of rows take that path.
 */
function splitQuotedString(line: string, delimiter: string): string[] {
	const columns: string[] = []
	let sliceStart = 0
	let index = 0
	let insideQuotes = false

	while (index < line.length) {
		if (line.charCodeAt(index) === DOUBLE_QUOTE_CODE) {
			insideQuotes = !insideQuotes

			index++
		} else if (!insideQuotes && line.startsWith(delimiter, index)) {
			columns.push(line.slice(sliceStart, index))
			index += delimiter.length
			sliceStart = index
		} else {
			index++
		}
	}

	columns.push(line.slice(sliceStart))

	return columns
}

/**
 * Split one row's bytes into decoded column strings.
 *
 * Without quote handling this is a plain delimiter scan. With it, a column delimiter inside a double-quoted region does
 * not split, and each field is unquoted/unescaped via {@linkcode decodeColumn}. Empty columns are always preserved — a
 * 30-column row must stay 30 columns regardless of the caller's row-level `skipEmpty`.
 *
 * ## Decode the row ONCE
 *
 * The byte-scan path below decodes per COLUMN, and `TextDecoder.decode`'s per-call overhead dominates at column sizes.
 * Measured on a real 12-column, ~110-byte CSV row, 2,000,000 iterations:
 *
 *     scan only, no decode                    370 ns/row
 *     one decode of the whole row              51 ns/row
 *     scan + twelve per-column decodes      1,234 ns/row   <- the old path
 *     one decode + quote-aware string split   307 ns/row   <- this path
 *
 * Twelve small decodes cost 864 ns/row over the scan they sit on; one decode of the same bytes costs 51. So the string
 * path is not merely cheaper than decoding per column — it is cheaper than the byte scan alone, because `String`'s
 * split and `startsWith` are intrinsics while the scan runs a generator per row.
 *
 * The SIMD scanner does not apply here either way: it engages at `WASM_THRESHOLD`, and a single row is far below it.
 * Row-level splitting, whose haystack is the whole buffer, is where that path earns its keep.
 */
function splitRowColumns(
	row: Uint8Array,
	columnDelimiter: CharacterSequence,
	decoder: TextDecoder,
	enableQuoteHandling: boolean
): string[] {
	const delimiter = delimiterAsString(columnDelimiter)

	if (delimiter !== null) {
		const line = decoder.decode(row)

		// A row with no quote in it cannot split differently under quote handling, and cannot hold a quoted field
		// either — so BOTH the walk and the unquote pass are skipped, not just the walk.
		if (!enableQuoteHandling || line.indexOf('"') === -1) return line.split(delimiter)

		const columns = splitQuotedString(line, delimiter)

		for (let i = 0; i < columns.length; i++) {
			columns[i] = unquoteColumn(columns[i]!)
		}

		return columns
	}

	// A delimiter that does not round-trip through UTF-8 keeps the byte scan.
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

export type CSVSpliteratorEmittedRecord<V = string | number | undefined> = Record<string, V>

export const CSVSpliteratorEmitters: Record<CSVOutputMode, CSVEmitter | null> = createRowEmitters<string>("")

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
	 * Whether to normalize the keys of the header row into `snake_case`, and to disambiguate duplicates by suffixing
	 * `_2`, `_3`, … — making them usable as object keys.
	 *
	 * **A header that is already ALL CAPS is left alone**, on the reasoning that its casing is deliberate. So an
	 * OpenAddresses header (`LON,LAT,NUMBER,STREET`) normalizes to `LON`/`NUMBER`, NOT `lon`/`number`, and a row is read
	 * as `row.STREET`. Lower-case your own keys if you want case-folding — this option does not provide it.
	 *
	 * @default `mode !== "array"` — object and entries rows need keyable names; array rows have no keys to normalize.
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
			// `mode` is destructured before `normalizeKeys` because the latter's default reads it.
			mode = "array",
			transformers: transformersInput = [],
			// Matches `fromAsync`. These two defaulted differently until 4.0.1, so the same options
			// object produced `row.some_name` from one entry point and `row["Some Name"]` from the other.
			normalizeKeys = mode !== "array",
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

			transformers = bindTransformers(headers, transformersInput)
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
	): AsyncSequence<T>

	/**
	 * @yields Each row as a 3-tuple [key, value, idx].
	 */
	static fromAsync<T extends RowTuple[] = RowTuple[]>(
		source: AsyncDataResource | AsyncChunkIterator,
		options?: CSVSpliteratorInit & AsyncSpliteratorInit & { mode: "entries" }
	): AsyncSequence<T>
	/**
	 * @yields Each row as an array of columns.
	 */
	static fromAsync<T extends string[] = string[]>(
		source: AsyncDataResource | AsyncChunkIterator,
		options?: CSVSpliteratorInit & AsyncSpliteratorInit & { mode?: "array" }
	): AsyncSequence<T>
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
	): AsyncSequence<unknown>
	/**
	 * Given an asychronous data source, splits the data by rows (usually by newline) and then by columns (usually by
	 * comma).
	 *
	 * @param source The data source to split.
	 * @param init Options for the spliterator.
	 *
	 * @yields Each row, shaped according to the `mode` option.
	 */
	static fromAsync(
		source: AsyncDataResource | AsyncChunkIterator,
		init: CSVSpliteratorInit & AdaptiveSourceInit = {}
	): AsyncSequence<unknown> {
		const defaultColumnDelimiter = this.ColumnDelimiter

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
		const columnDelimiter = new CharacterSequence(columnDelimiterInput ?? defaultColumnDelimiter)
		const decoder = new TextDecoder()

		// Populated by the header pass below before the first row op runs, since the source thunk resolves on the first
		// pull and the ops only run against what it returns.
		let transformers: CSVTransformerEntry[] = []

		const openRows = async (): Promise<AsyncIterable<Uint8Array> | Iterable<Uint8Array>> => {
			// Quote handling applies at both levels: rows must not split on newlines inside quotes,
			// columns must not split on quoted column delimiters.
			const rows = await openDelimitedRows(source, { ...rowInit, crlf, enableQuoteHandling })

			if (header) {
				// Both engines return `this` from their iterator method, so consuming the header row here advances the very
				// cursor the row ops will go on to read — returning `rows` afterwards resumes at row two, not row one.
				const iterator = Symbol.asyncIterator in rows ? rows[Symbol.asyncIterator]() : rows[Symbol.iterator]()
				const result = await iterator.next()

				if (result.done) return rows

				const columns = splitRowColumns(result.value, columnDelimiter, decoder, enableQuoteHandling)
				const headers = normalizeKeys ? normalizeColumnNames(columns) : columns

				transformers = bindTransformers(headers, transformersInput)
			}

			return rows
		}

		let sequence: AsyncSequence<unknown> = AsyncSequence.from<Uint8Array>(openRows).map((row) => {
			const columns = splitRowColumns(row, columnDelimiter, decoder, enableQuoteHandling)

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
