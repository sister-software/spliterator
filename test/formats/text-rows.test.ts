/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

import { JSONSpliterator, TextSpliterator } from "spliterator"
import { describe, expect, test } from "vitest"

/**
 * `TextSpliterator.from` and `JSONSpliterator.from` split a string source as text; a byte source goes through the
 * engine. Every case here runs both and expects the same rows.
 */
const encoder = new TextEncoder()

const texts: Array<[string, string]> = [
	["plain", "one\ntwo\nthree\n"],
	["no trailing newline", "one\ntwo\nthree"],
	["blank rows", "one\n\n  \ntwo\n\n"],
	["crlf", "one\r\ntwo\r\nthree\r\n"],
	["lone cr at end of input", "one\ntwo\r"],
	["multi-byte", "é한😀 one\nzwei 한국어\n三\n"],
	["empty", ""],
	["only newlines", "\n\n\n"],
	["single row", "x"],
]

const inits: Array<[string, Parameters<typeof TextSpliterator.from>[1]]> = [
	["defaults", {}],
	["trim off, empties kept", { trim: false, skipEmpty: false }],
	["crlf", { trim: false, crlf: true }],
	["crlf, empties kept", { trim: false, crlf: true, skipEmpty: false }],
	["drop and take", { drop: 1, take: 2 }],
	["take zero", { take: 0 }],
	["multi-character delimiter", { delimiter: "e\n", trim: false }],
	["byte delimiter", { delimiter: encoder.encode("\n"), trim: false }],
]

describe("string sources split as text", () => {
	for (const [label, text] of texts) {
		for (const [initLabel, init] of inits) {
			test(`${label}, ${initLabel}`, () => {
				expect(TextSpliterator.from(text, init).toArray()).toEqual(
					TextSpliterator.from(encoder.encode(text), init).toArray()
				)
			})
		}
	}

	test("a byte position or quote handling takes the byte route", () => {
		const text = 'é,"a,b",c'

		expect(TextSpliterator.from(text, { delimiter: ",", position: 3, trim: false }).toArray()).toEqual(
			TextSpliterator.from(encoder.encode(text), { delimiter: ",", position: 3, trim: false }).toArray()
		)

		expect(TextSpliterator.from(text, { delimiter: ",", enableQuoteHandling: true }).toArray()).toEqual([
			"é",
			'"a,b"',
			"c",
		])
	})

	test("JSON rows, comments and errors match the byte route", () => {
		const text = '// header\n{"a":1}\n   \n{"b":"한"}\n'
		const init = { comment: "//" }

		expect(JSONSpliterator.from(text, init).toArray()).toEqual(
			JSONSpliterator.from(encoder.encode(text), init).toArray()
		)

		expect(JSONSpliterator.from(text, init).toArray()).toEqual([{ a: 1 }, { b: "한" }])
		expect(() => JSONSpliterator.from('{"a":1}\nnope\n').toArray()).toThrow("Failed to parse JSON at row 1")

		expect(() => JSONSpliterator.from(encoder.encode('{"a":1}\nnope\n')).toArray()).toThrow(
			"Failed to parse JSON at row 1"
		)
	})
})
