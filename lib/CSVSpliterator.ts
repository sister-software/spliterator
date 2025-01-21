/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { normalizeColumnNames } from "./casing.js"
import { CharacterSequence, CharacterSequenceInput, Delimiters } from "./CharacterSequence.js"
import { AsyncChunkIterator, AsyncDataResource, zipSync } from "./shared.js"
import { AsyncSpliteratorInit, Spliterator, SpliteratorInit } from "./Spliterator.js"

/**
 * An output mode for the CSV generator.
 */
export type CSVOutputMode = "array" | "object" | "entries"
export type CSVTransformer<T = unknown> = (value: string) => T

export type CSVTransformerEntry<T = unknown> = [columnName: string, transformer: CSVTransformer<T>]
export type CSVTransformerRecord = Record<string, CSVTransformer | undefined>

export type CSVEmitter<T = unknown> = (columns: Iterable<string>, headerColumns?: Iterable<CSVTransformerEntry>) => T

const identity: CSVTransformer<string> = (value) => value

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
	 * This will convert all header names to lowercase and replace spaces with underscores, making
	 * them more suitable for use as object keys.
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

export abstract class CSVSpliterator {
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
			columnDelimiter: columnDelimiterInput = Delimiters.Comma,
			take = Infinity,
			drop = 0,
			...rowInit
		} = init

		const emitter = CSVSpliteratorEmitters[mode]
		let transformers: CSVTransformerEntry[] = []
		let yieldCount = 0
		const yieldLimit = take + drop

		const decoder = new TextDecoder()
		const columnDelimiter = new CharacterSequence(columnDelimiterInput ?? Delimiters.Comma)
		const columnSpliteratorInit: SpliteratorInit = { delimiter: columnDelimiter }

		const rows = Spliterator.from(source, rowInit)

		if (header) {
			const result = rows.next()

			if (result.done) return

			const columns = new Spliterator(result.value, columnSpliteratorInit).toDecodedArray(decoder)
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

			const columns = new Spliterator(row, columnSpliteratorInit).toDecodedArray(decoder)

			yield emitter ? emitter(columns, transformers) : columns
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
	 * Given an asychronous data source, splits the data by rows(usually by newline) and then by
	 * columns (usually by comma).
	 *
	 * @param source The data source to split.
	 * @param init Options for the spliterator.
	 * @yields Each row, shaped according to the `mode` option.
	 */
	static fromAsync(
		source: AsyncDataResource | AsyncChunkIterator,
		init?: CSVSpliteratorInit & AsyncSpliteratorInit
	): AsyncGenerator<unknown>
	/**
	 * Given an asychronous data source, splits the data by rows (usually by newline) and then by
	 * columns (usually by comma).
	 *
	 * @param source The data source to split.
	 * @param init Options for the spliterator.
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
			take = Infinity,
			drop = 0,
			...rowInit
		} = init

		const emitter = CSVSpliteratorEmitters[mode]
		let transformers: CSVTransformerEntry[] = []
		let yieldCount = 0
		const yieldLimit = take + drop

		const columnDelimiter = new CharacterSequence(columnDelimiterInput ?? Delimiters.Comma)
		const columnSpliteratorInit: SpliteratorInit = { delimiter: columnDelimiter }

		const decoder = new TextDecoder()

		const rows = await Spliterator.from(source, rowInit)

		if (header) {
			const result = await rows.next()

			if (result.done) return

			const columns = new Spliterator(result.value, columnSpliteratorInit).toDecodedArray(decoder)
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

			const columns = new Spliterator(row, columnSpliteratorInit).toDecodedArray(decoder)

			yield emitter ? emitter(columns, transformers) : columns

			yieldCount++
		}
	}
}
