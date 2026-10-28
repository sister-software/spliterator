/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 *
 * The TypeScript runner for the language-neutral conformance suite in `conformance/`. The Rust crate and the Python
 * package run the same files; their runners live beside their tests. Every case runs through every entry point a
 * caller could reach it by: a string, bytes, and streams cut at several chunk sizes, both read whole and streamed.
 */

import { readFileSync } from "node:fs"

import {
	CharacterSequence,
	CSVSpliterator,
	DuplicateHeaderError,
	JSONRowError,
	JSONSpliterator,
	PSVSpliterator,
	TextSpliterator,
	TSVSpliterator,
	UnterminatedQuoteError,
} from "spliterator"
import { beforeAll, describe, expect, test } from "vitest"

type Format = "text" | "jsonl" | "csv" | "tsv" | "psv"

type ExpectedError =
	| { type: "UnterminatedQuote"; byteOffset: number }
	| { type: "DuplicateHeader"; column: string }
	| { type: "JSONRow"; row: number }

interface ConformanceCase {
	name: string
	format?: Format
	input: string | { base64: string }
	options?: Record<string, unknown>
	expect?: unknown[]
	expectBeforeError?: unknown[]
	error?: ExpectedError
}

interface ConformanceFile {
	format: Format
	cases: ConformanceCase[]
}

const FILES = ["text", "jsonl", "csv", "compression"] as const

const CHUNK_SIZES = [1, 3, 64, Infinity] as const

const encoder = new TextEncoder()

function load(name: string): ConformanceFile {
	return JSON.parse(readFileSync(new URL(`../../conformance/${name}.json`, import.meta.url), "utf8")) as ConformanceFile
}

function inputBytes(input: ConformanceCase["input"]): Uint8Array {
	return typeof input === "string" ? encoder.encode(input) : new Uint8Array(Buffer.from(input.base64, "base64"))
}

async function* chunked(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
	if (!Number.isFinite(size)) {
		yield bytes

		return
	}

	for (let offset = 0; offset < bytes.byteLength; offset += size) {
		yield bytes.slice(offset, offset + size)
	}
}

const READERS = {
	text: TextSpliterator,
	jsonl: JSONSpliterator,
	csv: CSVSpliterator,
	tsv: TSVSpliterator,
	psv: PSVSpliterator,
} as const

interface Variant {
	label: string
	run: () => Iterable<unknown> | AsyncIterable<unknown>
}

function variants(format: Format, input: ConformanceCase["input"], options: Record<string, unknown>): Variant[] {
	// The readers share a shape but not a signature; each variant calls through this loosely typed view.
	const reader = READERS[format] as unknown as {
		from(source: unknown, init: unknown): Iterable<unknown>
		fromAsync(source: unknown, init: unknown): AsyncIterable<unknown>
	}

	const bytes = inputBytes(input)

	const scans: Array<Record<string, unknown>> =
		format === "text" || format === "jsonl" ? [{}] : [{}, { columnScan: "rows" }]

	const result: Variant[] = []

	for (const scan of scans) {
		const suffix = scan.columnScan ? ` (columnScan: rows)` : ""

		if (typeof input === "string") {
			result.push({ label: `from(string)${suffix}`, run: () => reader.from(input, { ...options, ...scan }) })
		}

		result.push({ label: `from(bytes)${suffix}`, run: () => reader.from(bytes, { ...options, ...scan }) })

		for (const size of CHUNK_SIZES) {
			for (const bulkThreshold of [0, undefined]) {
				result.push({
					label: `fromAsync, chunks of ${size}, ${bulkThreshold === 0 ? "streamed" : "adaptive"}${suffix}`,
					run: () => reader.fromAsync(chunked(bytes, size), { ...options, ...scan, bulkThreshold }),
				})
			}
		}
	}

	return result
}

async function collect(run: Variant["run"]): Promise<{ rows: unknown[]; error: unknown }> {
	const rows: unknown[] = []

	try {
		for await (const row of run()) {
			rows.push(row)
		}
	} catch (error) {
		return { rows, error }
	}

	return { rows, error: undefined }
}

function expectError(error: unknown, expected: ExpectedError): void {
	switch (expected.type) {
		case "UnterminatedQuote":
			expect(error).toBeInstanceOf(UnterminatedQuoteError)
			expect((error as UnterminatedQuoteError).byteOffset).toBe(expected.byteOffset)
			break
		case "DuplicateHeader":
			expect(error).toBeInstanceOf(DuplicateHeaderError)
			expect((error as DuplicateHeaderError).column).toBe(expected.column)
			break
		case "JSONRow":
			expect(error).toBeInstanceOf(JSONRowError)
			expect((error as JSONRowError).row).toBe(expected.row)
			break
	}
}

beforeAll(async () => {
	await CharacterSequence.whenReady()
})

for (const name of FILES) {
	const file = load(name)

	describe(`conformance/${name}.json`, () => {
		for (const testCase of file.cases) {
			const format = testCase.format ?? file.format

			describe(`${testCase.name}`, () => {
				test.for(variants(format, testCase.input, testCase.options ?? {}))(
					"$label",
					async (variant) => {
						const { rows, error } = await collect(variant.run)

						if (testCase.error) {
							expectError(error, testCase.error)

							if (testCase.expectBeforeError) {
								expect(rows).toEqual(testCase.expectBeforeError)
							}

							return
						}

						if (error) throw error

						expect(rows).toEqual(testCase.expect)
					}
				)
			})
		}
	})
}
