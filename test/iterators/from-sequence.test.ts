/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

import * as fs from "node:fs"

import { CSVSpliterator, Delimiters, JSONSpliterator, Sequence, TextSpliterator, TSVSpliterator } from "spliterator"
import { expect, test } from "vitest"

import { fixturesDirectory } from "../support/utils.js"

interface CarvelRow {
	item_name: string
	category: string
	size: string
	PRICE: string
}

const jsonlPath = fixturesDirectory("carvel.jsonl").toString()
const csvPath = fixturesDirectory("carvel.csv").toString()
const textPath = fixturesDirectory("phonetic-single-spaced.txt").toString()

const jsonlSource = fs.readFileSync(jsonlPath)
const csvSource = fs.readFileSync(csvPath)
const textSource = fs.readFileSync(textPath)

test("from returns a chainable sequence", () => {
	const sequence = JSONSpliterator.from<CarvelRow>(jsonlSource, { delimiter: Delimiters.LineFeed })

	expect(sequence).toBeInstanceOf(Sequence)
	expect(typeof sequence.toMap).toBe("function")
})

test("from parses nothing until the sequence is iterated", () => {
	let parsed = 0

	const counting = new Proxy(jsonlSource, {
		get(target, property, receiver) {
			parsed++

			return Reflect.get(target, property, receiver) as unknown
		},
	})

	JSONSpliterator.from<CarvelRow>(counting, { delimiter: Delimiters.LineFeed }).map((row) => row)

	expect(parsed).toBe(0)
})

test("JSONSpliterator: filter and map chain", () => {
	const cakes = JSONSpliterator.from<CarvelRow>(jsonlSource, { delimiter: Delimiters.LineFeed, skipEmpty: true })
		.filter((row) => row.category === "Ice Cream Cake")
		.map((row) => row.item_name)
		.toArray()

	const expected = fs
		.readFileSync(jsonlPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as CarvelRow)
		.filter((row) => row.category === "Ice Cream Cake")
		.map((row) => row.item_name)

	expect(cakes).toEqual(expected)
	expect(cakes.length).toBeGreaterThan(0)
})

test("JSONSpliterator: toMap keys rows without materializing an array", () => {
	const byName = JSONSpliterator.from<CarvelRow>(jsonlSource, { delimiter: Delimiters.LineFeed, skipEmpty: true })
		.take(3)
		.toMap((row) => [row.item_name, row.category])

	expect(byName.size).toBe(3)

	for (const [name, category] of byName) {
		expect(typeof name).toBe("string")
		expect(typeof category).toBe("string")
	}
})

test("TextSpliterator: drop and take compose over a real file", () => {
	const lines = TextSpliterator.from(textSource, { delimiter: Delimiters.LineFeed, skipEmpty: true })
		.drop(2)
		.take(3)
		.toArray()

	const expected = fs.readFileSync(textPath, "utf8").split("\n").filter(Boolean).slice(2, 5)

	expect(lines).toEqual(expected)
})

test("TextSpliterator: toSet deduplicates", () => {
	const initials = TextSpliterator.from(textSource, { delimiter: Delimiters.LineFeed, skipEmpty: true }).toSet((line) =>
		line.slice(0, 1)
	)

	const expected = new Set(
		fs
			.readFileSync(textPath, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => line.slice(0, 1))
	)

	expect(initials).toEqual(expected)
})

test("CSVSpliterator: chains in object mode", () => {
	const names = CSVSpliterator.from(csvSource, { mode: "object" })
		.filter((row) => Boolean((row as Record<string, string>).item_name))
		.map((row) => (row as Record<string, string>).item_name)
		.take(3)
		.toArray()

	expect(names).toHaveLength(3)
	expect(names.every((name) => typeof name === "string" && name.length > 0)).toBe(true)
})

test("CSVSpliterator: array mode still yields the same rows it always did", () => {
	// The rows are unquoted, so `String.prototype.split` is a fair oracle. The fixture's quoted commas are not part of this
	// comparison.
	const source = "a,b,c\n1,2,3\n4,5,6\n"

	const rows = CSVSpliterator.from(source, { mode: "array", header: false }).toArray()

	const expected = source
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split(","))

	expect(rows).toEqual(expected)
})

test("TSVSpliterator inherits the sequence return type", () => {
	const sequence = TSVSpliterator.from(Buffer.from("a\tb\n1\t2\n"), { mode: "object" })

	expect(sequence).toBeInstanceOf(Sequence)
	expect(sequence.toArray()).toEqual([{ a: "1", b: "2" }])
})
