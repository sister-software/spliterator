/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import * as fs from "node:fs/promises"

import { AsyncSequence, CSVSpliterator, Delimiters, JSONSpliterator, TextSpliterator } from "spliterator"
import { expect, test } from "vitest"

import { fixturesDirectory } from "./utils.js"

interface CarvelRow {
	item_name: string
	category: string
	size: string
	PRICE: string
}

const jsonlPath = fixturesDirectory("carvel.jsonl").toString()
const csvPath = fixturesDirectory("carvel.csv").toString()
const textPath = fixturesDirectory("phonetic-single-spaced.txt").toString()

test("fromAsync returns a chainable sequence synchronously", () => {
	const sequence = JSONSpliterator.fromAsync<CarvelRow>(jsonlPath, { delimiter: Delimiters.LineFeed })

	expect(sequence).toBeInstanceOf(AsyncSequence)
	expect(typeof sequence.filter).toBe("function")
})

test("fromAsync opens nothing until the sequence is iterated", async () => {
	const missing = fixturesDirectory("does-not-exist.jsonl").toString()

	// Constructing and chaining must not touch the filesystem — the failure surfaces on the first pull.
	const sequence = JSONSpliterator.fromAsync(missing, { delimiter: Delimiters.LineFeed }).map((row) => row)

	await expect(sequence.toArray()).rejects.toThrow(/Cannot read from the provided source/)
})

test("JSONSpliterator: filter and map stream without materializing the file", async () => {
	const cakes = await JSONSpliterator.fromAsync<CarvelRow>(jsonlPath, {
		delimiter: Delimiters.LineFeed,
		skipEmpty: true,
	})
		.filter((row) => row.category === "Ice Cream Cake")
		.map((row) => row.item_name)
		.toArray()

	const expected = (await fs.readFile(jsonlPath, "utf8"))
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as CarvelRow)
		.filter((row) => row.category === "Ice Cream Cake")
		.map((row) => row.item_name)

	expect(cakes).toEqual(expected)
	expect(cakes.length).toBeGreaterThan(0)
})

test("JSONSpliterator: take short-circuits and releases the file handle", async () => {
	const before = process.getActiveResourcesInfo().length

	const first = await JSONSpliterator.fromAsync<CarvelRow>(jsonlPath, {
		delimiter: Delimiters.LineFeed,
		skipEmpty: true,
	})
		.take(2)
		.map((row) => row.item_name)
		.toArray()

	expect(first).toHaveLength(2)

	// Give the close a turn to settle before counting.
	await new Promise((resolve) => {
		setImmediate(resolve)
	})

	expect(process.getActiveResourcesInfo().length).toBeLessThanOrEqual(before)
})

test("TextSpliterator: drop and take compose over a real file", async () => {
	const lines = await TextSpliterator.fromAsync(textPath, { delimiter: Delimiters.LineFeed, skipEmpty: true })
		.drop(2)
		.take(3)
		.toArray()

	const expected = (await fs.readFile(textPath, "utf8")).split("\n").filter(Boolean).slice(2, 5)

	expect(lines).toEqual(expected)
})

test("CSVSpliterator: chains in object mode", async () => {
	const names = await CSVSpliterator.fromAsync(csvPath, { mode: "object" })
		.filter((row) => Boolean((row as Record<string, string>).item_name))
		.map((row) => (row as Record<string, string>).item_name)
		.take(3)
		.toArray()

	expect(names).toHaveLength(3)
	expect(names.every((name) => typeof name === "string" && name.length > 0)).toBe(true)
})

test("parallelMap over a sequence of rows keeps every result", async () => {
	const lengths = await JSONSpliterator.fromAsync<CarvelRow>(jsonlPath, {
		delimiter: Delimiters.LineFeed,
		skipEmpty: true,
	})
		.parallelMap(async (row) => row.item_name.length, { concurrency: 3 })
		.toArray()

	const rowCount = (await fs.readFile(jsonlPath, "utf8")).split("\n").filter(Boolean).length

	expect(lengths).toHaveLength(rowCount)
})
