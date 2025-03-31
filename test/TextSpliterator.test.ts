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
