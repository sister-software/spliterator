/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { mergeAsyncIterators } from "spliterator/segment-workers"
import { describe, expect, test } from "vitest"

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** An async iterable that yields each `[value, delayMs]` after its delay. */
async function* delayed<T>(items: Array<[T, number]>): AsyncIterableIterator<T> {
	for (const [value, ms] of items) {
		await sleep(ms)
		yield value
	}
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = []

	for await (const v of source) out.push(v)

	return out
}

describe("mergeAsyncIterators", () => {
	test("yields across iterators concurrently, in completion order", async () => {
		// A's only item lands at 60ms, B's at 15ms. A *sequential* drain (A then B) would yield
		// ["a", "b"]; a concurrent drain yields the earlier-completing value first.
		const got = await collect(mergeAsyncIterators([delayed([["a", 60]]), delayed([["b", 15]])]))

		expect(got).toEqual(["b", "a"])
	})

	test("drains every value from every iterator", async () => {
		const got = await collect(
			mergeAsyncIterators([
				delayed([
					["a1", 5],
					["a2", 5],
				]),
				delayed([
					["b1", 5],
					["b2", 5],
				]),
			])
		)

		expect(got.sort()).toEqual(["a1", "a2", "b1", "b2"])
	})

	test("propagates an error from any iterator", async () => {
		async function* boom(): AsyncIterableIterator<string> {
			yield "x"
			throw new Error("boom")
		}

		await expect(collect(mergeAsyncIterators([boom()]))).rejects.toThrow("boom")
	})

	test("empty input completes immediately", async () => {
		expect(await collect(mergeAsyncIterators<string>([]))).toEqual([])
	})
})
