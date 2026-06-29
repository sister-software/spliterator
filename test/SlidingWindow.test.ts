/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { SlidingWindow } from "spliterator"
import { describe, expect, test } from "vitest"

const encoder = new TextEncoder()

/** Decode the ranges a SlidingWindow yields back into strings for easy comparison. */
function windowed(input: string, delimiter?: string): string[] {
	const buffer = encoder.encode(input)
	const decoder = new TextDecoder()
	const window = new SlidingWindow(buffer, delimiter ? { delimiter: encoder.encode(delimiter) } : {})

	return Array.from(window, ([start, end]) => decoder.decode(buffer.subarray(start, end)))
}

describe("SlidingWindow", () => {
	test("splits on a single-byte delimiter, keeping the trailing field", () => {
		expect(windowed("a,b,c", ",")).toEqual(["a", "b", "c"])
	})

	test("preserves empty fields between adjacent delimiters", () => {
		expect(windowed("a,,c", ",")).toEqual(["a", "", "c"])
	})

	test("emits a trailing empty field when input ends on a delimiter", () => {
		expect(windowed("a,b,", ",")).toEqual(["a", "b", ""])
	})

	test("splits on a multi-byte delimiter", () => {
		expect(windowed("aa\r\nbb\r\ncc", "\r\n")).toEqual(["aa", "bb", "cc"])
	})

	test("yields the whole buffer when no delimiter is present", () => {
		expect(windowed("abc", ",")).toEqual(["abc"])
	})

	test("matches String.split across a larger buffer", () => {
		const text = Array.from({ length: 500 }, (_, i) => `row${i}`).join("\n")

		expect(windowed(text, "\n")).toEqual(text.split("\n"))
	})
})
