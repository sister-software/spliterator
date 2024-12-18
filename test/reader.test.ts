/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { DelimitedIterator, LineReader, TextDecoderTransformer, zipAsync } from "@sister.software/ribbon"
import * as fs from "node:fs/promises"
import * as v from "vitest"
import { test } from "vitest"
import { fixturesDirectory, loadFixture } from "./utils.js"

test("Fixture sanity check", async ({ expect }) => {
	const fixturePath = fixturesDirectory("phonetic.txt")
	const fixtureContents = await loadFixture(fixturePath, "utf8")

	expect(fixtureContents.length, "Fixture contents should be greater than zero").toBeGreaterThan(0)

	const lines = fixtureContents.split("\n")

	expect(lines.length, "Fixture should have more than one line").toBeGreaterThan(0)
})

test("Can iterate in memory", async ({ expect }) => {
	const fixturePath = fixturesDirectory("phonetic.txt")
	const fixtureContents = await loadFixture(fixturePath)
	const fixtureLines = fixtureContents.toString().split("\n")

	const decoder = new TextDecoder()

	let readerLineCount = 0

	for (const [start, end] of DelimitedIterator.slidingWindow(fixtureContents)) {
		const line = fixtureContents.subarray(start, end)
		const decodedLine = decoder.decode(line)
		console.log(`Line ${readerLineCount + 1}: [${decodedLine}] (${line.length})`)

		readerLineCount++
	}

	expect(readerLineCount, "Take delimited should match FS").equals(fixtureLines.length)
})

test("Line-count parity with in-memory read", async ({ expect, onTestFinished }) => {
	const fixturePath = fixturesDirectory("phonetic.txt")
	const fixtureContents = await loadFixture(fixturePath, "utf8")

	const fixtureLines = fixtureContents.split("\n")

	const fileHandle = await fs.open(fixturePath, "r")

	onTestFinished(() => fileHandle.close())
	const reader = new LineReader(fileHandle, { skipEmpty: false }).pipeThrough(new TextDecoderTransformer())

	let readerLineCount = 0

	for await (const line of reader) {
		console.log(`Line ${readerLineCount + 1}: [${line}] (${line.length})`)

		readerLineCount++
	}

	expect(readerLineCount, "Reader should have the same number of lines as split").toEqual(fixtureLines.length)
})

test("Content parity with in-memory read: All lines", async ({ expect, onTestFinished }) => {
	const fixturePath = fixturesDirectory("phonetic.txt")
	const fixtureContents = await loadFixture(fixturePath, "utf8")

	const lines = fixtureContents.split("\n")

	const fileHandle = await fs.open(fixturePath, "r")
	onTestFinished(() => fileHandle.close())

	const reader = new LineReader(fileHandle, { skipEmpty: false }).pipeThrough(new TextDecoderTransformer())

	const iterator = zipAsync(reader, lines)

	let readerLineCount = 0

	for await (const [readerLine, memoryLine] of iterator) {
		if (typeof readerLine === "undefined") {
			v.should().fail("Reader line should not be undefined")

			return
		}

		if (typeof memoryLine === "undefined") {
			v.should().fail("In-memory line should not be undefined")

			return
		}

		console.log(
			`Line ${readerLineCount}: [${readerLine}] (${readerLine.length}) -> [${memoryLine}] (${memoryLine.length})`
		)

		expect(readerLine, `Line of index ${readerLineCount} should match in-memory line`).toEqual(memoryLine)
		readerLineCount++
	}
})

test("Content parity with in-memory read: Present lines", async ({ expect, onTestFinished }) => {
	const fixturePath = fixturesDirectory("phonetic.txt")
	const fixtureContents = await loadFixture(fixturePath, "utf8")

	const lines = fixtureContents
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)

	const fileHandle = await fs.open(fixturePath, "r")
	onTestFinished(() => fileHandle.close())

	const reader = new LineReader(fileHandle).pipeThrough(new TextDecoderStream())

	const iterator = zipAsync(reader, lines)

	let readerLineCount = 0

	for await (const [readerLine, memoryLine] of iterator) {
		console.log(
			`Line ${readerLineCount + 1}: [${readerLine}] (${readerLine?.length}) -> [${memoryLine}] (${memoryLine?.length})`
		)

		if (typeof readerLine === "undefined") {
			v.should().fail(`Reader line #${readerLineCount} should not be undefined`)

			return
		}

		if (typeof memoryLine === "undefined") {
			v.should().fail(`In-memory line #${readerLineCount} should not be undefined`)

			return
		}

		expect(readerLine, `Line of index ${readerLineCount + 1} should match in-memory line`).toEqual(memoryLine)

		readerLineCount++
	}
})
