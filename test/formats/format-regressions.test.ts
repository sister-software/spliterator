/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { CSVSpliterator, normalizeColumnNames, type CSVSpliteratorInit } from "spliterator"
import { describe, expect, test } from "vitest"

const encoder = new TextEncoder()

async function* chunks(text: string): AsyncIterableIterator<Uint8Array> {
	yield encoder.encode(text)
}

describe("CSV transformers", () => {
	test("accepts the entry form, keyed by column name", () => {
		const rows = CSVSpliterator.from("name,age\nAda,36\n", { transformers: [["age", Number]] }).toArray()

		expect(rows).toEqual([{ name: "Ada", age: 36 }])
	})

	test("accepts any iterable of entries", () => {
		const entries = new Map([["age", Number]])
		const rows = CSVSpliterator.from("name,age\nAda,36\n", { transformers: entries }).toArray()

		expect(rows).toEqual([{ name: "Ada", age: 36 }])
	})

	test("do not run on dropped rows, on either engine", async () => {
		const seenSync: string[] = []
		const seenAsync: string[] = []
		const text = "n\n1\n2\n3\n4\n"

		const sync = CSVSpliterator.from(text, {
			drop: 1,
			take: 2,
			transformers: { n: (v) => (seenSync.push(v), Number(v)) },
		}).toArray()

		const async = await CSVSpliterator.fromAsync(chunks(text), {
			drop: 1,
			take: 2,
			transformers: { n: (v) => (seenAsync.push(v), Number(v)) },
		}).toArray()

		expect(sync).toEqual([{ n: 2 }, { n: 3 }])
		expect(async).toEqual(sync)
		expect(seenSync).toEqual(["2", "3"])
		expect(seenAsync).toEqual(seenSync)
	})
})

describe("CSV drop and take", () => {
	test("a negative drop is treated as zero on both engines", async () => {
		const text = "n\n1\n2\n3\n4\n5\n6\n"
		const init = { drop: -2, take: 5 }

		const sync = CSVSpliterator.from(text, init).toArray()
		const async = await CSVSpliterator.fromAsync(chunks(text), init).toArray()

		expect(sync).toHaveLength(5)
		expect(async).toEqual(sync)
	})
})

describe("CSV option typing", () => {
	test("fromAsync accepts bulkThreshold without a cast", async () => {
		const rows = await CSVSpliterator.fromAsync(chunks("a,b\n1,2\n"), { bulkThreshold: 0 }).toArray()

		expect(rows).toEqual([{ a: "1", b: "2" }])
	})

	test("from accepts a general init and header: false with object mode", () => {
		const init: CSVSpliteratorInit = { header: false, mode: "object" }
		const rows = CSVSpliterator.from("a,b\n1,2\n", init).toArray()

		expect(rows).toEqual([
			{ column_0: "a", column_1: "b" },
			{ column_0: "1", column_1: "2" },
		])
	})
})

describe("normalizeColumnNames", () => {
	test("keeps one key per header when a suffix collides with a literal header", () => {
		const names = normalizeColumnNames(["a_2", "a", "a"])

		expect(names).toHaveLength(3)
		expect(new Set(names).size).toBe(3)
	})
})
