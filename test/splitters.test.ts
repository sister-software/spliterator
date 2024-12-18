/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	DelimitedTextDecoderTransformer,
	DelimiterTransformer,
	LineReader,
	normalizeColumnNames,
} from "@sister.software/ribbon"
import * as fs from "node:fs/promises"
import { test } from "vitest"
import { fixturesDirectory } from "./utils.js"

test("CSV parsing", async ({ expect, onTestFinished }) => {
	const fixturePath = fixturesDirectory("carvel.csv")

	const fileHandle = await fs.open(fixturePath, "r")

	onTestFinished(() => fileHandle.close())
	const reader = new LineReader(fileHandle)
		// ---
		.pipeThrough(new DelimiterTransformer())
		.pipeThrough(new DelimitedTextDecoderTransformer())

	const iterator = reader[Symbol.asyncIterator]()

	const headerResult = await iterator.next()

	expect(headerResult.done, "Header should not be done").toBeFalsy()

	const header = headerResult.value!.slice()
	const normalizedHeader = normalizeColumnNames(header)

	const expectedHeader = ["Item Name", "Character Name", "Category", "Size", "PRICE"]
	expect(header, "Header should be an array of columns").members(expectedHeader)

	expect(normalizedHeader, "Normalized header should be the same length as the original header").toHaveLength(
		expectedHeader.length
	)

	expect(normalizedHeader, "Normalized header should be an array of keyable strings").members([
		"item_name",
		"character_name",
		"category",
		"size",
		"PRICE",
	])

	let readerLineCount = 0

	for await (const columns of iterator) {
		console.log(readerLineCount, columns)

		expect(columns.length, "Columns should have the same length as the header").toEqual(expectedHeader.length)

		readerLineCount++
	}
})
