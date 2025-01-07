/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { AsyncSpliterator, Spliterator } from "spliterator"
import { NodeFileResource } from "spliterator/node/fs"
import { test } from "vitest"
import { fixturesDirectory, loadFixture } from "./utils.js"

test("Synchronous parity with String.prototype.split", async ({ expect }) => {
	const decoder = new TextDecoder()

	const fixturePath = fixturesDirectory("phonetic-single-spaced.txt")
	const fixture = await loadFixture(fixturePath)
	expect(fixture.decodedLines, "Fixture has lines").not.toHaveLength(0)

	const generator = Spliterator.from(fixture.bytes, { skipEmpty: false })
	const encodedLines = Array.from(generator)
	const decodedLines = Array.from(encodedLines, (line) => decoder.decode(line))

	expect(encodedLines.length, `Async delimiter matches line length`).equal(fixture.encodedLines.length)

	expect(decodedLines, `Decoded lines match`).toMatchObject(fixture.decodedLines)
	expect(encodedLines, `Encoded lines match`).toMatchObject(fixture.encodedLines)
})

test("Synchronous parity with present lines", async ({ expect }) => {
	const decoder = new TextDecoder()

	const fixturePath = fixturesDirectory("phonetic-single-spaced.txt")
	const fixture = await loadFixture(fixturePath)
	const presentFixtureLines = fixture.decodedLines.filter(Boolean)

	const generator = Spliterator.from(fixture.bytes)
	const encodedLines = Array.from(generator)
	const decodedLines = Array.from(encodedLines, (line) => decoder.decode(line))

	expect(encodedLines.length, `Delimiter matches line length`).equal(presentFixtureLines.length)

	expect(decodedLines, `Decoded lines match`).toMatchObject(presentFixtureLines)
})

test("Asynchronous content parity with String.prototype.split", async ({ expect, onTestFinished }) => {
	const decoder = new TextDecoder()

	const fixturePath = fixturesDirectory("phonetic-single-spaced.txt")
	const fixture = await loadFixture(fixturePath)

	const file = await NodeFileResource.open(fixturePath)
	onTestFinished(() => file.dispose())

	const lineGenerator = new AsyncSpliterator(file, { skipEmpty: false })
	const encodedLines = await Array.fromAsync(lineGenerator)

	const decodedLines = Array.from(encodedLines, (line) => decoder.decode(line))

	expect(decodedLines.length, "Decoded line count matches").equal(fixture.decodedLines.length)
	expect(decodedLines, "Decoded lines match").toMatchObject(fixture.decodedLines)
	expect(encodedLines, "Encoded lines match").toMatchObject(fixture.encodedLines)

	const encodedReadStream = ReadableStream.from(encodedLines)

	const encodedStreamLines = await Array.fromAsync(encodedReadStream)
	expect(encodedStreamLines, "Encoded stream lines match").toMatchObject(fixture.encodedLines)

	const decodedReaderSource = new AsyncSpliterator(file)

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

	const fixturePath = fixturesDirectory("phonetic-single-spaced.txt")
	const fixture = await loadFixture(fixturePath)
	const presentFixtureLines = fixture.decodedLines.map((line) => line.trim()).filter(Boolean)

	const fileHandle = await NodeFileResource.open(fixturePath)
	onTestFinished(() => fileHandle.dispose())
	const generator = await Spliterator.fromAsync(fileHandle)

	const encodedLines = await Array.fromAsync(generator)
	const decodedLines = Array.from(encodedLines, (line) => decoder.decode(line))

	expect(encodedLines.length, `Async delimiter matches line length`).equal(presentFixtureLines.length)

	expect(decodedLines, `Decoded lines match`).toMatchObject(presentFixtureLines)
})

test("Newline: Double spaced", async ({ expect, onTestFinished }) => {
	const decoder = new TextDecoder()

	const fixturePath = fixturesDirectory("phonetic-double-spaced.txt")
	const fixture = await loadFixture(fixturePath, {
		delimiter: "\n",
	})

	const file = await NodeFileResource.open(fixturePath)
	onTestFinished(() => file.dispose())

	const lineGenerator = new AsyncSpliterator(file, {
		delimiter: "\n",
		skipEmpty: false,
	})

	const encodedLines = await Array.fromAsync(lineGenerator)
	const decodedLines = Array.from(encodedLines, (line) => decoder.decode(line))

	expect(decodedLines.length, "Decoded line count matches").equal(fixture.decodedLines.length)

	expect(decodedLines, "Decoded lines match").toMatchObject(fixture.decodedLines)
})

test("Carriage-Return: Single spaced", async ({ expect, onTestFinished }) => {
	const decoder = new TextDecoder()

	const fixturePath = fixturesDirectory("phonetic-single-spaced.crlf.txt")
	const fixture = await loadFixture(fixturePath, {
		delimiter: "\r\n",
	})

	const file = await NodeFileResource.open(fixturePath)
	onTestFinished(() => file.dispose())

	const lineGenerator = new AsyncSpliterator(file, {
		delimiter: "\r\n",
		skipEmpty: false,
	})

	const encodedLines = await Array.fromAsync(lineGenerator)
	const decodedLines = Array.from(encodedLines, (line) => decoder.decode(line))

	expect(decodedLines.length, "Decoded line count matches").equal(fixture.decodedLines.length)

	expect(decodedLines, "Decoded lines match").toMatchObject(fixture.decodedLines)
})

test("Carriage-Return: Double spaced", async ({ expect, onTestFinished }) => {
	const decoder = new TextDecoder()

	const fixturePath = fixturesDirectory("phonetic-double-spaced.crlf.txt")
	const fixture = await loadFixture(fixturePath, {
		delimiter: "\r\n",
	})

	const file = await NodeFileResource.open(fixturePath)
	onTestFinished(() => file.dispose())

	const lineGenerator = new AsyncSpliterator(file, {
		delimiter: "\r\n",
		skipEmpty: false,
	})

	const encodedLines = await Array.fromAsync(lineGenerator)
	const decodedLines = Array.from(encodedLines, (line) => decoder.decode(line))

	expect(decodedLines.length, "Decoded line count matches").equal(fixture.decodedLines.length)

	expect(decodedLines, "Decoded lines match").toMatchObject(fixture.decodedLines)
})
