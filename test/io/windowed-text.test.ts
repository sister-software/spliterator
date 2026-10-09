/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

import { JSONSpliterator, TextSpliterator } from "spliterator"
import { describe, expect, test } from "vitest"

/**
 * The streamed branch of `TextSpliterator.fromAsync` and `JSONSpliterator.fromAsync` decodes per engine window and
 * splits the text; the sync `from` decodes per row. Every case here runs the streamed branch at a tiny high-water mark,
 * so a row straddles windows, and checks it against the sync result.
 */
const STREAM = { bulkThreshold: 0, highWaterMark: 48 } as const

function source(text: string) {
	const bytes = new TextEncoder().encode(text)

	return {
		async *[Symbol.asyncIterator]() {
			// Chunks of 7 bytes, so multi-byte characters and delimiters straddle chunk edges too.
			for (let offset = 0; offset < bytes.length; offset += 7) {
				yield bytes.subarray(offset, offset + 7)
			}
		},
	}
}

const texts: Array<[string, string]> = [
	["plain", "one\ntwo\nthree\n"],
	["no trailing newline", "one\ntwo\nthree"],
	["blank rows", "one\n\n  \ntwo\n\n"],
	["crlf", "one\r\ntwo\r\nthree\r\n"],
	["lone cr at end of input", "one\ntwo\r"],
	["utf-8 across windows", "é한😀 one\nzwei 한국어 긴 줄입니다 정말로\n三\n"],
	["long rows past the window", `${"x".repeat(200)}\n${"y".repeat(100)}\nz\n`],
	["empty", ""],
	["only newlines", "\n\n\n"],
]

describe("windowed text rows", () => {
	for (const [label, text] of texts) {
		test(`${label}: streamed matches sync`, async () => {
			expect(await TextSpliterator.fromAsync(source(text), STREAM).toArray()).toEqual(
				TextSpliterator.from(text).toArray()
			)
		})

		test(`${label}: streamed matches sync with trim off and empties kept`, async () => {
			const init = { trim: false, skipEmpty: false }

			expect(await TextSpliterator.fromAsync(source(text), { ...STREAM, ...init }).toArray()).toEqual(
				TextSpliterator.from(text, init).toArray()
			)
		})

		test(`${label}: streamed matches sync with crlf`, async () => {
			const init = { trim: false, crlf: true }

			expect(await TextSpliterator.fromAsync(source(text), { ...STREAM, ...init }).toArray()).toEqual(
				TextSpliterator.from(text, init).toArray()
			)
		})
	}

	test("a multi-character delimiter", async () => {
		const text = "a<>b<>c<>"
		const init = { delimiter: "<>", trim: false }

		expect(await TextSpliterator.fromAsync(source(text), { ...STREAM, ...init }).toArray()).toEqual(["a", "b", "c"])
		expect(await TextSpliterator.fromAsync(source(text), { ...STREAM, ...init }).toArray()).toEqual(
			TextSpliterator.from(text, init).toArray()
		)
	})

	test("drop and take count rows after empties are skipped, as the engine's did", async () => {
		const text = "a\n\nb\n\nc\nd\ne\n"
		const init = { drop: 1, take: 2 }

		expect(await TextSpliterator.fromAsync(source(text), { ...STREAM, ...init }).toArray()).toEqual(["b", "c"])
		expect(await TextSpliterator.fromAsync(source(text), { ...STREAM, ...init }).toArray()).toEqual(
			TextSpliterator.from(text, init).toArray()
		)
	})

	test("take closes the source", async () => {
		let closed = false
		const bytes = new TextEncoder().encode("a\nb\nc\nd\n")

		const chunks = {
			async *[Symbol.asyncIterator]() {
				try {
					for (let offset = 0; offset < bytes.length; offset += 2) {
						yield bytes.subarray(offset, offset + 2)
					}
				} finally {
					closed = true
				}
			},
		}

		expect(await TextSpliterator.fromAsync(chunks, { ...STREAM, take: 1 }).toArray()).toEqual(["a"])
		expect(closed).toBe(true)
	})

	test("a fatal decoder names the bad row", async () => {
		const bytes = new Uint8Array([...new TextEncoder().encode("ok\nfine\n"), 0xff, 0xfe, 0x0a, 0x7a, 0x0a])

		const chunks = {
			async *[Symbol.asyncIterator]() {
				yield bytes
			},
		}

		await expect(TextSpliterator.fromAsync(chunks, { ...STREAM, fatal: true }).toArray()).rejects.toThrow(
			"Failed to decode data at row 2"
		)
	})

	test("a lossy decoder replaces and continues", async () => {
		const bytes = new Uint8Array([...new TextEncoder().encode("ok\n"), 0xff, 0x0a, 0x7a, 0x0a])

		const chunks = {
			async *[Symbol.asyncIterator]() {
				yield bytes
			},
		}

		expect(await TextSpliterator.fromAsync(chunks, STREAM).toArray()).toEqual(["ok", "�", "z"])
	})
})

describe("windowed JSON rows", () => {
	test("streamed matches sync", async () => {
		const text = '{"a":1}\n{"b":"한국어"}\n\n{"c":[1,2,3]}\n'

		expect(await JSONSpliterator.fromAsync(source(text), STREAM).toArray()).toEqual(
			JSONSpliterator.from(text).toArray()
		)
	})

	test("comment rows and blank rows are skipped on the text path", async () => {
		const text = '// header\n{"a":1}\n   \n  # note\n{"b":2}\n'
		const init = { comment: ["//", "#"] }

		expect(await JSONSpliterator.fromAsync(source(text), { ...STREAM, ...init }).toArray()).toEqual([
			{ a: 1 },
			{ b: 2 },
		])
		expect(await JSONSpliterator.fromAsync(source(text), { ...STREAM, ...init }).toArray()).toEqual(
			JSONSpliterator.from(text, init).toArray()
		)
	})

	test("a bad row names its index", async () => {
		const text = '{"a":1}\n{"b":2}\nnot json\n'

		await expect(JSONSpliterator.fromAsync(source(text), STREAM).toArray()).rejects.toThrow(
			"Failed to parse JSON at row 2"
		)
	})

	test("drop and take", async () => {
		const text = "1\n2\n3\n4\n5\n"

		expect(await JSONSpliterator.fromAsync(source(text), { ...STREAM, drop: 1, take: 3 }).toArray()).toEqual([2, 3, 4])
	})
})
