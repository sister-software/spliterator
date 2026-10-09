/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

import { CSVSpliterator } from "spliterator"
import { describe, expect, test } from "vitest"

/**
 * The object and entries emitters switch from an indexed loop to a compiled literal after 32 rows of the same header,
 * so every expectation here is checked on a row before the switch and a row after it.
 */
const EARLY = 3
const LATE = 81

function csv(header: string, rowOf: (i: number) => string, rows = 100): string {
	return [header, ...Array.from({ length: rows }, (_, i) => rowOf(i))].join("\n") + "\n"
}

describe("row emitters", () => {
	test("object rows match the header on both sides of the compile threshold", () => {
		const rows = CSVSpliterator.from(
			csv("id,name,score", (i) => `${i},n${i},${i * 2}`),
			{
				mode: "object",
				normalizeKeys: false,
				trim: false,
			}
		).toArray()

		expect(rows).toHaveLength(100)

		for (const i of [EARLY, LATE]) {
			expect(rows[i]).toEqual({ id: `${i}`, name: `n${i}`, score: `${i * 2}` })
			expect(Object.keys(rows[i]!)).toEqual(["id", "name", "score"])
		}
	})

	test("short rows fill with the missing value and long rows append unnamed columns", () => {
		const rows = CSVSpliterator.from(
			csv("a,b,c", (i) => (i % 2 ? `${i},x` : `${i},x,y,extra${i},more`)),
			{ mode: "object", normalizeKeys: false, trim: false }
		).toArray()

		// Odd rows are short, even rows are long.
		for (const i of [EARLY, LATE]) {
			expect(rows[i]).toEqual({ a: `${i}`, b: "x", c: "" })
		}

		for (const i of [EARLY - 1, LATE - 1]) {
			expect(rows[i]).toEqual({ a: `${i}`, b: "x", c: "y", column_3: `extra${i}`, column_4: "more" })
		}
	})

	test("transformers run through the compiled builder too", () => {
		const rows = CSVSpliterator.from(
			csv("id,score", (i) => `${i},${i}.5`),
			{
				mode: "object",
				normalizeKeys: false,
				transformers: { score: Number },
			}
		).toArray()

		expect(rows[EARLY]).toEqual({ id: `${EARLY}`, score: EARLY + 0.5 })
		expect(rows[LATE]).toEqual({ id: `${LATE}`, score: LATE + 0.5 })
	})

	test("awkward header names are plain own properties, except __proto__ which stays a setter", () => {
		const header = `"it's",a b,"quo""te",__proto__,constructor,"\\n"`

		const rows = CSVSpliterator.from(
			csv(header, (i) => `${i},${i},${i},${i},${i},${i}`),
			{
				mode: "object",
				normalizeKeys: false,
				trim: false,
			}
		).toArray()

		for (const i of [EARLY, LATE]) {
			const row = rows[i]!

			expect(Object.keys(row)).toEqual(["it's", "a b", 'quo"te', "constructor", "\\n"])
			expect(row['quo"te']).toBe(`${i}`)
			expect(row.constructor).toBe(`${i}`)
			// A string assigned to __proto__ is ignored by the setter on both paths.
			expect(Object.getPrototypeOf(row)).toBe(Object.prototype)
		}
	})

	test("duplicate header names: the last column wins on both paths", () => {
		const rows = CSVSpliterator.from(
			csv("k,k", (i) => `first${i},second${i}`),
			{
				mode: "object",
				normalizeKeys: false,
				trim: false,
			}
		).toArray()

		expect(rows[EARLY]).toEqual({ k: `second${EARLY}` })
		expect(rows[LATE]).toEqual({ k: `second${LATE}` })
	})

	test("entries rows carry key, value and index on both sides of the threshold", () => {
		const rows = CSVSpliterator.from(
			csv("a,b", (i) => (i % 2 ? `${i}` : `${i},x,y`)),
			{
				mode: "entries",
				normalizeKeys: false,
				trim: false,
			}
		).toArray()

		for (const i of [EARLY, LATE]) {
			expect(rows[i]).toEqual([
				["a", `${i}`, 0],
				["b", "", 1],
			])
		}

		for (const i of [EARLY - 1, LATE - 1]) {
			expect(rows[i]).toEqual([
				["a", `${i}`, 0],
				["b", "x", 1],
				["column_2", "y", 2],
			])
		}
	})

	test("object mode without a header names every column", () => {
		const rows = CSVSpliterator.from(
			csv("x,y", (i) => `${i},${i}`),
			{ mode: "object", header: false }
		).toArray()

		expect(rows[0]).toEqual({ column_0: "x", column_1: "y" })
		expect(rows[LATE]).toEqual({ column_0: `${LATE - 1}`, column_1: `${LATE - 1}` })
	})
})
