/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { CSVSpliterator, normalizeColumnNames, zipSync } from "spliterator"
import { createChunkIterator } from "spliterator/node/fs"
import { test } from "vitest"
import { fixturesDirectory, loadFixture } from "./utils.js"

const fixturePath = fixturesDirectory("carvel.csv")
const fixture = await loadFixture(fixturePath)

const rawHeader = fixture.decodedLines[0]!.split(",")
const firstRow = fixture.decodedLines[1]!.split(",")

const normalizedHeader = normalizeColumnNames(rawHeader)

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
