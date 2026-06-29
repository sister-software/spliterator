/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 *
 * Tests that force the WASM SIMD path (haystacks >= WASM_THRESHOLD) to guard the
 * native scanner against regressions: alignment, the shared-memory cache, and
 * silent result truncation. The JS fallback is exercised by the other suites.
 */

import { CharacterSequence, CSVSpliterator, Delimiters } from "spliterator"
import { beforeAll, describe, expect, test } from "vitest"

const encoder = new TextEncoder()

describe("WASM SIMD scanner", () => {
	beforeAll(async () => {
		// The module loads asynchronously; without awaiting it the synchronous
		// engine would never see it and every test below would silently run on
		// the JS fallback, defeating the purpose of the suite.
		const ready = await CharacterSequence.whenReady()
		expect(ready, "WASM SIMD scanner must be available in this environment").toBe(true)
	})

	test("whenReady() resolves true once the SIMD scanner is loaded", async () => {
		expect(await CharacterSequence.whenReady()).toBe(true)
	})

	/** Independent oracle mirroring searchAll's JS semantics (incl. trailing empty field). */
	function referenceRanges(buf: Uint8Array, delim: Uint8Array): Array<[number, number]> {
		const ranges: Array<[number, number]> = []
		let start = 0
		let i = 0

		while (i <= buf.length - delim.length) {
			let match = true

			for (let j = 0; j < delim.length; j++) {
				if (buf[i + j] !== delim[j]) {
					match = false
					break
				}
			}

			if (match) {
				ranges.push([start, i])
				i += delim.length
				start = i
			} else {
				i++
			}
		}

		if (start <= buf.length) ranges.push([start, buf.length])

		return ranges
	}

	/** Build a >= threshold haystack of exactly `length` bytes with commas at `positions`. */
	function commaHaystack(length: number, positions: number[]): Uint8Array {
		const buf = new Uint8Array(length).fill(Delimiters.Zero)

		for (const p of positions) buf[p] = Delimiters.Comma

		return buf
	}

	// The WASM results buffer is an Int32Array whose byte offset must be a multiple of 4.
	// That offset is derived from the haystack length, so unaligned lengths used to throw
	// "start offset of Int32Array should be a multiple of 4" for ~3 of every 4 inputs.
	for (const length of [4096, 4097, 4098, 4099]) {
		test(`searchAll matches the oracle for an unaligned ${length}-byte haystack`, () => {
			const comma = new CharacterSequence(Delimiters.Comma)
			const buf = commaHaystack(length, [10, 2000, length - 5])

			expect(buf.length).toBeGreaterThanOrEqual(4096)
			expect(comma.searchAll(buf)).toEqual(referenceRanges(buf, comma))
		})
	}

	/** Oracle for searchMatches: each delimiter/quote byte, in order, with its pattern id. */
	function referenceMatches(
		buf: Uint8Array,
		delim: number,
		quote: number
	): Array<{ offset: number; patternId: number }> {
		const matches: Array<{ offset: number; patternId: number }> = []

		for (let i = 0; i < buf.length; i++) {
			if (buf[i] === delim) matches.push({ offset: i, patternId: 0 })
			else if (buf[i] === quote) matches.push({ offset: i, patternId: 1 })
		}

		return matches
	}

	// searchMatches builds the same Int32Array results view, offset by haystackLen + both
	// pattern lengths — also unaligned for most inputs.
	for (const length of [4096, 4097, 4098, 4099]) {
		test(`searchMatches matches the oracle for an unaligned ${length}-byte haystack`, () => {
			const comma = new CharacterSequence(Delimiters.Comma)
			const quote = new CharacterSequence(Delimiters.DoubleQuote)
			const buf = new Uint8Array(length).fill(Delimiters.Zero)
			buf[10] = Delimiters.Comma
			buf[11] = Delimiters.DoubleQuote
			buf[2000] = Delimiters.DoubleQuote
			buf[length - 5] = Delimiters.Comma

			expect(comma.searchMatches(buf, quote)).toEqual(referenceMatches(buf, Delimiters.Comma, Delimiters.DoubleQuote))
		})
	}

	/** Build a >= threshold haystack of `length` bytes with a CRLF at each given start. */
	function crlfHaystack(length: number, crlfStarts: number[]): Uint8Array {
		const buf = new Uint8Array(length).fill(Delimiters.Zero)

		for (const p of crlfStarts) {
			buf[p] = Delimiters.CarriageReturn
			buf[p + 1] = Delimiters.LineFeed
		}

		return buf
	}

	test("search honours a non-zero start on a fresh >= threshold haystack", () => {
		const crlf = new CharacterSequence(encoder.encode("\r\n"))
		// Fresh identity => cache miss => the "first call" copy path, which previously
		// mis-mapped offsets whenever the first call's start was non-zero.
		const buf = crlfHaystack(5000, [100, 3000])

		expect(crlf.search(buf, 200)).toBe(3000)
		expect(crlf.search(buf, 0)).toBe(100)
	})

	test("search is not corrupted by an interleaved searchAll on another haystack", () => {
		const crlf = new CharacterSequence(encoder.encode("\r\n"))
		const comma = new CharacterSequence(Delimiters.Comma)
		const rows = crlfHaystack(5000, [100, 3000])
		const columns = commaHaystack(5000, [10, 2000])

		// Prime the cache for `rows`...
		expect(crlf.search(rows, 0)).toBe(100)
		// ...then clobber the shared WASM memory with an unrelated searchAll...
		comma.searchAll(columns)
		// ...the next search on `rows` must still read its own bytes, not the leftovers.
		expect(crlf.search(rows, 102)).toBe(3000)
	})

	test("CRLF-delimited CSV with wide rows parses identically to String.split", () => {
		// Each row must exceed the threshold so column splitting also takes the WASM
		// path, exercising the row-search cache against the column searchAll on the
		// same shared memory — the exact interleave that corrupted row boundaries.
		const rowCount = 20
		const lines: string[] = []

		for (let r = 0; r < rowCount; r++) {
			const cells: string[] = []

			for (let c = 0; c < 800; c++) cells.push(`r${r}c${c}`)
			lines.push(cells.join(","))
		}

		const text = lines.join("\r\n") + "\r\n"
		const buf = encoder.encode(text)
		expect(buf.byteLength).toBeGreaterThan(4096)

		const expected = lines.map((line) => line.split(","))
		const actual = [...CSVSpliterator.from(buf, { delimiter: encoder.encode("\r\n"), header: false })]

		expect(actual).toEqual(expected)
	})

	// The WASM scanners stop at WASM_MAX_RESULTS (4096) matches. Returning a truncated
	// result would silently drop data, so a full buffer must fall back to the uncapped scan.
	test("searchAll does not truncate beyond WASM_MAX_RESULTS matches", () => {
		const comma = new CharacterSequence(Delimiters.Comma)
		const buf = new Uint8Array(5000).fill(Delimiters.Comma) // 5000 delimiters > 4096 cap

		const ranges = comma.searchAll(buf)

		expect(ranges).toEqual(referenceRanges(buf, comma))
		expect(ranges.length).toBeGreaterThan(4096)
	})

	test("searchMatches does not truncate beyond WASM_MAX_RESULTS matches", () => {
		const comma = new CharacterSequence(Delimiters.Comma)
		const quote = new CharacterSequence(Delimiters.DoubleQuote)
		const buf = new Uint8Array(5000).fill(Delimiters.Comma) // 5000 matches > 4096 cap

		const matches = comma.searchMatches(buf, quote)

		expect(matches).toEqual(referenceMatches(buf, Delimiters.Comma, Delimiters.DoubleQuote))
		expect(matches.length).toBeGreaterThan(4096)
	})

	// A haystack ending exactly on a delimiter has a trailing empty field. The JS scan emits
	// it (matching String.split); the WASM kernel must too, or the last column silently
	// disappears for wide rows ending in a separator.
	test("searchAll emits the trailing empty field when the haystack ends on a delimiter", () => {
		const comma = new CharacterSequence(Delimiters.Comma)
		const buf = commaHaystack(4100, [10, 2000, 4099]) // final byte is the delimiter

		expect(buf[buf.length - 1]).toBe(Delimiters.Comma)

		const ranges = comma.searchAll(buf)

		expect(ranges).toEqual(referenceRanges(buf, comma))
		expect(ranges[ranges.length - 1]).toEqual([4100, 4100])
	})
})
