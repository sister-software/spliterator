/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

import { AsyncSpliterator } from "spliterator"
import { describe, expect, test } from "vitest"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

async function* chunks(...parts: string[]) {
	for (const part of parts) {
		yield encoder.encode(part)
	}
}

async function windows(
	source: AsyncIterable<Uint8Array>,
	init: ConstructorParameters<typeof AsyncSpliterator>[1] = {}
) {
	const engine = AsyncSpliterator.from(source, { delimiter: "\n", ...init })
	const out: string[] = []

	for (;;) {
		const result = await engine.nextWindow()

		if (result.done) break

		out.push(decoder.decode(result.value))
	}

	return out
}

describe("AsyncSpliterator.nextWindow", () => {
	// Every window boundary sits on a record delimiter, so joining the windows with it reproduces the source. A source
	// that ends on a delimiter yields a final empty window: the tail `next` would have handed out as an empty record.
	test("windows joined by the delimiter reproduce the source, trailing empty window included", async () => {
		const out = await windows(chunks("a,b\nc,d\ne,f\n"))

		expect(out.join("\n")).toBe("a,b\nc,d\ne,f\n")
		expect(out.at(-1)).toBe("")
	})

	test("a window never ends in the carriage return of a CRLF; interior ones stay for the consumer", async () => {
		const out = await windows(chunks("a\r\nb\r\nc\r\n"), { crlf: true })

		expect(out.join("\r\n")).toBe("a\r\nb\r\nc\r\n")
		expect(out.some((window) => window.endsWith("\r"))).toBe(false)
	})

	test("a tail without a trailing delimiter is the end of the last window", async () => {
		const out = await windows(chunks("a\nb\nc"))

		expect(out.join("\n")).toBe("a\nb\nc")
		expect(out.at(-1)!.endsWith("c")).toBe(true)
	})

	test("empty records stay in the window even with skipEmpty, for the consumer to drop", async () => {
		const out = await windows(chunks("a\n\n\nb\n"), { skipEmpty: true })

		expect(out.join("\n")).toBe("a\n\n\nb\n")
	})

	test("a quoted region never straddles two windows", async () => {
		const quoted = `"x\ny\nz"`
		const out = await windows(chunks("a\n", quoted, "\nb\n"), { enableQuoteHandling: true, highWaterMark: 4 })

		expect(out.join("\n")).toBe(`a\n${quoted}\nb\n`)
		expect(out.some((window) => window.includes(quoted))).toBe(true)
	})

	test("many small windows over a chunked source reproduce it exactly", async () => {
		const text = Array.from({ length: 500 }, (_, i) => `row ${i},${"v".repeat(i % 7)}`).join("\n") + "\n"
		const parts = text.match(/[\s\S]{1,37}/g)!
		const out = await windows(chunks(...parts), { highWaterMark: 256 })

		expect(out.length).toBeGreaterThan(5)
		expect(out.join("\n")).toBe(text)
	})

	test("after the last window it reports done, and keeps doing so", async () => {
		const engine = AsyncSpliterator.from(chunks("a\nb"), { delimiter: "\n" })

		while (!(await engine.nextWindow()).done) {
			// drain
		}

		expect((await engine.nextWindow()).done).toBe(true)
		expect((await engine.nextWindow()).done).toBe(true)
	})
})
