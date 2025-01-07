/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { normalizeColumnNames } from "./casing.js"
import { CharacterSequence, CharacterSequenceInput, Delimiters, takeDelimited } from "./CharacterSequence.js"
import { AsyncDataResource, zipSync } from "./shared.js"
import { AsyncSpliteratorInit, Spliterator, SpliteratorInit } from "./Spliterator.js"

/**
 * An output mode for the CSV generator.
 */
export type CSVOutputMode = "array" | "object" | "entries"
export type CSVEmitter<T = unknown> = (columns: Iterable<string>, headerColumns?: Iterable<string>) => T

export type CSVSpliteratorEmittedRecord = {
	[key: string]: string | number | undefined
}

/**
 * A row emitted by the CSV generator, as a 3-tuple:
 *
 * - The key of the column.
 * - The value of the column.
 * - The index of the row.
 */
export type RowTuple = [key: string, value: string | number, idx: number]

export const CSVSpliteratorEmitters = {
	array: null,

	entries(columns: Iterable<string>, headerColumns: Iterable<string> = []): RowTuple[] {
		return Array.from(zipSync(headerColumns, columns), ([key, value], idx) => {
			return [key ?? `column_${idx}`, value ?? "", idx]
		})
	},
	object(columns: Iterable<string>, headerColumns: Iterable<string> = []): CSVSpliteratorEmittedRecord {
		const record = Object.fromEntries(Array.from(zipSync(headerColumns, columns)))

		return record
	},
} as const satisfies Record<CSVOutputMode, CSVEmitter | null>

export interface CSVSpliteratorOptions {
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

	/**
	 * How many rows to skip before emitting data.
	 *
	 * This is useful for skipping headers or other metadata.
	 *
	 * Defaults to 1 if `header` is true, otherwise 0.
	 */
	skip?: number
}

export abstract class CSVSpliterator {
	constructor() {
		throw new TypeError("Static class cannot be instantiated. Did you mean `CSVSpliterator.from`?")
	}

	static from<T extends CSVSpliteratorEmittedRecord = CSVSpliteratorEmittedRecord>(
		source: CharacterSequenceInput,
		options: CSVSpliteratorOptions & SpliteratorInit & { mode: "object" }
	): Generator<T>
	/**
	 * @yields Each row as a 3-tuple [key, value, idx].
	 */

	static from<T extends RowTuple[] = RowTuple[]>(
		source: CharacterSequenceInput,
		options: CSVSpliteratorOptions & SpliteratorInit & { mode: "entries" }
	): Generator<T>
	/**
	 * Given a byte array or string, yield each row as an array of columns.
	 *
	 * @yields Each row as an array of columns.
	 */
	static from<T extends string[] = string[]>(
		source: CharacterSequenceInput,
		options: CSVSpliteratorOptions & SpliteratorInit & { mode?: "array" }
	): Generator<T>
	/**
	 * Given a byte array or string, yield each row as an array of columns.
	 *
	 * @yields Each row as an array of columns.
	 */
	static *from(source: CharacterSequenceInput, options: CSVSpliteratorOptions & SpliteratorInit = {}) {
		const {
			// ---
			header = true,
			skip = header ? 1 : 0,
			normalizeKeys,
			mode = "array",
			columnDelimiter: columnDelimiterInput = Delimiters.Comma,
			...rowOptions
		} = options

		let headerColumns: string[] = []

		const emitter = CSVSpliteratorEmitters[mode]

		let rowCursor = 0

		const decoder = new TextDecoder()
		const columnDelimiter = new CharacterSequence(columnDelimiterInput)
		const spliterator = Spliterator.from(source, rowOptions)

		for (const row of spliterator) {
			let columns = Array.from(takeDelimited(row, columnDelimiter), (column) => decoder.decode(column))

			if (header && rowCursor === 0) {
				headerColumns = normalizeKeys ? normalizeColumnNames(columns) : columns
				columns = headerColumns
			}

			if (skip && rowCursor < skip) {
				rowCursor++

				continue
			}

			yield emitter ? emitter(columns, headerColumns) : columns
		}
	}

	static fromAsync<T extends CSVSpliteratorEmittedRecord = CSVSpliteratorEmittedRecord>(
		source: AsyncDataResource,
		options?: CSVSpliteratorOptions & AsyncSpliteratorInit & { mode: "object" }
	): AsyncGenerator<T>
	/**
	 * @yields Each row as a 3-tuple [key, value, idx].
	 */

	static fromAsync<T extends RowTuple[] = RowTuple[]>(
		source: AsyncDataResource,
		options?: CSVSpliteratorOptions & AsyncSpliteratorInit & { mode: "entries" }
	): AsyncGenerator<T>
	/**
	 * Given a byte array or string, yield each row as an array of columns.
	 *
	 * @yields Each row as an array of columns.
	 */
	static fromAsync<T extends string[] = string[]>(
		source: AsyncDataResource,
		options?: CSVSpliteratorOptions & AsyncSpliteratorInit & { mode?: "array" }
	): AsyncGenerator<T>
	/**
	 * Given a byte array or string, yield each row as an array of columns.
	 *
	 * @yields Each row as an array of columns.
	 */
	static async *fromAsync(source: AsyncDataResource, options: CSVSpliteratorOptions & AsyncSpliteratorInit = {}) {
		const {
			// ---
			header = true,
			skip = header ? 1 : 0,
			mode = "array",
			normalizeKeys = mode !== "array",
			columnDelimiter: columnDelimiterInput,
			...rowOptions
		} = options

		let headerColumns: string[] = []

		const emitter = CSVSpliteratorEmitters[mode]

		let rowCursor = 0

		const columnDelimiter = new CharacterSequence(columnDelimiterInput ?? Delimiters.Comma)
		const decoder = new TextDecoder()
		const splitter = await Spliterator.fromAsync(source, rowOptions)

		for await (const row of splitter) {
			let columns = Array.from(takeDelimited(row, columnDelimiter), (column) => decoder.decode(column))

			if (header && rowCursor === 0) {
				headerColumns = normalizeKeys ? normalizeColumnNames(columns) : columns
				columns = headerColumns
			}

			if (skip && rowCursor < skip) {
				rowCursor++

				continue
			}

			yield emitter ? emitter(columns, headerColumns) : columns
		}
	}
}
