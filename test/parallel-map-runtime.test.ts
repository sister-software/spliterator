/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { runPool, type PoolWorker } from "spliterator/parallel-map-runtime"
import { describe, expect, test } from "vitest"

async function* range(n: number): AsyncIterableIterator<number> {
	for (let i = 0; i < n; i++) yield i
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = []

	for await (const v of source) out.push(v)

	return out
}

/** A fake worker that maps a batch via `fn`, optionally recording the max concurrent in-flight. */
function fakeWorker<T, R>(fn: (item: T) => R, track?: { active: number; max: number }): PoolWorker<T, R> {
	return {
		async process(batch) {
			if (track) {
				track.active++
				track.max = Math.max(track.max, track.active)
			}

			// A real (macrotask) delay so concurrent processing is observable, not collapsed into one
			// microtask flush.
			await new Promise<void>((resolve) => setTimeout(resolve, 5))
			const out = batch.map(fn)

			if (track) track.active--

			return out
		},
	}
}

describe("runPool", () => {
	test("maps every item across the pool (completion order ⇒ compare as a set)", async () => {
		const workers = Array.from({ length: 3 }, () => fakeWorker((x: number) => x * 2))
		const out = await collect(runPool(workers, range(10), 2))

		expect(out.sort((a, b) => a - b)).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18])
	})

	test("empty source completes with no results", async () => {
		const workers = [fakeWorker((x: number) => x)]

		expect(await collect(runPool(workers, range(0), 4))).toEqual([])
	})

	test("never runs more workers concurrently than the pool size", async () => {
		const track = { active: 0, max: 0 }
		const workers = Array.from({ length: 4 }, () => fakeWorker((x: number) => x, track))

		await collect(runPool(workers, range(50), 3))

		expect(track.max).toBeLessThanOrEqual(4)
		expect(track.max).toBeGreaterThan(1) // it actually parallelized
	})

	test("a worker error propagates and aborts", async () => {
		const workers: PoolWorker<number, number>[] = [
			{
				async process() {
					throw new Error("worker boom")
				},
			},
		]

		await expect(collect(runPool(workers, range(10), 2))).rejects.toThrow("worker boom")
	})
})
