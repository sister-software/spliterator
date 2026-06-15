/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { TSVSpliterator } from "spliterator"
import { test } from "vitest"

test("TSVSpliterator defaults columnDelimiter to Tab", ({ expect }) => {
	const tsv = "first\tlast\tage\nAda\tLovelace\t36\n"

	const rows = Array.from(TSVSpliterator.from(tsv, { mode: "array", header: false }))

	expect(rows).toEqual([
		["first", "last", "age"],
		["Ada", "Lovelace", "36"],
	])
})

test("TSVSpliterator preserves empty fields between consecutive tabs", ({ expect }) => {
	const tsv = "a\tb\tc\td\te\n1\t\t\t\t5\n"

	const rows = Array.from(TSVSpliterator.from(tsv, { mode: "array", header: false }))

	expect(rows).toEqual([
		["a", "b", "c", "d", "e"],
		["1", "", "", "", "5"],
	])
})

test("TSVSpliterator allows overriding the column delimiter", ({ expect }) => {
	const psv = "a|b|c\n1||3\n"

	const rows = Array.from(TSVSpliterator.from(psv, { mode: "array", header: false, columnDelimiter: "|" }))

	expect(rows).toEqual([
		["a", "b", "c"],
		["1", "", "3"],
	])
})

test("Async: TSVSpliterator defaults columnDelimiter to Tab and preserves empties", async ({ expect }) => {
	const tsv = "a\tb\tc\td\te\n1\t\t\t\t5\n"
	const bytes = new TextEncoder().encode(tsv)
	const chunkIterator = (async function* () {
		yield bytes
	})()

	const rows: string[][] = []

	for await (const row of TSVSpliterator.fromAsync(chunkIterator, { mode: "array", header: false })) {
		rows.push(row as string[])
	}

	expect(rows).toEqual([
		["a", "b", "c", "d", "e"],
		["1", "", "", "", "5"],
	])
})
