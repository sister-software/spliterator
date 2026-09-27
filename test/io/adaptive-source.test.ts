/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import * as fs from "node:fs/promises"

import {
	type AsyncChunkIterator,
	CharacterSequence,
	CSVSpliterator,
	Delimiters,
	JSONSpliterator,
	openDelimitedRows,
	TextSpliterator,
} from "spliterator"
import { describe, expect, test } from "vitest"

import { fixturesDirectory } from "../support/utils.js"

const jsonlPath = fixturesDirectory("carvel.jsonl").toString()
const csvPath = fixturesDirectory("carvel.csv").toString()
const textPath = fixturesDirectory("phonetic-single-spaced.txt").toString()

/**
 * `bulkThreshold: 0` forces streaming. The default reads these fixtures whole. Any disagreement between the two is a
 * bug in one of the two engines, so every case below is asserted as a pair.
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
		// The header must be consumed instead of emitted as a row.
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

describe("documented defaults", () => {
	test("the row delimiter defaults to a line feed", async () => {
		const rows = await TextSpliterator.fromAsync(chunkedSource(new TextEncoder().encode("a,b\nc,d"), 1024)).toArray()

		expect(rows).toEqual(["a,b", "c,d"])
	})

	test("skipEmpty defaults to dropping empties, and false matches String.prototype.split", async () => {
		const source = () => chunkedSource(new TextEncoder().encode("a\n\nb"), 1024)

		expect(await TextSpliterator.fromAsync(source()).toArray()).toEqual(["a", "b"])
		expect(await TextSpliterator.fromAsync(source(), { skipEmpty: false }).toArray()).toEqual("a\n\nb".split("\n"))
	})
})

describe("bulk parser hook", () => {
	const encoder = new TextEncoder()
	const marker = (bytes: Uint8Array) => [`bulk:${bytes.byteLength}`]

	test("a sized source at or below the threshold is handed to the bulk parser whole", async () => {
		const rows = await openDelimitedRows(csvPath, BULK, marker)

		expect(Array.from(rows as Iterable<string>)).toEqual([`bulk:${(await fs.stat(csvPath)).size}`])
	})

	test("a sized source above the threshold streams and never calls the bulk parser", async () => {
		let calls = 0

		const counting = (bytes: Uint8Array) => {
			calls++

			return marker(bytes)
		}

		const rows = await openDelimitedRows(csvPath, { bulkThreshold: 16 }, counting)

		expect(Symbol.asyncIterator in rows).toBe(true)
		expect(calls).toBe(0)
	})

	test("an empty stream and a single exhausted chunk take the bulk parser; two chunks stream", async () => {
		const bytes = encoder.encode("a,b\nc,d\n")
		const emptySource = chunkedSource(new Uint8Array(0), 4)
		const singleSource = chunkedSource(bytes, 1024)
		const manyChunks = chunkedSource(bytes, 4)
		const empty = await openDelimitedRows(emptySource, BULK, marker)
		const single = await openDelimitedRows(singleSource, BULK, marker)
		const streamed = await openDelimitedRows(manyChunks, BULK, marker)

		expect(Array.from(empty as Iterable<string>)).toEqual(["bulk:0"])
		expect(Array.from(single as Iterable<string>)).toEqual(["bulk:8"])
		expect(Symbol.asyncIterator in streamed).toBe(true)
	})

	test("a single chunk above the threshold streams", async () => {
		const bytes = encoder.encode("a,b\nc,d\n")
		const oneChunk = chunkedSource(bytes, 1024)
		const streamed = await openDelimitedRows(oneChunk, { bulkThreshold: 4 }, marker)

		expect(Symbol.asyncIterator in streamed).toBe(true)
	})

	test("bulkThreshold: 0 streams even with a bulk parser", async () => {
		const streamed = await openDelimitedRows(csvPath, STREAMING, marker)

		expect(Symbol.asyncIterator in streamed).toBe(true)
	})

	test("the bulk parser is called after the scanner is ready", async () => {
		let ready = false

		await openDelimitedRows(csvPath, BULK, (bytes) => {
			ready = CharacterSequence.hasScanner()

			return marker(bytes)
		})

		expect(ready).toBe(true)
	})
})
