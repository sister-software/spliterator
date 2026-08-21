/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { pivot } from "spliterator"
import { expect, test } from "vitest"

test("pivot: maps each value to the synchronous callback result", () => {
	const result = pivot(["a", "bb", "ccc"], (value) => value.length)

	expect(result).toEqual({ a: 1, bb: 2, ccc: 3 })
})

test("pivot: an empty iterable pivots to an empty record", () => {
	expect(pivot([], (v) => v)).toEqual({})
})

test("pivot: resolves a record of awaited values when the callback is async", async () => {
	const result = pivot(["x", "y"], async (value) => value.toUpperCase())

	await expect(result).resolves.toEqual({ x: "X", y: "Y" })
})

test("pivot: later keys overwrite earlier duplicates", () => {
	const result = pivot(["dup", "dup"], (value) => value.length)

	expect(result).toEqual({ dup: 3 })
})
