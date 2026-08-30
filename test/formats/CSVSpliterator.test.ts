/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import {
	type AsyncSequence,
	CSVSpliterator,
	Delimiters,
	normalizeColumnNames,
	PSVSpliterator,
	TSVSpliterator,
	zipSync,
} from "spliterator"
import { createChunkIterator } from "spliterator/node/fs"
import { expectTypeOf, test } from "vitest"

import { fixturesDirectory, loadFixture } from "../support/utils.js"

const fixturePath = fixturesDirectory("carvel.csv")
const fixture = await loadFixture(fixturePath)

const rawHeader = fixture.decodedLines[0]!.split(",")
const firstRow = fixture.decodedLines[1]!.split(",")

const normalizedHeader = normalizeColumnNames(rawHeader)

interface TypedCSVRow {
	Country: string
	Location: string
}

test("Object mode accepts an interface as its row type", async ({ expect }) => {
	const source = (async function* () {
		yield new TextEncoder().encode("Country,Location\nFR,PAR\n")
	})()

	const records = CSVSpliterator.fromAsync<TypedCSVRow>(source, {
		mode: "object",
		normalizeKeys: false,
	})

	expectTypeOf(records).toEqualTypeOf<AsyncSequence<TypedCSVRow>>()
	expect(await records.toArray()).toEqual([{ Country: "FR", Location: "PAR" }])

	const syncRecords = CSVSpliterator.from<TypedCSVRow>("Country,Location\nFR,PAR\n", {
		mode: "object",
		normalizeKeys: false,
	})

	expectTypeOf(syncRecords).toEqualTypeOf<Generator<TypedCSVRow>>()

	expectTypeOf(
		TSVSpliterator.from<TypedCSVRow>("Country\tLocation\nFR\tPAR\n", { mode: "object", normalizeKeys: false })
	).toEqualTypeOf<Generator<TypedCSVRow>>()

	expectTypeOf(
		PSVSpliterator.from<TypedCSVRow>("Country|Location\nFR|PAR\n", { mode: "object", normalizeKeys: false })
	).toEqualTypeOf<Generator<TypedCSVRow>>()

	expectTypeOf(
		TSVSpliterator.fromAsync<TypedCSVRow>(
			(async function* () {
				yield new TextEncoder().encode("Country\tLocation\nFR\tPAR\n")
			})(),
			{ mode: "object", normalizeKeys: false }
		)
	).toEqualTypeOf<AsyncSequence<TypedCSVRow>>()

	expectTypeOf(
		PSVSpliterator.fromAsync<TypedCSVRow>(
			(async function* () {
				yield new TextEncoder().encode("Country|Location\nFR|PAR\n")
			})(),
			{ mode: "object", normalizeKeys: false }
		)
	).toEqualTypeOf<AsyncSequence<TypedCSVRow>>()
})

test("Header is parsed", async ({ expect }) => {
	const result = CSVSpliterator.from(fixture.bytes, { mode: "object", normalizeKeys: false }).next()

	expect(result.done, "First row should not be done").toBeFalsy()

	const header = Object.keys(result.value!)

	expect(header, "Header should be an array of columns").members(rawHeader)
})

test("Async: Header is parsed", async ({ expect, onTestFinished }) => {
	const chunkIterator = await createChunkIterator(fixturePath)
	onTestFinished(() => chunkIterator[Symbol.asyncDispose]?.())

	const result = await CSVSpliterator.fromAsync(chunkIterator, { mode: "object", normalizeKeys: false }).next()

	expect(result.done, "Async: first row should not be done").toBeFalsy()

	const header = Object.keys(result.value!)

	expect(header, "Async: Header should be an array of columns").members(rawHeader)
})

test("Header normalization", async ({ expect }) => {
	const result = CSVSpliterator.from(fixture.bytes, { normalizeKeys: true, mode: "object" }).next()
	const header = Object.keys(result.value!)

	expect(header, "Header should be normalized").members(normalizedHeader)
})

test("Async: Header normalization", async ({ expect, onTestFinished }) => {
	const chunkIterator = await createChunkIterator(fixturePath)
	onTestFinished(() => chunkIterator[Symbol.asyncDispose]?.())

	const result = await CSVSpliterator.fromAsync(chunkIterator, { normalizeKeys: true, mode: "object" }).next()

	const header = Object.keys(result.value!)

	expect(header, "Header should be normalized").members(normalizedHeader)
})

test("Rows emit as entries", async ({ expect }) => {
	const result = CSVSpliterator.from(fixture.bytes, { mode: "entries", normalizeKeys: true }).next()

	const expectedRow = Array.from(zipSync(normalizedHeader, firstRow))
	expect(Object.values(result.value), "Header should be an array of columns").toMatchObject(expectedRow)
})

test("Async: Rows emit as record", async ({ expect, onTestFinished }) => {
	const expectedRow = Object.fromEntries(Array.from(zipSync(normalizedHeader, firstRow)))

	const chunkIterator = await createChunkIterator(fixturePath)
	onTestFinished(() => chunkIterator[Symbol.asyncDispose]?.())

	const rowGeneratorAsync = CSVSpliterator.fromAsync(chunkIterator, { mode: "object", normalizeKeys: true })
	const emittedRowAsync = await rowGeneratorAsync.next()

	expect(emittedRowAsync.value, "Async: Header should be record").toMatchObject(expectedRow)
})

// Regression for issue #2: the per-row column tokenizer used to inherit the default
// `skipEmpty: true` and silently collapse consecutive delimiters, dropping every empty cell
// and shifting later columns left. Empty cells in delimited records are semantically meaningful
// (a 5-column row must stay 5 columns), so the column splitter must preserve them.
const emptyFieldsTsv = "a\tb\tc\td\te\n1\t\t\t\t5\n"

test("Empty fields are preserved between consecutive column delimiters", ({ expect }) => {
	const rows = Array.from(
		CSVSpliterator.from(emptyFieldsTsv, { mode: "array", columnDelimiter: Delimiters.Tab, header: false })
	)

	expect(rows).toEqual([
		["a", "b", "c", "d", "e"],
		["1", "", "", "", "5"],
	])
})

test("Async: Empty fields are preserved between consecutive column delimiters", async ({ expect }) => {
	const bytes = new TextEncoder().encode(emptyFieldsTsv)

	const chunkIterator = (async function* () {
		yield bytes
	})()

	const rows: string[][] = []

	for await (const row of CSVSpliterator.fromAsync(chunkIterator, {
		mode: "array",
		columnDelimiter: Delimiters.Tab,
		header: false,
	})) {
		rows.push(row as string[])
	}

	expect(rows).toEqual([
		["a", "b", "c", "d", "e"],
		["1", "", "", "", "5"],
	])
})
