/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { zipSync } from "../iterators/zip.js"

/**
 * An output mode for row-emitting spliterators.
 */
export type RowOutputMode = "array" | "object" | "entries"

export type RowTransformer<V, T = unknown> = (value: V) => T

export type RowTransformerEntry<V, T = unknown> = [columnName: string, transformer: RowTransformer<V, T>]

export type RowTransformerRecord<V> = Record<string, RowTransformer<V> | undefined>

/**
 * Options shared by spliterators that turn headered rows into arrays, records, or entries.
 */
export interface RowSpliteratorInit<V> {
	/**
	 * Whether to treat the first row as a header.
	 *
	 * @default true
	 */
	header?: boolean

	/**
	 * The shape of each emitted data row.
	 *
	 * The default follows `header`:
	 *
	 * - A header row (the default) produces `"object"` rows.
	 * - `header: false` produces `"array"` rows.
	 *
	 * Set a mode explicitly to override that default.
	 */
	mode?: RowOutputMode

	/**
	 * Whether to normalize header keys into `snake_case` and disambiguate duplicates by suffixing `_2`, `_3`, ….
	 *
	 * @default `mode !== "array"`
	 */
	normalizeKeys?: boolean

	/**
	 * Per-column transformers, called with each cell's native value.
	 */
	transformers?: Iterable<RowTransformerEntry<V>> | RowTransformerRecord<V>

	/**
	 * The number of data rows to skip before yielding.
	 */
	drop?: number

	/**
	 * The maximum number of data rows to yield.
	 */
	take?: number
}

export type RowEmitter<V, T = unknown> = (columns: Iterable<V>, headerColumns?: Iterable<RowTransformerEntry<V>>) => T

export type EmittedRecord<V = unknown> = Record<string, V>

/**
 * A row emitted in `entries` mode, as a 3-tuple:
 *
 * - The key of the column.
 * - The value of the column.
 * - The index of the row.
 */
export type RowTuple<V = string | number> = [key: string, value: V, idx: number]

export const identity = <V>(value: V): V => value

/**
 * Create the `mode`-keyed emitter table for a cell type.
 *
 * `missingValue` fills columns absent from a short row (CSV binds `""`, XLSX binds `null`).
 */
export function createRowEmitters<V>(missingValue: V): Record<RowOutputMode, RowEmitter<V> | null> {
	return {
		array: null,

		entries(columns: Iterable<V>, headerColumns: Iterable<RowTransformerEntry<V>> = []): RowTuple<unknown>[] {
			return Array.from(zipSync(headerColumns, columns), ([transformer, value], idx) => {
				const key = transformer?.[0]
				const transform = transformer?.[1] ?? identity

				return [key ?? `column_${idx}`, transform(value ?? missingValue), idx]
			})
		},
		object(columns: Iterable<V>, headerColumns: Iterable<RowTransformerEntry<V>> = []): EmittedRecord<unknown> {
			const record: EmittedRecord<unknown> = {}

			for (const [transformer, value, idx] of zipSync(headerColumns, columns)) {
				const key = transformer?.[0] ?? `column_${idx}`
				const transform = transformer?.[1] ?? identity

				record[key] = transform(value ?? missingValue)
			}

			return record
		},
	}
}

/**
 * Bind a header row to the caller's transformers, producing the `headerColumns` entries the emitters consume. Columns
 * without a transformer pass through {@linkcode identity}.
 */
export function bindTransformers<V>(
	headers: string[],
	transformersInput: Iterable<RowTransformerEntry<V>> | RowTransformerRecord<V>
): RowTransformerEntry<V>[] {
	if (Array.isArray(transformersInput)) {
		return Array.from(zipSync(headers, transformersInput), ([columnName, transformer]) => [
			columnName!,
			(transformer as RowTransformer<V> | undefined) ?? identity,
		])
	}

	return headers.map((columnName) => {
		const transform = (transformersInput as RowTransformerRecord<V>)[columnName] || identity

		return [columnName, transform]
	})
}
