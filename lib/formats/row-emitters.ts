/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

import { zipSync } from "#iterators/zip"

/**
 * An output mode for row-emitting spliterators.
 */
export type RowOutputMode = "array" | "object" | "entries"

export type RowTransformer<V, T = unknown> = (value: V) => T

export type RowTransformerEntry<V, T = unknown> = [columnName: string, transformer: RowTransformer<V, T>]

export type RowTransformerRecord<V> = Record<string, RowTransformer<V> | undefined>

/**
 * Options shared by spliterators that shape rows as arrays, records, or entries.
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
	 * - `"object"` maps columns to header names.
	 * - `"array"` preserves positional columns.
	 * - `"entries"` emits `[key, value, index]` tuples.
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
/**
 * Rows per bound header before the emitter compiles a builder for it. A compile is a `new Function` call, tens of
 * microseconds, which a 20-row file would never earn back; a 10k-row file earns it back a hundred times over.
 */
const COMPILE_AFTER_ROWS = 32

/**
 * Above this many columns the generated source stops being worth it and the loop handles the row.
 */
const COMPILE_MAX_COLUMNS = 2048

interface BuilderState<V> {
	rows: number
	/**
	 * `null` until compiled, `false` once compilation was tried and refused (a CSP that forbids `new Function`, too many
	 * columns), so it is not retried per row.
	 */
	object: ((columns: readonly V[]) => EmittedRecord<unknown>) | null | false
	entries: ((columns: readonly V[]) => RowTuple<unknown>[]) | null | false
}

/**
 * Generate a builder whose body is an object or array literal with the header's keys written in as constants.
 *
 * V8 allocates a literal with a known shape in one step and stores each field at a fixed offset, where `record[key] =
 * value` over 20 dynamic keys goes through a keyed store per cell. Measured on uDSV's 10k × 20 litmus fixture: 6.7ms
 * per parse of dynamic stores against 0.25ms for the literal, with the rows escaping. uDSV's `genToTypedRow` is the
 * same trick. Transformers are called through an array captured by the generated function; `JSON.stringify` makes every
 * header a valid string-literal key, including `__proto__`, which then sets the prototype exactly as the dynamic store
 * did.
 */
function compileBuilder<V>(
	mode: "object" | "entries",
	headerColumns: readonly RowTransformerEntry<V>[],
	missingValue: V
): ((columns: readonly V[]) => never) | false {
	if (headerColumns.length > COMPILE_MAX_COLUMNS) return false

	const fields = headerColumns.map(([key], idx) => {
		const value = `f[${idx}](${idx} < c.length ? c[${idx}] : m)`

		return mode === "object" ? `${JSON.stringify(key)}: ${value}` : `[${JSON.stringify(key)}, ${value}, ${idx}]`
	})

	const literal = mode === "object" ? `{${fields.join(",\n")}}` : `[${fields.join(",\n")}]`

	try {
		// The generated source is built from JSON-encoded header names and integer indices only; no caller string is
		// spliced in unquoted. The literal is the point, see the doc comment above.
		// oxlint-disable-next-line typescript/no-implied-eval
		const make = new Function("f", "m", `return function builtRow(c) { return ${literal} }`) as (
			transformers: RowTransformer<V>[],
			missing: V
		) => (columns: readonly V[]) => never

		return make(
			headerColumns.map(([, transformer]) => transformer),
			missingValue
		)
	} catch {
		// A Content-Security-Policy without 'unsafe-eval' throws here. The loop below is the same result, slower.
		return false
	}
}

/**
 * Create the `mode`-keyed emitter table for a cell type.
 *
 * `missingValue` fills columns absent from a short row (CSV binds `""`, XLSX binds `null`).
 *
 * Both arguments are arrays on every path in this package, and an array row against a bound header takes the fast paths
 * below: an indexed loop, and after {@linkcode COMPILE_AFTER_ROWS} rows for the same header a compiled literal (see
 * {@linkcode compileBuilder}). An iterator step and a tuple per cell through `zipSync` was 50% of object mode and the
 * dynamic keyed stores most of the rest; the generator path remains for callers that hand in other iterables.
 */
