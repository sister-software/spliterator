/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { CSVSpliterator, normalizeColumnNames, zipSync } from "spliterator"
import { NodeFileResource } from "spliterator/node/fs"
import { test } from "vitest"
import { fixturesDirectory, loadFixture } from "./utils.js"

const fixturePath = fixturesDirectory("carvel.csv")
const fixture = await loadFixture(fixturePath)

const rawHeader = fixture.decodedLines[0]!.split(",")
const firstRow = fixture.decodedLines[1]!.split(",")

const normalizedHeader = normalizeColumnNames(rawHeader)

test("Header is parsed", async ({ expect, onTestFinished }) => {
	const header = CSVSpliterator.from(fixture.bytes, { skip: 0 }).next()

	expect(header.done, "First row should not be done").toBeFalsy()
	expect(header.value, "Header should be an array of columns").members(rawHeader)

	const fileHandle = await NodeFileResource.open(fixturePath)
	onTestFinished(() => fileHandle.dispose())

	const headerAsync = await CSVSpliterator.fromAsync(fileHandle, { skip: 0 }).next()

	expect(headerAsync.done, "Async: first row should not be done").toBeFalsy()
	expect(headerAsync.value, "Async: Header should be an array of columns").members(rawHeader)
})

test("Header normalization", async ({ expect, onTestFinished }) => {
	const rowGenerator = CSVSpliterator.from(fixture.bytes, { skip: 0, normalizeKeys: true })
	const header = rowGenerator.next()

	expect(header.value, "Header should be normalized").members(normalizedHeader)

	const fileHandle = await NodeFileResource.open(fixturePath)
	onTestFinished(() => fileHandle.dispose())

	const headerAsync = await CSVSpliterator.fromAsync(fileHandle, { skip: 0, normalizeKeys: true }).next()

	expect(headerAsync.value, "Async: Header should be normalized").members(normalizedHeader)
})

test("Rows emit as entries", async ({ expect, onTestFinished }) => {
	const rowGenerator = CSVSpliterator.from(fixture.bytes, { mode: "entries", normalizeKeys: true })
	const emittedRow = rowGenerator.next()

	const expectedRow = Array.from(zipSync(normalizedHeader, firstRow))
	expect(Object.values(emittedRow.value), "Header should be an array of columns").toMatchObject(expectedRow)

	const fileHandle = await NodeFileResource.open(fixturePath)
	onTestFinished(() => fileHandle.dispose())

	const rowGeneratorAsync = CSVSpliterator.fromAsync(fileHandle, { mode: "entries", normalizeKeys: true })
	const emittedRowAsync = await rowGeneratorAsync.next()

	expect(Object.values(emittedRowAsync.value), "Async: Header should be an array of columns").toMatchObject(expectedRow)
})

test("Rows emit as record", async ({ expect, onTestFinished }) => {
	const rowGenerator = CSVSpliterator.from(fixture.bytes, { mode: "object", normalizeKeys: true })
	const emittedRow = rowGenerator.next()

	const expectedRow = Object.fromEntries(Array.from(zipSync(normalizedHeader, firstRow)))
	expect(emittedRow.value, "Header should be record").toMatchObject(expectedRow)

	const fileHandle = await NodeFileResource.open(fixturePath)
	onTestFinished(() => fileHandle.dispose())

	const rowGeneratorAsync = CSVSpliterator.fromAsync(fileHandle, { mode: "object", normalizeKeys: true })
	const emittedRowAsync = await rowGeneratorAsync.next()

	expect(emittedRowAsync.value, "Async: Header should be record").toMatchObject(expectedRow)
})
