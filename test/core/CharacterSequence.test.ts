/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import {
	CharacterSequence,
	CSVSpliterator,
	Delimiters,
	normalizeCharacterInput,
	type CharacterSequenceInput,
} from "spliterator"
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
		const buf = encoder.encode("ab**cd,ef")

		// quote at 2, delimiter at 6

		expect(comma.searchMatches(buf, quote)).toEqual([
			{ offset: 2, patternId: 1 },
			{ offset: 6, patternId: 0 },
		])
	})

	test("a multi-byte delimiter swallowing a quote drops that quote", () => {
		const delimiter = new CharacterSequence(encoder.encode("<>"))
		const quote = encoder.encode(">")
		// The `>` at index 3 sits inside the delimiter's own span, so the cursor steps past it.
		const buf = encoder.encode("ab<>cd>ef")

		expect(delimiter.searchMatches(buf, quote)).toEqual([
			{ offset: 2, patternId: 0 },
			{ offset: 6, patternId: 1 },
		])
	})

	test("searches for an absent pattern once, not once per match", () => {
		// Each pattern's next hit is carried between iterations, and a `-1` is final for the rest of
		// the range. Re-searching both patterns every iteration was quadratic: a search that finds
		// nothing has scanned all the way to `end` to say so, so a source containing no quote paid
		// that whole scan once per delimiter.
		const comma = new CharacterSequence(Delimiters.Comma)
		const quote = new CharacterSequence('"')

		const searchCountFor = (fieldCount: number): number => {
			let calls = 0
			const realSearch = quote.search.bind(quote)

			quote.search = (...args: Parameters<typeof realSearch>) => {
				calls++

				return realSearch(...args)
			}

			try {
				expect(comma.searchMatches(encoder.encode("x,".repeat(fieldCount)), quote)).toHaveLength(fieldCount)
			} finally {
				Reflect.deleteProperty(quote, "search")
			}

			return calls
		}

		// The count must not grow with the delimiter count.
		expect(searchCountFor(100)).toBe(1)
		expect(searchCountFor(10_000)).toBe(1)
	})
})

describe("normalizeCharacterInput", () => {
	const source = "a,b\n1,2\n"

	test("accepts every declared input type", () => {
		const bytes = encoder.encode(source)

		const inputs: Record<string, CharacterSequenceInput> = {
			string: source,
			Uint8Array: bytes,
			Buffer: Buffer.from(source),
			ArrayBuffer: bytes.buffer.slice(0) as ArrayBuffer,
			DataView: new DataView(bytes.buffer.slice(0) as ArrayBuffer),
			numberArray: Array.from(bytes),
		}

		for (const [label, input] of Object.entries(inputs)) {
			expect(Array.from(CSVSpliterator.from(input, { header: false })), label).toEqual([
				["a", "b"],
				["1", "2"],
			])
		}
	})

	test("adopts a typed array by reference rather than copying it", () => {
		const bytes = encoder.encode(source)

		// A multi-megabyte haystack must not be copied on the way in.
		expect(normalizeCharacterInput(bytes)).toBe(bytes)
	})

	test("copies a plain number array instead of passing it off as a typed array", () => {
		const numbers = Array.from(encoder.encode(source))
		const normalized = normalizeCharacterInput(numbers)

		expect(normalized).toBeInstanceOf(Uint8Array)
		expect(Array.from(normalized)).toEqual(numbers)
	})

	test("views a DataView's bytes without copying past its window", () => {
		const backing = encoder.encode("XXa,b\n1,2\nXX")
		const view = new DataView(backing.buffer, 2, backing.length - 4)

		expect(Array.from(normalizeCharacterInput(view))).toEqual(Array.from(encoder.encode(source)))
	})
})
