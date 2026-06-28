/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { TextSpliterator } from "spliterator"
import { test } from "vitest"

import { fixturesDirectory, loadFixture } from "./utils.js"

test("Synchronous parity with String.prototype.split", async ({ expect }) => {
	const fixturePath = fixturesDirectory("phonetic-single-spaced.txt")
	const fixture = await loadFixture(fixturePath)
	expect(fixture.decodedLines, "Fixture has lines").not.toHaveLength(0)

	const generator = TextSpliterator.from(fixture.bytes, { skipEmpty: false })
	const decodedLines = generator.toArray()

	expect(decodedLines, "Decoded lines match").toMatchObject(fixture.decodedLines)
})

test("Async parity with String.prototype.split", async ({ expect }) => {
	const fixturePath = fixturesDirectory("phonetic-single-spaced.txt")
	const fixture = await loadFixture(fixturePath)
	expect(fixture.decodedLines, "Fixture has lines").not.toHaveLength(0)

	const generator = TextSpliterator.fromAsync(fixturePath, { skipEmpty: false })
	const decodedLines = await Array.fromAsync(generator)

	expect(decodedLines, "Decoded lines match").toMatchObject(fixture.decodedLines)
})

test("Async pipe separator", async ({ expect }) => {
	const fixturePath = fixturesDirectory("phonetic-pipe-separator.txt")
	const fixture = await loadFixture(fixturePath, { delimiter: "|" })
	expect(fixture.decodedLines, "Fixture has lines").not.toHaveLength(0)

	const generator = TextSpliterator.fromAsync(fixturePath, { skipEmpty: false, delimiter: "|" })
	const decodedLines = await Array.fromAsync(generator)

	expect(decodedLines, "Decoded lines match").toMatchObject(fixture.decodedLines)
})

test("Async no separator", async ({ expect }) => {
	const fixturePath = fixturesDirectory("phonetic-single.txt")
	const fixture = await loadFixture(fixturePath, { delimiter: "\n" })
	expect(fixture.decodedLines, "Fixture has lines").not.toHaveLength(0)

	const generator = TextSpliterator.fromAsync(fixturePath, { skipEmpty: false, delimiter: "|" })
	const decodedLines = await Array.fromAsync(generator)
	expect(decodedLines, "Decoded has lines").not.toHaveLength(0)

	expect(decodedLines, "Decoded lines match").toMatchObject(fixture.decodedLines)
})

// Regression for the EOF/compress RangeError bisected against libpostal's `given_names.txt`.
// The original report saw `AsyncSpliterator.next()` throw
//   `End index N is greater than the current byte length M`
// at specific truncation sizes (76 000, 77 000, 78 000, 96 421 bytes). The fixture is a
// truncated subset; the test consumes every line and asserts content parity with
// `String.prototype.split` so any future divergence (silent drop, duplicate, or throw) is
// caught.
test("Async EOF without trailing delimiter (regression: libpostal given_names.txt @ 78kB)", async ({ expect }) => {
	const fixturePath = fixturesDirectory("given-names-78k.txt")
	const fixture = await loadFixture(fixturePath)
	expect(fixture.decodedLines.length, "Fixture has many lines").toBeGreaterThan(10_000)
	expect(fixture.bytes[fixture.bytes.length - 1], "Fixture ends without a trailing newline").not.toBe(0x0a)

	const generator = TextSpliterator.fromAsync(fixturePath, { skipEmpty: false })
	const decodedLines = await Array.fromAsync(generator)

	expect(decodedLines, "Decoded lines match split").toMatchObject(fixture.decodedLines)
})
