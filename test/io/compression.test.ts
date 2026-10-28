/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 *
 * Transparent decompression and the compressed-sibling lookup, against real files. The byte-level cases (frame
 * concatenation, chunk boundaries) are in `conformance/compression.json`; these cover what only a path exercises.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync, zstdCompressSync } from "node:zlib"

import {
	AsyncSpliterator,
	CSVSpliterator,
	JSONSpliterator,
	sniffCompression,
	Spliterator,
	TextSpliterator,
	TSVSpliterator,
} from "spliterator"
import { afterAll, beforeAll, describe, expect, test } from "vitest"

let directory: string

const lines = Array.from({ length: 2000 }, (_, i) => `{"id":${i},"name":"row ${i}"}`).join("\n") + "\n"
const expectedIds = Array.from({ length: 2000 }, (_, i) => i)

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "spliterator-compression-"))

	await writeFile(join(directory, "plain.jsonl"), lines)
	await writeFile(join(directory, "zstd.jsonl.zst"), zstdCompressSync(lines))
	await writeFile(join(directory, "gzip.jsonl.gz"), gzipSync(lines))
	// No extension at all: detection is by magic bytes.
	await writeFile(join(directory, "anonymous"), zstdCompressSync(lines))

	// A plain file with a compressed sibling holding different rows, so the test can tell which one was read.
	await writeFile(join(directory, "part.jsonl"), '{"id":-1}\n')
	await writeFile(join(directory, "part.jsonl.zst"), zstdCompressSync(lines))

	await writeFile(join(directory, "only-gz.csv"), "a\nplain\n")
	await writeFile(join(directory, "only-gz.csv.gz"), gzipSync("a\ngzipped\n"))
})

afterAll(async () => {
	await rm(directory, { recursive: true, force: true })
})

const ids = (rows: Array<{ id: number }>) => rows.map((row) => row.id)

const COMPRESSED_FILES = ["zstd.jsonl.zst", "gzip.jsonl.gz", "anonymous"].flatMap((name) => [
	{ name, bulkThreshold: 0, mode: "streamed" },
	{ name, bulkThreshold: undefined, mode: "adaptive" },
])

describe("compressed paths", () => {
	test.for(COMPRESSED_FILES)("$name reads as its content ($mode)", async ({ name, bulkThreshold }) => {
		const rows = await JSONSpliterator.fromAsync<{ id: number }>(join(directory, name), { bulkThreshold }).toArray()

		expect(ids(rows)).toEqual(expectedIds)
	})

	test("a compressed path can be read twice", async () => {
		const path = join(directory, "zstd.jsonl.zst")

		expect(await TextSpliterator.countAsync(path)).toBe(2000)
		expect(ids(await JSONSpliterator.fromAsync<{ id: number }>(path).toArray())).toEqual(expectedIds)
		expect(ids(await JSONSpliterator.fromAsync<{ id: number }>(path).toArray())).toEqual(expectedIds)
	})

	test("the raw engine decompresses too", async () => {
		const engine = await AsyncSpliterator.from(join(directory, "gzip.jsonl.gz"))

		expect(await engine.toDecodedArray()).toHaveLength(2000)
	})

	test("an early exit releases a compressed source", async () => {
		const rows = await JSONSpliterator.fromAsync<{ id: number }>(join(directory, "zstd.jsonl.zst"), {
			bulkThreshold: 0,
		})
			.take(3)
			.toArray()

		expect(ids(rows)).toEqual([0, 1, 2])
	})

	test("decompress: false reads the compressed bytes as given", async () => {
		const path = join(directory, "gzip.jsonl.gz")
		const engine = await AsyncSpliterator.from(path, { decompress: false })
		const [first] = await engine.toArray()

		expect(sniffCompression(first!)).toBe("gzip")
	})

	test("a compressed source refuses to be segmented", async () => {
		await expect(AsyncSpliterator.segments(join(directory, "zstd.jsonl.zst"), { concurrency: 4 })).rejects.toThrow(
			/cannot be segmented/
		)
	})
})

describe("compressed bytes in memory", () => {
	test("from(bytes) decompresses", () => {
		const rows = JSONSpliterator.from<{ id: number }>(zstdCompressSync(lines)).toArray()

		expect(ids(rows)).toEqual(expectedIds)
	})

	test("CSV and TSV from(bytes) and count decompress", () => {
		expect(CSVSpliterator.from(gzipSync("a,b\n1,2\n")).toArray()).toEqual([{ a: "1", b: "2" }])
		expect(TSVSpliterator.count(gzipSync("a\tb\n1\t2\n3\t4\n"))).toBe(2)
		expect(TextSpliterator.count(zstdCompressSync("x\ny\n"))).toBe(2)
	})

	test("the synchronous engine reads bytes as given", () => {
		const compressed = gzipSync("a\nb\n")

		expect(Spliterator.fromSync(compressed, { skipEmpty: false }).toArray().length).toBeGreaterThan(0)

		expect(
			Spliterator.fromSync(compressed)
				.toArray()
				.flatMap((range) => Array.from(range))
		).toEqual(Array.from(compressed).filter((byte) => byte !== 0x0a))
	})

	test("decompress: false parses the compressed bytes", () => {
		expect(() => JSONSpliterator.from(gzipSync('{"a":1}'), { decompress: false }).toArray()).toThrow(SyntaxError)
	})
})

describe("compressed sibling lookup", () => {
	test("a path reads its .zst sibling when one exists", async () => {
		const rows = await JSONSpliterator.fromAsync<{ id: number }>(join(directory, "part.jsonl")).toArray()

		expect(ids(rows)).toEqual(expectedIds)
	})

	test("the lookup applies when streaming too", async () => {
		const rows = await JSONSpliterator.fromAsync<{ id: number }>(join(directory, "part.jsonl"), {
			bulkThreshold: 0,
		}).toArray()

		expect(ids(rows)).toEqual(expectedIds)
	})

	test("a .gz sibling is used when there is no .zst", async () => {
		expect(await CSVSpliterator.fromAsync(join(directory, "only-gz.csv")).toArray()).toEqual([{ a: "gzipped" }])
	})

	test("preferCompressed: false reads the path as given", async () => {
		const rows = await JSONSpliterator.fromAsync<{ id: number }>(join(directory, "part.jsonl"), {
			preferCompressed: false,
		}).toArray()

		expect(ids(rows)).toEqual([-1])

		const engine = await Spliterator.fromAsync(join(directory, "part.jsonl"), { preferCompressed: false })

		expect(await engine.toDecodedArray()).toEqual(['{"id":-1}'])
	})

	test("segmenting never redirects to a sibling", async () => {
		const segments = await AsyncSpliterator.segments(join(directory, "part.jsonl"), { concurrency: 1 })

		expect(segments).toEqual([[0, '{"id":-1}\n'.length]])
	})
})
