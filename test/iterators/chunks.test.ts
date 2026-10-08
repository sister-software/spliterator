/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { chunks } from "spliterator"
import { expect, test } from "vitest"

test("chunks: batches an iterable into arrays of the given size", () => {
	expect(Array.from(chunks([1, 2, 3, 4, 5], 2))).toEqual([[1, 2], [3, 4], [5]])
})

test("chunks: a final short batch is still yielded", () => {
	expect(Array.from(chunks([1, 2, 3], 2))).toEqual([[1, 2], [3]])
})

test("chunks: an evenly-divisible iterable yields no trailing partial batch", () => {
	expect(Array.from(chunks([1, 2, 3, 4], 2))).toEqual([
		[1, 2],
		[3, 4],
	])
})

test("chunks: an empty iterable yields nothing", () => {
	expect(Array.from(chunks([], 3))).toEqual([])
})

test("chunks: a batch size larger than the collection yields a single batch", () => {
	expect(Array.from(chunks([1, 2], 10))).toEqual([[1, 2]])
})

test("chunks: each batch is a distinct array", () => {
	const [first, second] = Array.from(chunks([1, 2, 3, 4], 2))

	expect(first).not.toBe(second)
	expect(first).toEqual([1, 2])
	expect(second).toEqual([3, 4])
})

test("chunks: yields one batch per consumed step (lazy streaming contract)", () => {
	const iterator = chunks([1, 2, 3], 2)[Symbol.iterator]()

	expect(iterator.next()).toEqual({ value: [1, 2], done: false })
	expect(iterator.next()).toEqual({ value: [3], done: false })
	expect(iterator.next().done).toBe(true)
})

test.each([0, -1, Number.POSITIVE_INFINITY, Number.NaN])("chunks: rejects a size of %s", (size) => {
	expect(() => Array.from(chunks([1, 2], size))).toThrow(RangeError)
})
