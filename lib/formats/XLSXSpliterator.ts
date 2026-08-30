/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import type { AsyncChunkIterator } from "../internal/shared.js"
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

/**
 * A cell value as parsed from an XLSX sheet. Unlike CSV columns, XLSX cells arrive typed — numbers, booleans, and dates
 * are real values, not strings — and an empty cell is `null`.
 */
export type XLSXCellValue = string | number | boolean | Date | null

export type XLSXTransformer<T = unknown> = RowTransformer<XLSXCellValue, T>

export type XLSXTransformerEntry<T = unknown> = RowTransformerEntry<XLSXCellValue, T>

export type XLSXTransformerRecord = RowTransformerRecord<XLSXCellValue>

export type XLSXSpliteratorEmittedRecord<V = XLSXCellValue> = Record<string, V>

/**
 * A readable XLSX source: a file path, a whole workbook in memory, or an asynchronous byte stream.
 */
export type XLSXSource = string | URL | Uint8Array | AsyncChunkIterator

/**
 * A row accepted by {@linkcode XLSXSpliterator.write}: either an array of cells, or a record whose keys become the
 * header row. `undefined` cells are written as empty (`null`) cells, so records read under `noUncheckedIndexedAccess`
 * pass through without ceremony.
 */
export type XLSXWritableRow =
	| readonly (XLSXCellValue | undefined)[]
	| Readonly<Record<string, XLSXCellValue | undefined>>

export const XLSXSpliteratorEmitters: Record<RowOutputMode, RowEmitter<XLSXCellValue> | null> =
	createRowEmitters<XLSXCellValue>(null)

export interface XLSXSpliteratorInit {
	/**
	 * The sheet to read, as a 1-based sheet number or a sheet name.
	 *
	 * @default 1
	 */
	sheet?: number | string

	/**
	 * The mode determines the shape of the data emitted by the generator.
	 *
	 * - `object` will emit each row as an object with the header names as keys.
	 * - `array` will emit each row as an array.
	 * - `entries` will emit each row as an array of key-value pairs.
	 *
	 * @default "array"
	 */
	mode?: RowOutputMode

	/**
	 * Whether to treat the first row as a header.
	 *
	 * @default true
	 */
	header?: boolean

	/**
	 * Whether to normalize the keys of the header row into `snake_case`, matching {@linkcode CSVSpliterator}.
	 *
	 * @default `mode !== "array"`
	 */
	normalizeKeys?: boolean

	/**
	 * Per-column transformers. Unlike CSV transformers, these receive typed cell values ({@linkcode XLSXCellValue}), not
	 * strings.
	 */
	transformers?: Iterable<XLSXTransformerEntry> | XLSXTransformerRecord

	/**
	 * The number of data rows to skip before yielding.
	 */
	drop?: number

	/**
	 * The maximum number of rows to yield.
	 */
	take?: number
}

export interface XLSXWriteInit {
	/**
	 * The name of the written sheet.
	 */
	sheet?: string

	/**
	 * Whether to emit a header row.
	 *
	 * @default true for record rows — the header is derived from the first record's keys. Array rows have no keys, so
	 *   this defaults to false and enabling it is a `TypeError`.
	 */
	header?: boolean
}

/**
 * A handle over a pending XLSX serialization. The source rows are materialized on the first invocation of any method —
 * XLSX is a ZIP archive, so the workbook must be complete before any bytes can be produced.
 */
export interface XLSXWriteHandle {
	toFile(path: string): Promise<void>
	toBuffer(): Promise<Buffer>
	toStream(writable?: NodeJS.WritableStream): Promise<unknown>
}

/**
 * Wrap the optional peer dependency import so a missing module names the package to install.
 */
async function importVendor<T>(packageName: string, importer: () => Promise<T>): Promise<T> {
	try {
		return await importer()
	} catch (error) {
		throw new Error(
			`XLSXSpliterator requires the optional peer dependency "${packageName}". Install it to use this API.`,
			{ cause: error }
		)
	}
}

/**
 * Adapt a {@linkcode XLSXSource} to what `read-excel-file/node` accepts: a path, a `Buffer`, or a Node stream.
 */
async function resolveVendorInput(source: XLSXSource) {
	if (typeof source === "string") return source

	if (source instanceof URL) {
		const { fileURLToPath } = await import("node:url")

		return fileURLToPath(source)
	}

	if (source instanceof Uint8Array) {
		// Respect the byte offset: small `Buffer`s share a pool, so offset 0 of the
		// underlying `ArrayBuffer` may be another allocation's data.
		return Buffer.from(source.buffer, source.byteOffset, source.byteLength)
	}

	const { Readable } = await import("node:stream")

	return Readable.from(source)
}

/**
 * A static class spliterator for XLSX workbooks, reading through the optional peer dependency `read-excel-file` and
 * writing through `write-excel-file`.
 *
 * **Memory:** XLSX is a ZIP archive of XML documents — shared strings live in a separate archive entry, and the central
 * directory sits at the end of the file. Both reading and writing therefore materialize the whole workbook, unlike the
 * byte-level spliterators. Prefer CSV for sources large enough that bounded memory matters.
 *
 * @see {@linkcode XLSXSpliterator.fromAsync} for reading.
 * @see {@linkcode XLSXSpliterator.write} for writing.
 */
export abstract class XLSXSpliterator {
	constructor() {
		throw new TypeError("Static class cannot be instantiated. Did you mean `XLSXSpliterator.fromAsync`?")
	}

