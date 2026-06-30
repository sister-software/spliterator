/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { parallelMap } from "spliterator"
import { describe, expect, test } from "vitest"

const handlerDir = fileURLToPath(new URL("./fixtures/parallel-handlers/", import.meta.url))

async function* range(n: number): AsyncIterableIterator<number> {
	for (let i = 0; i < n; i++) yield i
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = []

	for await (const v of source) out.push(v)

	return out
}

describe("parallelMap", () => {
	test("maps every item across the worker pool (completion order ⇒ set)", async () => {
		const got = await collect(
			parallelMap<number, number>(range(200), { worker: join(handlerDir, "double.js"), concurrency: 4, batchSize: 16 })
		)

		expect(got.sort((a, b) => a - b)).toEqual(Array.from({ length: 200 }, (_, i) => i * 2))
	})

	test("drops undefined and transfers Uint8Array results", async () => {
		const dec = new TextDecoder()
		const got = await collect(
			parallelMap<number, Uint8Array>(range(100), {
				worker: join(handlerDir, "evens-as-bytes.js"),
				concurrency: 4,
				batchSize: 8,
			})
		)

		const decoded = got.map((b) => Number(dec.decode(b))).sort((a, b) => a - b)
		expect(decoded).toEqual(Array.from({ length: 50 }, (_, i) => i * 2))
	})

	test("a throwing handler rejects the iterator", async () => {
		await expect(
			collect(parallelMap(range(50), { worker: join(handlerDir, "throws.js"), concurrency: 2 }))
		).rejects.toThrow(/boom/)
	})
})
