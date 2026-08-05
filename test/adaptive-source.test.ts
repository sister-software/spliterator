/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import * as fs from "node:fs/promises"

import {
	type AsyncChunkIterator,
	CSVSpliterator,
	Delimiters,
	JSONSpliterator,
	openDelimitedRows,
	TextSpliterator,
} from "spliterator"
import { describe, expect, test } from "vitest"

import { fixturesDirectory } from "./utils.js"

const jsonlPath = fixturesDirectory("carvel.jsonl").toString()
const csvPath = fixturesDirectory("carvel.csv").toString()
const textPath = fixturesDirectory("phonetic-single-spaced.txt").toString()

/**
 * `bulkThreshold: 0` forces streaming; the default reads these fixtures whole. Anything the two disagree on is a bug in
 * one of the two engines, so every case below is asserted as a pair.
 */
const STREAMING = { bulkThreshold: 0 } as const
const BULK = { bulkThreshold: 64 * 1024 * 1024 } as const

/**
 * Emit `bytes` in fixed-size chunks, so a source with no knowable length can be tested at both one chunk and many.
 */
function chunkedSource(bytes: Uint8Array, chunkSize: number): AsyncChunkIterator {
	return {
		async *[Symbol.asyncIterator]() {
			for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
				yield bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength))
			}
		},
	}
}

describe("parity between the bulk and streaming engines", () => {
	test("TextSpliterator yields identical rows", async () => {
		const streamed = await TextSpliterator.fromAsync(textPath, {
			delimiter: Delimiters.LineFeed,
			skipEmpty: true,
			...STREAMING,
		}).toArray()

		const bulked = await TextSpliterator.fromAsync(textPath, {
			delimiter: Delimiters.LineFeed,
			skipEmpty: true,
			...BULK,
		}).toArray()

		expect(bulked).toEqual(streamed)
		expect(bulked.length).toBeGreaterThan(0)
	})

	test("JSONSpliterator yields identical rows", async () => {
		const options = { delimiter: Delimiters.LineFeed, skipEmpty: true }

		const streamed = await JSONSpliterator.fromAsync(jsonlPath, { ...options, ...STREAMING }).toArray()
		const bulked = await JSONSpliterator.fromAsync(jsonlPath, { ...options, ...BULK }).toArray()

		expect(bulked).toEqual(streamed)
		expect(bulked.length).toBeGreaterThan(0)
	})

	test("CSVSpliterator consumes the header identically in both engines", async () => {
		const streamed = await CSVSpliterator.fromAsync(csvPath, { mode: "object", ...STREAMING }).toArray()
		const bulked = await CSVSpliterator.fromAsync(csvPath, { mode: "object", ...BULK }).toArray()

		expect(bulked).toEqual(streamed)
		expect(bulked.length).toBeGreaterThan(0)
		// The header must be consumed, not emitted as a row.
		expect(Object.keys(bulked[0] as object).length).toBeGreaterThan(1)
	})

	test("take and drop agree across engines", async () => {
		const options = { delimiter: Delimiters.LineFeed, skipEmpty: true }

		const streamed = await TextSpliterator.fromAsync(textPath, { ...options, ...STREAMING })
			.drop(2)
			.take(3)
			.toArray()

		const bulked = await TextSpliterator.fromAsync(textPath, { ...options, ...BULK })
			.drop(2)
			.take(3)
			.toArray()

		expect(bulked).toEqual(streamed)
		expect(bulked).toHaveLength(3)
	})

	test("a file above the threshold streams", async () => {
		const size = (await fs.stat(textPath)).size

		const rows = await TextSpliterator.fromAsync(textPath, {
			delimiter: Delimiters.LineFeed,
			skipEmpty: true,
			bulkThreshold: Math.max(1, Math.floor(size / 2)),
		}).toArray()

		const expected = (await fs.readFile(textPath, "utf8")).split("\n").filter(Boolean)

		expect(rows).toEqual(expected)
	})
})

describe("unsized sources", () => {
	test("a single-chunk stream is parsed whole", async () => {
		const bytes = new Uint8Array(await fs.readFile(jsonlPath))

		const rows = await JSONSpliterator.fromAsync(chunkedSource(bytes, bytes.byteLength), {
			delimiter: Delimiters.LineFeed,
			skipEmpty: true,
		}).toArray()

		const expected = (await fs.readFile(jsonlPath, "utf8"))
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as unknown)

		expect(rows).toEqual(expected)
	})

	test.each([1, 7, 64, 1024])("a stream re-headed after %s-byte chunks loses nothing", async (chunkSize) => {
		const bytes = new Uint8Array(await fs.readFile(jsonlPath))

		const rows = await JSONSpliterator.fromAsync(chunkedSource(bytes, chunkSize), {
			delimiter: Delimiters.LineFeed,
			skipEmpty: true,
		}).toArray()

		const expected = (await fs.readFile(jsonlPath, "utf8"))
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as unknown)

		expect(rows).toEqual(expected)
	})

	test("an exactly-two-chunk stream keeps both chunks", async () => {
		const bytes = new Uint8Array(await fs.readFile(jsonlPath))
		const half = Math.ceil(bytes.byteLength / 2)

		const rows = await TextSpliterator.fromAsync(chunkedSource(bytes, half), {
			delimiter: Delimiters.LineFeed,
			skipEmpty: true,
		}).toArray()

		expect(rows).toEqual((await fs.readFile(jsonlPath, "utf8")).split("\n").filter(Boolean))
	})

	test("an empty stream yields nothing", async () => {
		const rows = await TextSpliterator.fromAsync(chunkedSource(new Uint8Array(0), 16), {
			delimiter: Delimiters.LineFeed,
			skipEmpty: true,
		}).toArray()

		expect(rows).toEqual([])
	})

	test("a single-chunk stream above the threshold still streams", async () => {
		const bytes = new Uint8Array(await fs.readFile(jsonlPath))

		const rows = await TextSpliterator.fromAsync(chunkedSource(bytes, bytes.byteLength), {
			delimiter: Delimiters.LineFeed,
			skipEmpty: true,
			bulkThreshold: 8,
		}).toArray()

		expect(rows).toEqual((await fs.readFile(jsonlPath, "utf8")).split("\n").filter(Boolean))
	})

	test("string chunks are handled", async () => {
		const text = await fs.readFile(jsonlPath, "utf8")

		const source: AsyncChunkIterator = {
			async *[Symbol.asyncIterator]() {
				yield text
			},
		}

		const rows = await TextSpliterator.fromAsync(source, {
			delimiter: Delimiters.LineFeed,
			skipEmpty: true,
		}).toArray()

		expect(rows).toEqual(text.split("\n").filter(Boolean))
	})
})

describe("openDelimitedRows", () => {
	test("returns a sync iterable below the threshold and an async one above", async () => {
		const below = await openDelimitedRows(jsonlPath, { delimiter: Delimiters.LineFeed })
		const above = await openDelimitedRows(jsonlPath, { delimiter: Delimiters.LineFeed, bulkThreshold: 1 })

		expect(Symbol.iterator in below).toBe(true)
		expect(Symbol.asyncIterator in above).toBe(true)
	})

	test("bulkThreshold 0 always streams", async () => {
		const rows = await openDelimitedRows(jsonlPath, { delimiter: Delimiters.LineFeed, bulkThreshold: 0 })

		expect(Symbol.asyncIterator in rows).toBe(true)
	})
})
