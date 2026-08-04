/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { isIndexedIterable, isIterable, iterateInParallel, sumOf } from "spliterator"
import { expect, test } from "vitest"

test("iterateInParallel: drains an async iterable to completion", async () => {
	let drained = 0

	async function* gen(): AsyncGenerator<number> {
		yield 1
		yield 2
		yield 3
	}

	async function* counting(): AsyncGenerator<number> {
		for await (const v of gen()) {
			drained++
			yield v
		}
	}

	await expect(iterateInParallel(counting())).resolves.toBeUndefined()
	expect(drained).toBe(3)
})

test("isIterable: recognizes arrays, strings, sets, and maps", () => {
	expect(isIterable([])).toBe(true)
	expect(isIterable("abc")).toBe(true)
	expect(isIterable(new Set())).toBe(true)
	expect(isIterable(new Map())).toBe(true)
})

test("isIterable: rejects plain objects, numbers, null, and undefined", () => {
	expect(isIterable({})).toBe(false)
	expect(isIterable(42)).toBe(false)
	expect(isIterable(null)).toBe(false)
	expect(isIterable(undefined)).toBe(false)
})

test("isIndexedIterable: true for collections exposing a has() method", () => {
	expect(isIndexedIterable(new Set([1, 2]))).toBe(true)
	expect(isIndexedIterable(new Map([["a", 1]]))).toBe(true)
})

test("isIndexedIterable: false for an array (no has())", () => {
	expect(isIndexedIterable([1, 2, 3])).toBe(false)
})

test("sumOf: totals the named numeric property across an iterable", () => {
	const items = [{ n: 1 }, { n: 2 }, { n: 3 }]

	expect(sumOf(items, "n")).toBe(6)
})

test("sumOf: an empty iterable sums to zero", () => {
	expect(sumOf([], "n" as never)).toBe(0)
})

test("sumOf: works over any iterable, not just arrays", () => {
	const set = new Set([{ weight: 10 }, { weight: 20 }, { weight: 5 }])

	expect(sumOf(set, "weight")).toBe(35)
})

test("sumOf: handles negative and fractional values", () => {
	const items = [{ v: 1.5 }, { v: -0.5 }, { v: 2 }]

	expect(sumOf(items, "v")).toBe(3)
})
