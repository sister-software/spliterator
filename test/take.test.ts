/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { take, takeAsync } from "spliterator"
import { expect, test } from "vitest"

/**
 * `take` yields a single reused buffer (it mutates `batch.length = 0` between yields), so it must be consumed one batch
 * at a time. Snapshot each batch as it arrives — exactly how a batched async loop uses it — rather than retaining
 * references via a spread.
 */
function drainTake<T>(collection: Iterable<T>, batchSize: number): T[][] {
	const out: T[][] = []

	for (const batch of take(collection, batchSize)) {
		out.push([...batch])
	}

	return out
}

test("take: batches an iterable into arrays of the given size", () => {
	expect(drainTake([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
})

test("take: a final short batch is still yielded", () => {
	expect(drainTake([1, 2, 3], 2)).toEqual([[1, 2], [3]])
})

test("take: an evenly-divisible iterable yields no trailing partial batch", () => {
	expect(drainTake([1, 2, 3, 4], 2)).toEqual([
		[1, 2],
		[3, 4],
	])
})

test("take: an empty iterable yields nothing", () => {
	expect(drainTake([], 3)).toEqual([])
})

test("take: a batch size larger than the collection yields a single batch", () => {
	expect(drainTake([1, 2], 10)).toEqual([[1, 2]])
})

test("take: yields one batch per consumed step (lazy streaming contract)", () => {
	const iterator = take([1, 2, 3], 2)[Symbol.iterator]()

	const first = iterator.next()
	expect(first.done).toBe(false)
	expect([...first.value!]).toEqual([1, 2])

	const second = iterator.next()
	expect(second.done).toBe(false)
	expect([...second.value!]).toEqual([3])

	expect(iterator.next().done).toBe(true)
})

test("takeAsync: batches an async iterable into arrays of the given size", async () => {
	async function* asyncGen() {
		yield 1
		yield 2
		yield 3
		yield 4
		yield 5
	}

	const out: number[][] = []

	for await (const batch of takeAsync(asyncGen(), 2)) {
		out.push([...batch])
	}

	expect(out).toEqual([[1, 2], [3, 4], [5]])
})

test("takeAsync: yields one batch per consumed step (lazy streaming contract)", async () => {
	async function* asyncGen() {
		yield 1
		yield 2
		yield 3
	}

	const iterator = takeAsync(asyncGen(), 2)[Symbol.asyncIterator]()

	const first = await iterator.next()
	expect(first.done).toBe(false)
	expect([...first.value!]).toEqual([1, 2])

	const second = await iterator.next()
	expect(second.done).toBe(false)
	expect([...second.value!]).toEqual([3])

	expect((await iterator.next()).done).toBe(true)
})

test("takeAsync: an empty async iterable yields nothing", async () => {
	async function* asyncGen() {
		/* empty */
	}

	const out: number[][] = []

	for await (const batch of takeAsync(asyncGen(), 3)) {
		out.push([...batch])
	}

	expect(out).toEqual([])
})
