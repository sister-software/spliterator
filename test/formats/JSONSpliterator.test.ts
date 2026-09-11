/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { JSONSpliterator } from "spliterator"
import { test } from "vitest"

import { fixturesDirectory, loadFixture } from "../support/utils.js"

interface SuiteRow {
	id: string
	input: string
	expect: { road: string }
}

const EXPECTED_IDS = ["a-1", "a-2", "a-3", "a-4"]

test("Synchronous comment and blank rows are skipped", async ({ expect }) => {
	const fixture = await loadFixture(fixturesDirectory("commented.jsonl"))

	const rows = JSONSpliterator.from<SuiteRow>(fixture.bytes, { comment: "//" }).toArray()

	expect(
		rows.map((row) => row.id),
		"Only data rows survive"
	).toMatchObject(EXPECTED_IDS)
})

test("Asynchronous comment and blank rows are skipped", async ({ expect }) => {
	const fixturePath = fixturesDirectory("commented.jsonl")

	const rows = await JSONSpliterator.fromAsync<SuiteRow>(fixturePath, { comment: "//" }).toArray()

	expect(
		rows.map((row) => row.id),
		"Only data rows survive"
	).toMatchObject(EXPECTED_IDS)
})

// The adaptive source parses anything at or below `bulkThreshold` with the synchronous engine and
// streams the rest. Both reach the same filter, so both are asserted — a fixture this small would
// otherwise only ever exercise the bulk path.
test("Streaming path skips comment and blank rows", async ({ expect }) => {
	const fixturePath = fixturesDirectory("commented.jsonl")

	const rows = await JSONSpliterator.fromAsync<SuiteRow>(fixturePath, {
		comment: "//",
		bulkThreshold: 0,
	}).toArray()

	expect(
		rows.map((row) => row.id),
		"Only data rows survive"
	).toMatchObject(EXPECTED_IDS)
})

test("Synchronous and asynchronous parity", async ({ expect }) => {
	const fixturePath = fixturesDirectory("commented.jsonl")
	const fixture = await loadFixture(fixturePath)

	const synchronous = JSONSpliterator.from<SuiteRow>(fixture.bytes, { comment: "//" }).toArray()
	const asynchronous = await JSONSpliterator.fromAsync<SuiteRow>(fixturePath, { comment: "//" }).toArray()

	expect(asynchronous, "Both engines agree").toMatchObject(synchronous)
})

test("Multiple comment prefixes", ({ expect }) => {
	const source = ["# hash header", '{"id":"a-1"}', "// slash header", '{"id":"a-2"}'].join("\n")

	const rows = JSONSpliterator.from<{ id: string }>(source, { comment: ["//", "#"] }).toArray()

	expect(
		rows.map((row) => row.id),
		"Both prefixes are honored"
	).toMatchObject(["a-1", "a-2"])
})

test("Whitespace-only rows are skipped", ({ expect }) => {
	const source = ['{"id":"a-1"}', "   ", "\t", " \t ", '{"id":"a-2"}'].join("\n")

	const rows = JSONSpliterator.from<{ id: string }>(source, { comment: "//" }).toArray()

	expect(
		rows.map((row) => row.id),
		"Blank rows never reach JSON.parse"
	).toMatchObject(["a-1", "a-2"])
})

// The prefix describes the start of a row, not a substring of it. Fixture row `a-4` carries `//`
// inside a string value; a naive `includes` would drop it.
test("Comment prefix inside a value is not a comment", async ({ expect }) => {
	const fixture = await loadFixture(fixturesDirectory("commented.jsonl"))

	const rows = JSONSpliterator.from<SuiteRow>(fixture.bytes, { comment: "//" }).toArray()

	expect(rows.at(-1)?.expect.road, "Value containing the prefix is preserved").toBe("// Pine Ln")
})

test("Comment rows throw when no prefix is configured", async ({ expect }) => {
	const fixture = await loadFixture(fixturesDirectory("commented.jsonl"))

	expect(() => JSONSpliterator.from(fixture.bytes).toArray(), "Default behavior is unchanged").toThrow(SyntaxError)
})

// The reason this is a prefix test rather than a try-parse-and-recover: a malformed record must
// stay loud. Recovering from a `JSON.parse` throw cannot tell a fixture header from corrupt data.
test("Malformed rows still throw when a prefix is configured", ({ expect }) => {
	const source = ["// header", '{"id":"a-1"}', "{not json", '{"id":"a-2"}'].join("\n")

	expect(() => JSONSpliterator.from(source, { comment: "//" }).toArray(), "Corrupt data is not swallowed").toThrow(
		SyntaxError
	)
})

test("Malformed rows still throw on the asynchronous path", async ({ expect }) => {
	const source = ["// header", '{"id":"a-1"}', "{not json"].join("\n")
	const bytes = new TextEncoder().encode(source)

	await expect(
		JSONSpliterator.fromAsync(
			(async function* () {
				yield bytes
			})(),
			{ comment: "//" }
		).toArray(),
		"Corrupt data is not swallowed"
	).rejects.toThrow(SyntaxError)
})

test("Rows are unaffected when no prefix matches", ({ expect }) => {
	const source = ['{"id":"a-1"}', '{"id":"a-2"}'].join("\n")

	const rows = JSONSpliterator.from<{ id: string }>(source, { comment: "//" }).toArray()

	expect(
		rows.map((row) => row.id),
		"Ordinary JSONL is untouched"
	).toMatchObject(["a-1", "a-2"])
})

// `skipEmpty: false` keeps zero-length rows in the stream, which would otherwise reach `JSON.parse`
// and throw. Configuring `comment` opts into blank skipping regardless of how the engine is set.
test("Zero-length rows are skipped even with skipEmpty disabled", ({ expect }) => {
	const source = ['{"id":"a-1"}', "", "", '{"id":"a-2"}'].join("\n")

	const rows = JSONSpliterator.from<{ id: string }>(source, { comment: "//", skipEmpty: false }).toArray()

	expect(
		rows.map((row) => row.id),
		"Empty rows never reach JSON.parse"
	).toMatchObject(["a-1", "a-2"])
})
