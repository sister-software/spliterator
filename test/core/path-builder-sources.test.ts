/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 *
 * `AsyncDataResource` includes `PathBuilderLike`, but a `PathBuilder` is callable — `typeof` is
 * `"function"` — so every `typeof === "object"` guard in the dispatch chain missed it and the input
 * fell through to be read as bytes. `yarn demo` had been failing on this with "Invalid delimiter
 * type". These cover each entry point that accepts a resource, not just the one the demo hit.
 */

import { AsyncSpliterator, CSVSpliterator, JSONSpliterator, Spliterator, TextSpliterator } from "spliterator"
import { readBytes, readFileSize } from "spliterator/node/fs"
import { describe, expect, test } from "vitest"

import { fixturesDirectory, loadFixture } from "../support/utils.js"

// `fixturesDirectory` is a PathBuilder, so calling it yields one too.
const fixture = fixturesDirectory("phonetic-single-spaced.txt")
const csvFixture = fixturesDirectory("carvel.csv")
const jsonlFixture = fixturesDirectory("carvel.jsonl")

describe("PathBuilder sources", () => {
	test("Spliterator.from accepts a PathBuilder", async () => {
		const expected = await loadFixture(fixture)

		const spliterator = await Spliterator.from(fixture, { delimiter: "\n" })
		const decoder = new TextDecoder()
		const lines: string[] = []

		for await (const range of spliterator) {
			lines.push(decoder.decode(range))
		}

		expect(lines, "Rows match the fixture").toEqual(expected.decodedLines.filter(Boolean))
	})

	test("AsyncSpliterator.from accepts a PathBuilder", async () => {
		const expected = await loadFixture(fixture)

		const spliterator = await AsyncSpliterator.from(fixture, { delimiter: "\n" })
		const decoder = new TextDecoder()
		const lines: string[] = []

		for await (const range of spliterator) {
			lines.push(decoder.decode(range))
		}

		expect(lines).toEqual(expected.decodedLines.filter(Boolean))
	})

	test("TextSpliterator.fromAsync accepts a PathBuilder", async () => {
		const expected = await loadFixture(fixture)
		const lines = await TextSpliterator.fromAsync(fixture, { delimiter: "\n" }).toArray()

		expect(lines).toEqual(expected.decodedLines.filter(Boolean))
	})

	test("JSONSpliterator.fromAsync accepts a PathBuilder", async () => {
		const rows = await JSONSpliterator.fromAsync(jsonlFixture).toArray()

		expect(rows.length, "Parsed some rows").toBeGreaterThan(0)
	})

	test("CSVSpliterator.fromAsync accepts a PathBuilder", async () => {
		const rows = await CSVSpliterator.fromAsync(csvFixture).toArray()

		expect(rows.length, "Parsed some rows").toBeGreaterThan(0)
	})

	test("AsyncSpliterator.segments accepts a PathBuilder", async () => {
		const segments = await AsyncSpliterator.segments(fixture, { delimiter: "\n", concurrency: 2 })

		expect(segments.length, "Produced segments").toBeGreaterThan(0)
		expect(segments[0]![0], "First segment starts at zero").toBe(0)
	})

	test("AsyncSpliterator.asMany accepts a PathBuilder", async () => {
		const expected = await loadFixture(fixture)
		const spliterators = await AsyncSpliterator.asMany(fixture, { delimiter: "\n", concurrency: 2 })
		const decoder = new TextDecoder()
		const lines: string[] = []

		for (const spliterator of spliterators) {
			for await (const range of spliterator) {
				lines.push(decoder.decode(range))
			}
		}

		expect(lines.toSorted(), "Concatenated segments reproduce the file").toEqual(
			expected.decodedLines.filter(Boolean).toSorted()
		)
	})

	// A worker needs something that survives `postMessage`, which a PathBuilder does not — but it
	// resolves to a string before it ever gets there, so it must be accepted rather than rejected
	// alongside genuinely un-transferable sources like a file handle.
	test("asManyWorkers accepts a PathBuilder", async () => {
		const handler = fixturesDirectory("segment-handlers")("uppercase.js")
		const rows: string[] = []

		for await (const row of AsyncSpliterator.asManyWorkers<string>(fixture, {
			worker: handler.toString(),
			delimiter: "\n",
			concurrency: 2,
		})) {
			rows.push(row)
		}

		const expected = await loadFixture(fixture)

		expect(rows.toSorted()).toEqual(
			expected.decodedLines
				.filter(Boolean)
				.map((line) => line.toUpperCase())
				.toSorted()
		)
	})

	// `openDelimitedRows` *catches* a `readFileSize` failure and falls back to streaming, so before
	// this the adaptive bulk path was silently disabled for every PathBuilder source — the parse
	// still produced correct rows, which is why nothing caught it.
	test("readFileSize accepts a PathBuilder, so the bulk path is not silently skipped", async () => {
		const size = await readFileSize(fixture)
		const expected = await loadFixture(fixture)

		expect(size, "Reports the real size rather than throwing").toBe(expected.bytes.length)
	})

	test("readBytes accepts a PathBuilder", async () => {
		const window = await readBytes(fixture, 0, 16)
		const expected = await loadFixture(fixture)

		expect(Array.from(window)).toEqual(Array.from(expected.bytes.subarray(0, 16)))
	})

	test("a plain function is still rejected as a data resource", () => {
		expect(() => Spliterator.fromSync((() => "nope") as never), "Callability alone must not be read as a path").toThrow(
			TypeError
		)
	})
})
