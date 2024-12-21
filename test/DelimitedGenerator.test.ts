/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { DelimitedGenerator } from "@sister.software/ribbon"
import * as fs from "@sister.software/ribbon/node/fs"
import { test } from "vitest"
import { fixturesDirectory, loadFixture } from "./utils.js"

test("Synchronous parity with String.prototype.split", async ({ expect }) => {
	const decoder = new TextDecoder()

	const fixturePath = fixturesDirectory("phonetic.txt")
	const fixture = await loadFixture(fixturePath)

	const generator = DelimitedGenerator.from(fixture.bytes, { skipEmpty: false })
	const encodedLines = Array.from(generator)
	const decodedLines = Array.from(encodedLines, (line) => decoder.decode(line))

	expect(encodedLines.length, `Async delimiter matches line length`).equal(fixture.encodedLines.length)

	expect(decodedLines, `Decoded lines match`).toMatchObject(fixture.decodedLines)
	expect(encodedLines, `Encoded lines match`).toMatchObject(fixture.encodedLines)
})

test("Synchronous parity with present lines", async ({ expect }) => {
	const decoder = new TextDecoder()

	const fixturePath = fixturesDirectory("phonetic.txt")
	const fixture = await loadFixture(fixturePath)
	const presentFixtureLines = fixture.decodedLines.filter(Boolean)

	const generator = DelimitedGenerator.from(fixture.bytes)
	const encodedLines = Array.from(generator)
	const decodedLines = Array.from(encodedLines, (line) => decoder.decode(line))

	expect(encodedLines.length, `Delimiter matches line length`).equal(presentFixtureLines.length)

	expect(decodedLines, `Decoded lines match`).toMatchObject(presentFixtureLines)
})

test("Asynchronous content parity with String.prototype.split", async ({ expect, onTestFinished }) => {
	const decoder = new TextDecoder()

	const fixturePath = fixturesDirectory("phonetic.txt")
	const fixture = await loadFixture(fixturePath)

	const fileHandle = await fs.open(fixturePath, "r")
	onTestFinished(() => fileHandle.close())

	const lineGenerator = DelimitedGenerator.fromAsync(fileHandle, { skipEmpty: false })
	const encodedLines = await Array.fromAsync(lineGenerator)
	const decodedLines = Array.from(encodedLines, (line) => decoder.decode(line))

	expect(decodedLines.length, "Decoded line count matches").equal(fixture.decodedLines.length)
	expect(decodedLines, "Decoded lines match").toMatchObject(fixture.decodedLines)
	expect(encodedLines, "Encoded lines match").toMatchObject(fixture.encodedLines)

	const encodedReadStream = ReadableStream.from(encodedLines)

	const encodedStreamLines = await Array.fromAsync(encodedReadStream)
	expect(encodedStreamLines, "Encoded stream lines match").toMatchObject(fixture.encodedLines)

	const decodedReaderSource = DelimitedGenerator.fromAsync(fileHandle)

	const decodedReadStream = ReadableStream
		// ---
		.from(decodedReaderSource)
		.pipeThrough(new TextDecoderStream("utf-8"))

	const decodedStreamLines = await Array.fromAsync(decodedReadStream)

	expect(decodedStreamLines, "Decoded stream lines match").toMatchObject(
		fixture.decodedLines.map((line) => line.trim()).filter(Boolean)
	)
})

test("Asynchronous parity with present lines", async ({ expect, onTestFinished }) => {
	const decoder = new TextDecoder()

	const fixturePath = fixturesDirectory("phonetic.txt")
	const fixture = await loadFixture(fixturePath)
	const presentFixtureLines = fixture.decodedLines.map((line) => line.trim()).filter(Boolean)

	const fileHandle = await fs.open(fixturePath, "r")
	onTestFinished(() => fileHandle.close())
	const generator = DelimitedGenerator.fromAsync(fileHandle)

	const encodedLines = await Array.fromAsync(generator)
	const decodedLines = Array.from(encodedLines, (line) => decoder.decode(line))

	expect(encodedLines.length, `Async delimiter matches line length`).equal(presentFixtureLines.length)

	expect(decodedLines, `Decoded lines match`).toMatchObject(presentFixtureLines)
})
