/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { computeSegments, Spliterator } from "spliterator"
import { afterAll, describe, expect, test } from "vitest"

const dir = mkdtempSync(join(tmpdir(), "spliterator-seg-"))
afterAll(async () => (await import("node:fs/promises")).rm(dir, { recursive: true, force: true }))

function fixture(name: string, text: string): string {
	const p = join(dir, name)
	writeFileSync(p, text)

	return p
}

/** Records of the whole file, parsed sequentially (the oracle). */
function sequentialRecords(text: string): string[] {
	return Spliterator.fromSync(new TextEncoder().encode(text), { skipEmpty: false }).toDecodedArray()
}

/** Records reconstructed by concatenating each segment's parse. */
function recordsFromSegments(text: string, segments: Array<[number, number]>): string[] {
	const bytes = new TextEncoder().encode(text)
	const out: string[] = []

	for (const [start, end] of segments) {
		out.push(...Spliterator.fromSync(bytes.subarray(start, end), { skipEmpty: false }).toDecodedArray())
	}

	return out
}

describe("computeSegments", () => {
	test("segments are contiguous and cover the whole file", async () => {
		const text = Array.from({ length: 1000 }, (_, i) => `row-${i}`).join("\n") + "\n"
		const p = fixture("rows.txt", text)

		const segments = await computeSegments(p, { delimiter: "\n", concurrency: 4 })

		expect(segments[0]![0]).toBe(0)
		expect(segments.at(-1)![1]).toBe(text.length)

		for (let i = 1; i < segments.length; i++) expect(segments[i]![0]).toBe(segments[i - 1]![1])
	})

	test("every internal boundary sits right after a delimiter (no split records)", async () => {
		const text = Array.from({ length: 1000 }, (_, i) => `row-${i}`).join("\n") + "\n"
		const p = fixture("rows2.txt", text)

		const segments = await computeSegments(p, { delimiter: "\n", concurrency: 7 })
		const oracle = sequentialRecords(text).filter((r) => r.length > 0)
		const got = recordsFromSegments(text, segments).filter((r) => r.length > 0)

		expect(got).toEqual(oracle)
	})

	test("concurrency 1 yields a single full-file segment", async () => {
		const p = fixture("one.txt", "a\nb\nc\n")

		expect(await computeSegments(p, { delimiter: "\n", concurrency: 1 })).toEqual([[0, 6]])
	})

	test("empty file yields no segments", async () => {
		const p = fixture("empty.txt", "")

		expect(await computeSegments(p, { delimiter: "\n", concurrency: 4 })).toEqual([])
	})

	test("a record longer than probeSize collapses its boundary, never splitting it", async () => {
		const long = "x".repeat(5000)
		const text = `${long}\n${long}\n`
		const p = fixture("long.txt", text)

		const segments = await computeSegments(p, { delimiter: "\n", concurrency: 4, probeSize: 1024 })
		const got = recordsFromSegments(text, segments).filter((r) => r.length > 0)

		expect(got).toEqual([long, long])
	})
})
