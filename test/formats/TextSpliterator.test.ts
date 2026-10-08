/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { TextSpliterator } from "spliterator"
import { describe, test } from "vitest"

import { fixturesDirectory, loadFixture } from "../support/utils.js"

test("count/countAsync support sync and async resources without consuming a later path parse", async ({ expect }) => {
	const fixturePath = fixturesDirectory("phonetic-single-spaced.txt")
	const counted = await TextSpliterator.countAsync(fixturePath, { skipEmpty: false })
	const parsed = await TextSpliterator.fromAsync(fixturePath, { skipEmpty: false }).toArray()
	const encoder = new TextEncoder()

	const chunks = (async function* () {
		yield encoder.encode("one\n")
		yield encoder.encode("two")
	})()

	expect(TextSpliterator.count("one\n\ntwo", { skipEmpty: false })).toBe(3)
	expect(counted).toBe(parsed.length)
	expect(await TextSpliterator.countAsync(chunks)).toBe(2)
})

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

	// Pieces split on `|` carry their newlines; byte parity needs `trim: false`.
	const generator = TextSpliterator.fromAsync(fixturePath, { skipEmpty: false, delimiter: "|", trim: false })
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
// truncated subset. The test consumes every line and asserts content parity with
// `String.prototype.split` so any future divergence (silent drop, duplicate, or throw) is
// caught.
test("Async EOF without trailing delimiter (regression: libpostal given_names.txt @ 78kB)", async ({ expect }) => {
	const fixturePath = fixturesDirectory("given-names-78k.txt")
	const fixture = await loadFixture(fixturePath)
	expect(fixture.decodedLines.length, "Fixture has many lines").toBeGreaterThan(10_000)
	expect(fixture.bytes.at(-1), "Fixture ends without a trailing newline").not.toBe(0x0a)

	const generator = TextSpliterator.fromAsync(fixturePath, { skipEmpty: false })
	const decodedLines = await Array.fromAsync(generator)

	expect(decodedLines, "Decoded lines match split").toMatchObject(fixture.decodedLines)
})

describe("trim", () => {
	const padded = "  alpha \r\n\t\nbeta\r\n   \r\ngamma  "

	test("trims each row and drops whitespace-only rows by default", ({ expect }) => {
		expect(TextSpliterator.from(padded).toArray()).toEqual(["alpha", "beta", "gamma"])
	})

	test("count agrees with from under the default", ({ expect }) => {
		expect(TextSpliterator.count(padded)).toBe(3)
		expect(TextSpliterator.count(padded, { trim: false })).toBe(5)
	})

	test("trim: false keeps every row as decoded", ({ expect }) => {
		expect(TextSpliterator.from(padded, { trim: false }).toArray()).toEqual([
			"  alpha \r",
			"\t",
			"beta\r",
			"   \r",
			"gamma  ",
		])
	})

	test("skipEmpty: false keeps a whitespace-only row as an empty string", ({ expect }) => {
		expect(TextSpliterator.from(padded, { skipEmpty: false }).toArray()).toEqual(["alpha", "", "beta", "", "gamma"])
	})

	test("parses a padded list", ({ expect }) => {
		expect(TextSpliterator.from(" us, fr ,, de ", { delimiter: "," }).toArray()).toEqual(["us", "fr", "de"])
	})

	test("async path matches", async ({ expect }) => {
		async function* source() {
			yield new TextEncoder().encode(padded)
		}

		expect(await TextSpliterator.fromAsync(source()).toArray()).toEqual(["alpha", "beta", "gamma"])
		expect(await TextSpliterator.countAsync(source())).toBe(3)
		expect(await TextSpliterator.fromAsync(source(), { trim: false }).toArray()).toHaveLength(5)
	})
})