	/**
	 * XLSX cannot be parsed synchronously — decompression and XML parsing are asynchronous in the underlying reader.
	 *
	 * @throws {TypeError} Always. Use {@linkcode XLSXSpliterator.fromAsync}.
	 */
	static from(_source?: unknown, _init?: unknown): never {
		throw new TypeError("XLSX cannot be parsed synchronously. Did you mean `XLSXSpliterator.fromAsync`?")
	}

	/**
	 * @yields Each row as an object with the header names as keys.
	 */
	static fromAsync<T extends object = XLSXSpliteratorEmittedRecord>(
		source: XLSXSource,
		options?: XLSXSpliteratorInit & { mode: "object" }
	): AsyncSequence<T>
	/**
	 * @yields Each row as a 3-tuple [key, value, idx].
	 */
	static fromAsync<T extends RowTuple<unknown>[] = RowTuple<XLSXCellValue>[]>(
		source: XLSXSource,
		options?: XLSXSpliteratorInit & { mode: "entries" }
	): AsyncSequence<T>
	/**
	 * @yields Each row as an array of typed cells.
	 */
	static fromAsync<T extends XLSXCellValue[] = XLSXCellValue[]>(
		source: XLSXSource,
		options?: XLSXSpliteratorInit & { mode?: "array" }
	): AsyncSequence<T>
	/**
	 * Given an XLSX workbook, yield each row of a sheet, shaped according to the `mode` option.
	 *
	 * Note that unlike the byte-level spliterators, the whole sheet is materialized before the first row is yielded.
	 *
	 * @param source The workbook to read.
	 * @param init Options for the spliterator.
	 *
	 * @yields Each row, shaped according to the `mode` option.
	 */
	static fromAsync(source: XLSXSource, init: XLSXSpliteratorInit = {}): AsyncSequence<unknown> {
		const {
			// ---
			sheet = 1,
			header = true,
			mode = "array",
			transformers: transformersInput = [],
			normalizeKeys = mode !== "array",
			take = Infinity,
			drop = 0,
		} = init

		const emitter = XLSXSpliteratorEmitters[mode]

		// Populated by the header pass below before the first row op runs, matching `CSVSpliterator.fromAsync`.
		let transformers: XLSXTransformerEntry[] = []

		const openRows = async (): Promise<Iterable<XLSXCellValue[]>> => {
			const { readSheet } = await importVendor("read-excel-file", () => import("read-excel-file/node"))
			const input = await resolveVendorInput(source)
			const rows = (await readSheet(input, sheet)) as XLSXCellValue[][]

			if (!header) return rows

			const headerRow = rows[0]

			if (!headerRow) return []

			// A header row may legally contain non-string cells — stringify before normalization.
			const columns = headerRow.map((cell) => String(cell ?? ""))
			const headers = normalizeKeys ? normalizeColumnNames(columns) : columns

			transformers = bindTransformers<XLSXCellValue>(headers, transformersInput)

			return rows.slice(1)
		}

		let sequence: AsyncSequence<unknown> = AsyncSequence.from<XLSXCellValue[]>(openRows).map((row) => {
			return emitter ? emitter(row, transformers) : row
		})

		if (drop > 0) {
			sequence = sequence.drop(drop)
		}

		if (Number.isFinite(take)) {
			sequence = sequence.take(take)
		}

		return sequence
	}

	/**
	 * Serialize rows into an XLSX workbook through the optional peer dependency `write-excel-file`.
	 *
	 * Rows may be arrays of cells, or records — record keys become the header row, read in the first record's key order.
	 * The source is materialized on the first invocation of a handle method: the workbook must be complete before any
	 * bytes can be produced.
	 *
	 * @param source The rows to write, as any iterable or async iterable.
	 * @param init Options for the writer.
	 */
	static write(
		source: Iterable<XLSXWritableRow> | AsyncIterable<XLSXWritableRow>,
		init: XLSXWriteInit = {}
	): XLSXWriteHandle {
		const open = async () => {
			const { default: writeXlsxFile } = await importVendor("write-excel-file", () => import("write-excel-file/node"))
			const data = await materializeSheetData(source, init)

			return writeXlsxFile(data, init.sheet === undefined ? undefined : { sheet: init.sheet })
		}

		return {
			async toFile(path: string): Promise<void> {
				await (await open()).toFile(path)
			},
			async toBuffer(): Promise<Buffer> {
				return (await open()).toBuffer() as Promise<Buffer>
			},
			async toStream(writable?: NodeJS.WritableStream): Promise<unknown> {
				return (await open()).toStream(writable as never)
			},
		}
	}
}

/**
 * Materialize writable rows into `write-excel-file`'s sheet data: bare cell values, with a header row derived from
 * record keys when the rows are records.
 */
async function materializeSheetData(
	source: Iterable<XLSXWritableRow> | AsyncIterable<XLSXWritableRow>,
	init: XLSXWriteInit
): Promise<XLSXCellValue[][]> {
	const data: XLSXCellValue[][] = []
	let keys: string[] | undefined

	for await (const row of source) {
		if (Array.isArray(row)) {
			if (init.header) {
				throw new TypeError("`header` requires record rows — array rows have no keys to derive a header from.")
			}

			data.push(row as XLSXCellValue[])

			continue
		}

		const record = row as Readonly<Record<string, XLSXCellValue>>

		if (!keys) {
			// The header is derived from the first record's keys; later records are read in that order.
			keys = Object.keys(record)

			if (init.header !== false) {
				data.push(keys)
			}
		}

		data.push(keys.map((key) => record[key] ?? null))
	}

	return data
}
