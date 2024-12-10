/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { LineReader, zipAsync } from "@sister.software/ribbon"
import * as fs from "node:fs/promises"
import * as v from "vitest"
import { test } from "vitest"
import { fixturesDirectory, loadFixture } from "./utils.js"

test("Fixture sanity check", async ({ expect }) => {
	const fixturePath = fixturesDirectory("phonetic.txt")
	const fixtureContents = await loadFixture(fixturePath)

	expect(fixtureContents.length, "Fixture contents should be greater than zero").toBeGreaterThan(0)

	const lines = fixtureContents.split("\n")

	expect(lines.length, "Fixture should have more than one line").toBeGreaterThan(0)
})

test("Line-count parity with in-memory read", async ({ expect, onTestFinished }) => {
	const fixturePath = fixturesDirectory("phonetic.txt")
	const fixtureContents = await loadFixture(fixturePath)

	const lines = fixtureContents.split("\n")

	const fileHandle = await fs.open(fixturePath, "r")

	onTestFinished(() => fileHandle.close())
	const reader = new LineReader(fileHandle, { skipEmptyLines: false })

	let readerLineCount = 0

	for await (const line of reader) {
		// console.log(readerLineCount, line.toString())

		readerLineCount++
	}

	expect(readerLineCount, "Reader should have the same number of lines as split").toEqual(lines.length)
})

test("Content parity with in-memory read: All lines", async ({ expect, onTestFinished }) => {
	const fixturePath = fixturesDirectory("phonetic.txt")
	const fixtureContents = await loadFixture(fixturePath)

	const lines = fixtureContents.split("\n")

	const fileHandle = await fs.open(fixturePath, "r")
	onTestFinished(() => fileHandle.close())

	const reader = new LineReader(fileHandle, { skipEmptyLines: false })

	const iterator = zipAsync(reader, lines)

	let readerLineCount = 0

	readerLineCount++

	for await (const [readerLine, memoryLine] of iterator) {
		if (typeof readerLine === "undefined") {
			v.should().fail("Reader line should not be undefined")

			return
		}

		if (typeof memoryLine === "undefined") {
			v.should().fail("In-memory line should not be undefined")

			return
		}

		expect(memoryLine, `Line of index ${readerLineCount} should match in-memory line`).toEqual(readerLine.toString())

		readerLineCount++
	}
})

test("Content parity with in-memory read: Present lines", async ({ expect, onTestFinished }) => {
	const fixturePath = fixturesDirectory("phonetic.txt")
	const fixtureContents = await loadFixture(fixturePath)

	const lines = fixtureContents
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)

	const fileHandle = await fs.open(fixturePath, "r")
	onTestFinished(() => fileHandle.close())

	const reader = new LineReader(fileHandle)

	const iterator = zipAsync(reader, lines)

	let readerLineCount = 0

	readerLineCount++

	for await (const [readerLine, memoryLine] of iterator) {
		if (typeof readerLine === "undefined") {
			v.should().fail("Reader line should not be undefined")

			return
		}

		if (typeof memoryLine === "undefined") {
			v.should().fail("In-memory line should not be undefined")

			return
		}

		// console.log({ readerLine: readerLine.toString(), memoryLine })

		expect(memoryLine, `Line of index ${readerLineCount} should match in-memory line`).toEqual(readerLine.toString())

		readerLineCount++
	}
})
