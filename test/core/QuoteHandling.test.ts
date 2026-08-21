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

/**
 * Wrap byte chunks as a plain async iterable to exercise the chunk-iterator path.
 */
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

test("AsyncSpliterator: bounded native batches do not truncate dense delimiters", async ({ expect }) => {
	const delimiterCount = 10_000
	const source = encoder.encode("x\n".repeat(delimiterCount))

	const spliterator = AsyncSpliterator.from(chunksOf(source), {
		delimiter: "\n",
		skipEmpty: false,
	})

	let rows = 0

	for await (const bytes of spliterator) {
		expect(decoder.decode(bytes)).toBe(rows < delimiterCount ? "x" : "")

		rows++
	}

	expect(rows).toBe(delimiterCount + 1)
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

//#endregion

//#region Column-split fast path

/**
 * `splitRowColumns` decodes the row ONCE and splits the string, and takes `String.prototype.split` outright for a row
 * containing no `"` — skipping both the quote walk and the unquote pass. These pin the invariant that makes that legal:
 * the two paths must agree on every row where both could run.
 */

test("CSV fast path: a quote-free row splits identically with and without quote handling", ({ expect }) => {
	const source = encoder.encode("h1,h2,h3\na,b,c\n,,\nx,,z\n")

	const withQuotes = Array.from(CSVSpliterator.from(source, { mode: "array", enableQuoteHandling: true }))
	const withoutQuotes = Array.from(CSVSpliterator.from(source, { mode: "array", enableQuoteHandling: false }))

	expect(withQuotes).toEqual(withoutQuotes)

	expect(withQuotes).toEqual([
		["a", "b", "c"],
		["", "", ""],
		["x", "", "z"],
	])
})

test("CSV fast path: a quote in ANY column pushes the whole row onto the walk", ({ expect }) => {
	// The last column carries the quote; the earlier columns must still split exactly as they would have.
	const source = encoder.encode('h1,h2,h3\na,b,"c,d"\n')
	const rows = Array.from(CSVSpliterator.from(source, { mode: "array", enableQuoteHandling: true }))

	expect(rows).toEqual([["a", "b", "c,d"]])
})

test("CSV fast path: an unmatched quote opens a region that runs to EOF, as it did before", ({ expect }) => {
	// Malformed CSV — RFC 4180 gives no answer for a lone `"` mid-field, and the ROW splitter opens a quoted region on
	// it just as the column splitter does, so the row never terminates at the newline. Pinned not because the output is
	// desirable but because it is UNCHANGED: the decode-once column path must not quietly re-interpret malformed input.
	const source = encoder.encode('h1,h2\n5" pipe,b\n')
	const rows = Array.from(CSVSpliterator.from(source, { mode: "array", enableQuoteHandling: true }))

	expect(rows).toEqual([['5" pipe,b\n']])
})

test("CSV fast path: multi-character delimiters split on both paths", ({ expect }) => {
	const plain = encoder.encode("h1||h2||h3\na||b||c\n")
	const quoted = encoder.encode('h1||h2||h3\na||"b||x"||c\n')

	expect(
		Array.from(CSVSpliterator.from(plain, { mode: "array", columnDelimiter: "||", enableQuoteHandling: true }))
	).toEqual([["a", "b", "c"]])

	expect(
		Array.from(CSVSpliterator.from(quoted, { mode: "array", columnDelimiter: "||", enableQuoteHandling: true }))
	).toEqual([["a", "b||x", "c"]])
})

test("CSV fast path: a non-UTF-8 delimiter falls back to the byte scan", ({ expect }) => {
	// 0xFF is not valid UTF-8, so it cannot round-trip to a string — the string split would search for U+FFFD and
	// match the wrong thing. That delimiter must keep the byte path.
	const delimiter = new Uint8Array([0xff])

	const source = new Uint8Array([
		...encoder.encode("h1"),
		0xff,
		...encoder.encode("h2"),
		0x0a,
		...encoder.encode("a"),
		0xff,
		...encoder.encode("b"),
		0x0a,
	])

	const rows = Array.from(
		CSVSpliterator.from(source, { mode: "array", columnDelimiter: delimiter, enableQuoteHandling: true })
	)

	expect(rows).toEqual([["a", "b"]])
})

test("CSV fast path: multi-byte UTF-8 content is unharmed by decoding before splitting", ({ expect }) => {
	const source = encoder.encode('h1,h2,h3\nBesançon,"Saint-Étienne, Loire",Zürich\n')
	const rows = Array.from(CSVSpliterator.from(source, { mode: "array", enableQuoteHandling: true }))

	expect(rows).toEqual([["Besançon", "Saint-Étienne, Loire", "Zürich"]])
})

test("CSV: quoted header columns", ({ expect }) => {
	const source = encoder.encode('"h,1",h2\na,b\n')
	const rows = Array.from(CSVSpliterator.from(source, { mode: "object", enableQuoteHandling: true }))

	// Object mode normalizes keys by default, so the comma the quotes protected becomes an underscore.
	expect(rows).toEqual([{ h_1: "a", h2: "b" }])
})

test("CSV: quoted header columns keep their raw text under normalizeKeys: false", ({ expect }) => {
	const source = encoder.encode('"h,1",h2\na,b\n')

	const rows = Array.from(
		CSVSpliterator.from(source, { mode: "object", enableQuoteHandling: true, normalizeKeys: false })
	)

	expect(rows).toEqual([{ "h,1": "a", h2: "b" }])
})

test("CSV: from and fromAsync agree on default keys", async ({ expect }) => {
	const source = '"h,1",Some Name\na,b\n'
	const sync = Array.from(CSVSpliterator.from(encoder.encode(source), { mode: "object", enableQuoteHandling: true }))

	const asyncRows = await Array.fromAsync(
		CSVSpliterator.fromAsync(chunksOf(encoder.encode(source)), { mode: "object", enableQuoteHandling: true })
	)

	// The two entry points defaulted `normalizeKeys` differently until 4.0.1: the same options
	// object produced `row.some_name` from one and `row["Some Name"]` from the other.
	expect(sync).toEqual(asyncRows)
	expect(sync).toEqual([{ h_1: "a", some_name: "b" }])
})

test("CSV: an ALL CAPS header is not case-folded by normalizeKeys", ({ expect }) => {
	const source = encoder.encode("LON,LAT,STREET\n1,2,Main St\n")
	const rows = Array.from(CSVSpliterator.from(source, { mode: "object", normalizeKeys: true }))

	// `smartSnakeCase` treats existing all-caps as deliberate. OpenAddresses headers land here.
	expect(rows).toEqual([{ LON: "1", LAT: "2", STREET: "Main St" }])
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
