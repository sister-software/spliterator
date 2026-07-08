/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 *
 *   Quote-aware splitting + CRLF normalization + chunk normalization.
 *
 *   These behaviors were redefined after the 2026-07-08 mailwoman readline migration audit found
 *   the original `enableQuoteHandling` implementation emitted quoted contents as separate slices
 *   (mis-parsing every real CSV), the async engine ignored the flag entirely, CRLF sources leaked
 *   `\r` into fields (readline's `crlfDelay` was transparent), and string-chunk streams silently
 *   produced garbage bytes.
 *
 *   Contract under test:
 *
 *   - `Spliterator`/`AsyncSpliterator` + `enableQuoteHandling`: delimiters inside double-quoted
 *       regions do not split; emitted slices keep their quotes verbatim.
 *   - `CSVSpliterator` + `enableQuoteHandling`: quote-aware rows AND columns, wrapping quotes
 *       stripped, doubled quotes unescaped, empty fields preserved.
 *   - `crlf`: a `\r` immediately preceding a delimiter is treated as part of the delimiter.
 *       Default `false` at the core, default `true` for `CSVSpliterator` rows (RFC 4180).
 *   - `AsyncSpliterator` accepts string chunks (UTF-8 encoded) instead of silently mis-reading.
 */

import { AsyncSpliterator, CSVSpliterator, JSONSpliterator, Spliterator, TextSpliterator } from "spliterator"
import { test } from "vitest"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Wrap byte chunks as a plain async iterable to exercise the chunk-iterator path. */
async function* chunksOf(...chunks: (Uint8Array | string)[]): AsyncGenerator<any> {
	for (const chunk of chunks) {
		yield chunk
	}
}

//#region Core quote-aware splitting

test("Spliterator: delimiters inside quotes do not split; quotes are kept", ({ expect }) => {
	const source = encoder.encode('"a,x",b')
	const slices = Array.from(new Spliterator(source, { delimiter: ",", enableQuoteHandling: true }), (bytes) =>
		decoder.decode(bytes)
	)

	expect(slices).toEqual(['"a,x"', "b"])
})

test("Spliterator: empty fields survive quote handling with skipEmpty false", ({ expect }) => {
	const source = encoder.encode('"a",,c,')
	const slices = Array.from(
		new Spliterator(source, { delimiter: ",", enableQuoteHandling: true, skipEmpty: false }),
		(bytes) => decoder.decode(bytes)
	)

	expect(slices).toEqual(['"a"', "", "c", ""])
})

test("Spliterator: unclosed quote consumes the tail as one slice", ({ expect }) => {
	const source = encoder.encode('a,"b,c')
	const slices = Array.from(new Spliterator(source, { delimiter: ",", enableQuoteHandling: true }), (bytes) =>
		decoder.decode(bytes)
	)

	expect(slices).toEqual(["a", '"b,c'])
})

test("AsyncSpliterator: quote state survives chunk boundaries", async ({ expect }) => {
	// The quoted field is split across three chunks, including a chunk boundary directly
	// inside the quotes and one between the closing quote and the delimiter.
	const spliterator = AsyncSpliterator.from(chunksOf('one,"tw', "o\nstill-two", '",three\nfour', "\n"), {
		delimiter: "\n",
		enableQuoteHandling: true,
	})

	const rows: string[] = []

	for await (const bytes of spliterator) {
		rows.push(decoder.decode(bytes))
	}

	expect(rows).toEqual(['one,"two\nstill-two",three', "four"])
})

//#endregion

//#region CSV quote handling

test("CSV: quoted embedded column delimiter", ({ expect }) => {
	const source = encoder.encode('h1,h2\n"a,x",b\n')
	const rows = Array.from(CSVSpliterator.from(source, { mode: "object", enableQuoteHandling: true }))

	expect(rows).toEqual([{ h1: "a,x", h2: "b" }])
})

test("CSV: quoted embedded newline stays in one row", ({ expect }) => {
	const source = encoder.encode('h1,h2\n"a\nx",b\n')
	const rows = Array.from(CSVSpliterator.from(source, { mode: "object", enableQuoteHandling: true }))

	expect(rows).toEqual([{ h1: "a\nx", h2: "b" }])
})

test("CSV: doubled quotes unescape", ({ expect }) => {
	const source = encoder.encode('h1,h2\n"a""b",c\n')
	const rows = Array.from(CSVSpliterator.from(source, { mode: "object", enableQuoteHandling: true }))

	expect(rows).toEqual([{ h1: 'a"b', h2: "c" }])
})

test("CSV: empty fields preserved under quote handling", ({ expect }) => {
	const source = encoder.encode('h1,h2,h3\n"a",,c\n')
	const rows = Array.from(CSVSpliterator.from(source, { mode: "object", enableQuoteHandling: true }))

	expect(rows).toEqual([{ h1: "a", h2: "", h3: "c" }])
})

test("CSV: quoted header columns", ({ expect }) => {
	const source = encoder.encode('"h,1",h2\na,b\n')
	const rows = Array.from(CSVSpliterator.from(source, { mode: "object", enableQuoteHandling: true }))

	expect(rows).toEqual([{ "h,1": "a", h2: "b" }])
})

test("Async CSV: quoted embedded delimiter and newline", async ({ expect }) => {
	const source = 'h1,h2\n"a,x",b\n"c\nd",e\n'
	const rows: unknown[] = []

	for await (const row of CSVSpliterator.fromAsync(chunksOf(encoder.encode(source)), {
		mode: "object",
		enableQuoteHandling: true,
	})) {
		rows.push(row)
	}

	expect(rows).toEqual([
		{ h1: "a,x", h2: "b" },
		{ h1: "c\nd", h2: "e" },
	])
})

test("CSV: sync take stops after the requested row count", ({ expect }) => {
	const source = encoder.encode("h\nr1\nr2\nr3\n")
	const rows = Array.from(CSVSpliterator.from(source, { mode: "array", take: 1 }))

	expect(rows).toEqual([["r1"]])
})

//#endregion

//#region CRLF normalization

test("Spliterator: crlf trims the carriage return before each delimiter", ({ expect }) => {
	const source = encoder.encode("a\r\nb\r\nc")
	const slices = Array.from(new Spliterator(source, { delimiter: "\n", crlf: true }), (bytes) => decoder.decode(bytes))

	expect(slices).toEqual(["a", "b", "c"])
})

test("Spliterator: crlf defaults off — carriage returns are preserved", ({ expect }) => {
	const source = encoder.encode("a\r\nb")
	const slices = Array.from(new Spliterator(source, { delimiter: "\n" }), (bytes) => decoder.decode(bytes))

	expect(slices).toEqual(["a\r", "b"])
})

test("TextSpliterator: crlf option flows through", ({ expect }) => {
	const lines = Array.from(TextSpliterator.from("a\r\nb\r\nc\r\n", { crlf: true }))

	expect(lines).toEqual(["a", "b", "c"])
})

test("Async: crlf trims across chunk boundaries", async ({ expect }) => {
	// The CRLF pair itself is split across chunks.
	const spliterator = AsyncSpliterator.from(chunksOf("a\r", "\nb\r\n"), { delimiter: "\n", crlf: true })
	const rows: string[] = []

	for await (const bytes of spliterator) {
		rows.push(decoder.decode(bytes))
	}

	expect(rows).toEqual(["a", "b"])
})

test("CSV: CRLF sources parse clean by default (RFC 4180)", ({ expect }) => {
	const source = encoder.encode("h1,h2\r\nv1,v2\r\n")
	const rows = Array.from(CSVSpliterator.from(source, { mode: "object" }))

	expect(rows).toEqual([{ h1: "v1", h2: "v2" }])
})

test("Async CSV: CRLF sources parse clean by default", async ({ expect }) => {
	const rows: unknown[] = []

	for await (const row of CSVSpliterator.fromAsync(chunksOf(encoder.encode("h1,h2\r\nv1,v2\r\n")), {
		mode: "object",
	})) {
		rows.push(row)
	}

	expect(rows).toEqual([{ h1: "v1", h2: "v2" }])
})

//#endregion

//#region Chunk + type normalization

test("AsyncSpliterator: string chunks are UTF-8 encoded, not silently mis-read", async ({ expect }) => {
	const spliterator = AsyncSpliterator.from(chunksOf("a\nb", "c\n"), { delimiter: "\n" })
	const rows: string[] = []

	for await (const bytes of spliterator) {
		rows.push(decoder.decode(bytes))
	}

	expect(rows).toEqual(["a", "bc"])
})

test("TextSpliterator.fromAsync accepts an async chunk iterator", async ({ expect }) => {
	// Regression: AsyncDataResource omitted AsyncChunkIterator from its union even though the
	// docstring listed it — stream call sites needed casts.
	const lines: string[] = []

	for await (const line of TextSpliterator.fromAsync(chunksOf("x\ny\n"))) {
		lines.push(line)
	}

	expect(lines).toEqual(["x", "y"])
})

test("JSONSpliterator.fromAsync accepts an async chunk iterator", async ({ expect }) => {
	const rows: unknown[] = []

	for await (const row of JSONSpliterator.fromAsync(chunksOf('{"a":1}\n{"a":2}\n'))) {
		rows.push(row)
	}

	expect(rows).toEqual([{ a: 1 }, { a: 2 }])
})

//#endregion
