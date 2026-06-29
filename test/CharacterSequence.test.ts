/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { CharacterSequence, Delimiters } from "spliterator"
import { describe, expect, test } from "vitest"

const encoder = new TextEncoder()

describe("CharacterSequence.search (single-byte)", () => {
	const comma = () => new CharacterSequence(Delimiters.Comma)

	test("finds the first occurrence from the start", () => {
		expect(comma().search(encoder.encode("ab,cd,ef"))).toBe(2)
	})

	test("honours a non-zero start offset", () => {
		expect(comma().search(encoder.encode("ab,cd,ef"), 3)).toBe(5)
	})

	test("treats end as exclusive", () => {
		const buf = encoder.encode("ab,cd") // delimiter at index 2

		expect(comma().search(buf, 0, 2)).toBe(-1) // index 2 is excluded
		expect(comma().search(buf, 0, 3)).toBe(2)
	})

	test("returns -1 when the delimiter is absent", () => {
		expect(comma().search(encoder.encode("abcdef"))).toBe(-1)
	})

	test("matches a delimiter at the final in-range byte", () => {
		expect(comma().search(encoder.encode("abc,"))).toBe(3)
	})
})

describe("CharacterSequence.searchMatches (JS fallback)", () => {
	test("finds multi-byte quote patterns, not just single-byte ones", () => {
		const comma = new CharacterSequence(Delimiters.Comma)
		const quote = encoder.encode("**") // two-byte quote
		const buf = encoder.encode("ab**cd,ef") // quote at 2, delimiter at 6

		expect(comma.searchMatches(buf, quote)).toEqual([
			{ offset: 2, patternId: 1 },
			{ offset: 6, patternId: 0 },
		])
	})
})