export function createRowEmitters<V>(missingValue: V): Record<RowOutputMode, RowEmitter<V> | null> {
	// One shared empty header so a header-less row still accumulates toward a compiled builder.
	const NO_HEADER: RowTransformerEntry<V>[] = []
	const builders = new WeakMap<readonly RowTransformerEntry<V>[], BuilderState<V>>()

	const stateFor = (headerColumns: readonly RowTransformerEntry<V>[]): BuilderState<V> => {
		let state = builders.get(headerColumns)

		if (!state) {
			state = { rows: 0, object: null, entries: null }

			builders.set(headerColumns, state)
		}

		state.rows++

		return state
	}

	// Columns past the header have no name: `column_<idx>`, as the loop and generator paths name them.
	const appendUnnamed = (record: EmittedRecord<unknown>, columns: readonly V[], from: number) => {
		for (let idx = from; idx < columns.length; idx++) {
			record[`column_${idx}`] = columns[idx]
		}

		return record
	}

	return {
		array: null,

		entries(columns: Iterable<V>, headerColumns: Iterable<RowTransformerEntry<V>> = NO_HEADER): RowTuple<unknown>[] {
			if (Array.isArray(columns) && Array.isArray(headerColumns)) {
				const state = stateFor(headerColumns)

				if (state.entries === null && state.rows > COMPILE_AFTER_ROWS) {
					state.entries = compileBuilder("entries", headerColumns, missingValue)
				}

				if (state.entries) {
					const tuples = state.entries(columns)

					for (let idx = headerColumns.length; idx < columns.length; idx++) {
						tuples.push([`column_${idx}`, columns[idx], idx])
					}

					return tuples
				}

				const length = Math.max(columns.length, headerColumns.length)
				const tuples = new Array<RowTuple<unknown>>(length)

				for (let idx = 0; idx < length; idx++) {
					const transformer = headerColumns[idx] as RowTransformerEntry<V> | undefined
					const value = idx < columns.length ? (columns[idx] as V) : missingValue

					tuples[idx] = [
						transformer ? transformer[0] : `column_${idx}`,
						transformer ? transformer[1](value) : value,
						idx,
					]
				}

				return tuples
			}

			return Array.from(zipSync(headerColumns, columns), ([transformer, value], idx) => {
				const key = transformer?.[0]
				const transform = transformer?.[1] ?? identity

				return [key ?? `column_${idx}`, transform(value ?? missingValue), idx]
			})
		},
		object(columns: Iterable<V>, headerColumns: Iterable<RowTransformerEntry<V>> = NO_HEADER): EmittedRecord<unknown> {
			if (Array.isArray(columns) && Array.isArray(headerColumns)) {
				const state = stateFor(headerColumns)

				if (state.object === null && state.rows > COMPILE_AFTER_ROWS) {
					state.object = compileBuilder("object", headerColumns, missingValue)
				}

				if (state.object) {
					const record = state.object(columns)

					return columns.length > headerColumns.length ? appendUnnamed(record, columns, headerColumns.length) : record
				}

				const record: EmittedRecord<unknown> = {}
				const length = Math.max(columns.length, headerColumns.length)

				for (let idx = 0; idx < length; idx++) {
					const transformer = headerColumns[idx] as RowTransformerEntry<V> | undefined
					const value = idx < columns.length ? (columns[idx] as V) : missingValue

					record[transformer ? transformer[0] : `column_${idx}`] = transformer ? transformer[1](value) : value
				}

				return record
			}

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
	// Entries bind by column name, never by position: `[["age", Number]]` applies to `age` wherever it sits.
	const byName: Record<string, RowTransformer<V> | undefined> =
		Symbol.iterator in transformersInput
			? Object.fromEntries(transformersInput as Iterable<RowTransformerEntry<V>>)
			: (transformersInput as RowTransformerRecord<V>)

	// Own properties only: a header named `constructor` or `__proto__` would otherwise pick up Object.prototype's.
	return headers.map((columnName) => [
		columnName,
		Object.hasOwn(byName, columnName) ? (byName[columnName] ?? identity) : identity,
	])
}
