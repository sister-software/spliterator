/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import {
	type AsyncSequence,
	CharacterSequence,
	CSVSpliterator,
	Delimiters,
	normalizeColumnNames,
	PSVSpliterator,
	type Sequence,
	TSVSpliterator,
	zipSync,
} from "spliterator"
import { createChunkIterator } from "spliterator/node/fs"
import { describe, expectTypeOf, test, vi } from "vitest"

import { fixturesDirectory, loadFixture } from "../support/utils.js"

const fixturePath = fixturesDirectory("carvel.csv")
const fixture = await loadFixture(fixturePath)

const rawHeader = fixture.decodedLines[0]!.split(",")
const firstRow = fixture.decodedLines[1]!.split(",")

const normalizedHeader = normalizeColumnNames(rawHeader)

interface TypedCSVRow {
	Country: string
	Location: string
}

test("count/countAsync count logical CSV rows without consuming a later path parse", async ({ expect }) => {
	const counted = await CSVSpliterator.countAsync(fixturePath)
	const parsed = await CSVSpliterator.fromAsync(fixturePath).toArray()

	expect(CSVSpliterator.count('name,note\nfirst,"one\ntwo"\nsecond,three\n')).toBe(2)
	expect(counted).toBe(parsed.length)
})

test("countAsync honours quoted newlines, headers, drop, and take", async ({ expect }) => {
	const encoder = new TextEncoder()

	const source = (async function* () {
		yield encoder.encode('name,note\nfirst,"one')
		yield encoder.encode('\ntwo"\nsecond,three\nthird,four\n')
	})()

	expect(await CSVSpliterator.countAsync(source, { drop: 1, take: 1 })).toBe(1)
})

test("TSV and PSV inherit count/countAsync", async ({ expect }) => {
	const encoder = new TextEncoder()

	expect(
		await TSVSpliterator.countAsync(
			(async function* () {
				yield encoder.encode("a\tb\n1\t2\n")
			})()
		)
	).toBe(1)

	expect(
		await PSVSpliterator.countAsync(
			(async function* () {
				yield encoder.encode("a|b\n1|2\n")
			})()
		)
	).toBe(1)
})

test("Object mode accepts an interface as its row type", async ({ expect }) => {
	const source = (async function* () {
		yield new TextEncoder().encode("Country,Location\nFR,PAR\n")
	})()

	const records = CSVSpliterator.fromAsync<TypedCSVRow>(source, {
		mode: "object",
		normalizeKeys: false,
	})

	expectTypeOf(records).toEqualTypeOf<AsyncSequence<TypedCSVRow>>()
	expect(await records.toArray()).toEqual([{ Country: "FR", Location: "PAR" }])

	const defaultRecords = CSVSpliterator.fromAsync<Record<string, string>>(source, { columnDelimiter: "," })

	expectTypeOf(defaultRecords).toEqualTypeOf<AsyncSequence<Record<string, string>>>()

	const syncRecords = CSVSpliterator.from<TypedCSVRow>("Country,Location\nFR,PAR\n", {
		mode: "object",
		normalizeKeys: false,
	})

	expectTypeOf(syncRecords).toEqualTypeOf<Sequence<TypedCSVRow>>()

	expectTypeOf(
		CSVSpliterator.from<Record<string, string>>("Country,Location\nFR,PAR\n", { columnDelimiter: "," })
	).toEqualTypeOf<Sequence<Record<string, string>>>()

	expectTypeOf(
		TSVSpliterator.from<TypedCSVRow>("Country\tLocation\nFR\tPAR\n", { mode: "object", normalizeKeys: false })
	).toEqualTypeOf<Sequence<TypedCSVRow>>()

	expectTypeOf(
		PSVSpliterator.from<TypedCSVRow>("Country|Location\nFR|PAR\n", { mode: "object", normalizeKeys: false })
	).toEqualTypeOf<Sequence<TypedCSVRow>>()

	expectTypeOf(
		TSVSpliterator.fromAsync<TypedCSVRow>(
			(async function* () {
				yield new TextEncoder().encode("Country\tLocation\nFR\tPAR\n")
			})(),
			{ mode: "object", normalizeKeys: false }
		)
	).toEqualTypeOf<AsyncSequence<TypedCSVRow>>()

	expectTypeOf(
		PSVSpliterator.fromAsync<TypedCSVRow>(
			(async function* () {
				yield new TextEncoder().encode("Country|Location\nFR|PAR\n")
			})(),
			{ mode: "object", normalizeKeys: false }
		)
	).toEqualTypeOf<AsyncSequence<TypedCSVRow>>()
})

test("Header is parsed", async ({ expect }) => {
	const result = CSVSpliterator.from(fixture.bytes, { mode: "object", normalizeKeys: false }).next()

	expect(result.done, "First row should not be done").toBeFalsy()

	const header = Object.keys(result.value!)

	expect(header, "Header should be an array of columns").members(rawHeader)
})

test("Async: Header is parsed", async ({ expect, onTestFinished }) => {
	const chunkIterator = await createChunkIterator(fixturePath)
	onTestFinished(() => chunkIterator[Symbol.asyncDispose]?.())

	const result = await CSVSpliterator.fromAsync(chunkIterator, { mode: "object", normalizeKeys: false }).next()

	expect(result.done, "Async: first row should not be done").toBeFalsy()

	const header = Object.keys(result.value!)

	expect(header, "Async: Header should be an array of columns").members(rawHeader)
})

test("Header normalization", async ({ expect }) => {
	const result = CSVSpliterator.from(fixture.bytes, { normalizeKeys: true, mode: "object" }).next()
	const header = Object.keys(result.value!)

	expect(header, "Header should be normalized").members(normalizedHeader)
})

test("Async: Header normalization", async ({ expect, onTestFinished }) => {
	const chunkIterator = await createChunkIterator(fixturePath)
	onTestFinished(() => chunkIterator[Symbol.asyncDispose]?.())

	const result = await CSVSpliterator.fromAsync(chunkIterator, { normalizeKeys: true, mode: "object" }).next()

	const header = Object.keys(result.value!)

	expect(header, "Header should be normalized").members(normalizedHeader)
})

test("Rows emit as entries", async ({ expect }) => {
	const result = CSVSpliterator.from(fixture.bytes, { mode: "entries", normalizeKeys: true }).next()

	const expectedRow = Array.from(zipSync(normalizedHeader, firstRow))
	expect(Object.values(result.value), "Header should be an array of columns").toMatchObject(expectedRow)
})

test("Async: Rows emit as record", async ({ expect, onTestFinished }) => {
	const expectedRow = Object.fromEntries(Array.from(zipSync(normalizedHeader, firstRow)))

	const chunkIterator = await createChunkIterator(fixturePath)
	onTestFinished(() => chunkIterator[Symbol.asyncDispose]?.())

	const rowGeneratorAsync = CSVSpliterator.fromAsync(chunkIterator, { mode: "object", normalizeKeys: true })
	const emittedRowAsync = await rowGeneratorAsync.next()

	expect(emittedRowAsync.value, "Async: Header should be record").toMatchObject(expectedRow)
})

// Regression for issue #2: the per-row column tokenizer used to inherit the default
// `skipEmpty: true` and silently collapse consecutive delimiters, dropping every empty cell
// and shifting later columns left. Empty cells in delimited records are semantically meaningful
// (a 5-column row must stay 5 columns), so the column splitter must preserve them.
const emptyFieldsTsv = "a\tb\tc\td\te\n1\t\t\t\t5\n"

test("Empty fields are preserved between consecutive column delimiters", ({ expect }) => {
	const rows = Array.from(
		CSVSpliterator.from(emptyFieldsTsv, { mode: "array", columnDelimiter: Delimiters.Tab, header: false })
	)

	expect(rows).toEqual([
		["a", "b", "c", "d", "e"],
		["1", "", "", "", "5"],
	])
})

test("Async: Empty fields are preserved between consecutive column delimiters", async ({ expect }) => {
	const bytes = new TextEncoder().encode(emptyFieldsTsv)

	const chunkIterator = (async function* () {
		yield bytes
	})()

	const rows: string[][] = []

	for await (const row of CSVSpliterator.fromAsync(chunkIterator, {
		mode: "array",
		columnDelimiter: Delimiters.Tab,
		header: false,
	})) {
		rows.push(row as string[])
	}

	expect(rows).toEqual([
		["a", "b", "c", "d", "e"],
		["1", "", "", "", "5"],
	])
})

test("trim: columns and header cells are trimmed by default, after unquoting", ({ expect }) => {
	const source = new TextEncoder().encode(' Name , Age \n " Ada " , 36 \r\nBob,  41\n')

	expect(CSVSpliterator.from(source).toArray()).toEqual([
		{ name: "Ada", age: "36" },
		{ name: "Bob", age: "41" },
	])

	expect(CSVSpliterator.from(source, { mode: "array", header: false }).toArray()).toEqual([
		["Name", "Age"],
		["Ada", "36"],
		["Bob", "41"],
	])
})

test("trim: false keeps the padding", ({ expect }) => {
	const source = new TextEncoder().encode("a, b \n 1 ,2\n")

	expect(CSVSpliterator.from(source, { mode: "array", header: false, trim: false }).toArray()).toEqual([
		["a", " b "],
		[" 1 ", "2"],
	])
})

test("trim applies on the async path", async ({ expect }) => {
	async function* source() {
		yield new TextEncoder().encode(" x , y \n 1 , 2 \n")
	}

	expect(await CSVSpliterator.fromAsync(source()).toArray()).toEqual([{ x: "1", y: "2" }])
})

test("a column delimiter that does not round-trip through UTF-8 takes the byte path, with quotes and empties intact", ({
	expect,
}) => {
	// 0xFF alone is not valid UTF-8, so `TextDecoder` would turn it into U+FFFD and a string split could never find it.
	const delimiter = new Uint8Array([0xff])
	const encoder = new TextEncoder()

	const row = (...parts: string[]) => {
		const out: number[] = []

		parts.forEach((part, i) => {
			if (i) {
				out.push(0xff)
			}

			out.push(...encoder.encode(part))
		})

		return out
	}

	const source = new Uint8Array([...row("a", "", '"x\u00FF y"', ""), 0x0a, ...row("1", "2", "3", "4"), 0x0a])

	expect(CSVSpliterator.from(source, { columnDelimiter: delimiter, header: false, mode: "array" }).toArray()).toEqual([
		["a", "", "x\u00FF y", ""],
		["1", "2", "3", "4"],
	])

	expect(
		CSVSpliterator.from(source, {
			columnDelimiter: delimiter,
			header: false,
			mode: "array",
			enableQuoteHandling: false,
		}).toArray()
	).toEqual([
		["a", "", '"x\u00FF y"', ""],
		["1", "2", "3", "4"],
	])
})

describe("columnScan", () => {
	const encoder = new TextEncoder()

	function both(source: Uint8Array | string, init: Parameters<typeof CSVSpliterator.from>[1]) {
		const spy = vi.spyOn(CharacterSequence, "scanCells")
		const auto = CSVSpliterator.from(source, { ...init, columnScan: "auto" } as never).toArray()
		const autoCalls = spy.mock.calls.length

		spy.mockClear()

		const rows = CSVSpliterator.from(source, { ...init, columnScan: "rows" } as never).toArray()
		const rowsCalls = spy.mock.calls.length

		spy.mockRestore()

		return { auto, rows, fastPathRan: autoCalls > 0, rowsCalls }
	}

	test("the fast path yields what the row path yields, and actually ran", async ({ expect }) => {
		await CharacterSequence.whenReady()

		for (const mode of ["array", "object", "entries"] as const) {
			for (const trim of [true, false]) {
				for (const header of [true, false]) {
					if (mode !== "array" && !header) continue

					const result = both(fixture.bytes, { mode, trim, header } as never)

					expect(result.auto, `${mode} trim=${trim} header=${header}`).toEqual(result.rows)
					expect(result.fastPathRan).toBe(true)
					expect(result.rowsCalls).toBe(0)
				}
			}
		}
	})

	test("transformers, normalizeKeys, drop and take behave the same on both paths", async ({ expect }) => {
		await CharacterSequence.whenReady()

		const calls = { auto: 0, rows: 0 }
		const src = ' Name , Age \n " Ada " , 36 \r\nBob,  41\nCy,7\n'

		for (const columnScan of ["auto", "rows"] as const) {
			const out = CSVSpliterator.from(src, {
				columnScan,
				drop: 1,
				take: 2,
				transformers: {
					age: (v) => {
						calls[columnScan]++

						return Number(v)
					},
				},
			}).toArray()

			expect(out).toEqual([
				{ name: "Bob", age: 41 },
				{ name: "Cy", age: 7 },
			])
		}

		expect(calls.auto).toBe(calls.rows)
	})

	test("a string source is eligible", async ({ expect }) => {
		await CharacterSequence.whenReady()

		const result = both("a,b\n1,2\n", { header: false, mode: "array" })

		expect(result.auto).toEqual([
			["a", "b"],
			["1", "2"],
		])

		expect(result.fastPathRan).toBe(true)
	})

	test("a byte view with a nonzero offset is eligible and correct", async ({ expect }) => {
		await CharacterSequence.whenReady()

		const backing = encoder.encode("XXXXa,b\n1,2\nYYYY")
		const view = backing.subarray(4, -4)
		const result = both(view, { header: false, mode: "array" })

		expect(result.auto).toEqual([
			["a", "b"],
			["1", "2"],
		])

		expect(result.fastPathRan).toBe(true)
	})

	test("invalid UTF-8 falls back to the row path and yields U+FFFD", async ({ expect }) => {
		await CharacterSequence.whenReady()

		const bytes = new Uint8Array([0x61, 0x2c, 0xff, 0x0a])
		const result = both(bytes, { header: false, mode: "array" })

		expect(result.auto).toEqual([["a", "\uFFFD"]])
		expect(result.auto).toEqual(result.rows)
		expect(result.fastPathRan).toBe(false)
	})

	test("an ineligible configuration takes the row path", async ({ expect }) => {
		await CharacterSequence.whenReady()

		const cases: Array<[string, object]> = [
			["multi-byte column delimiter", { columnDelimiter: "::" }],
			["column delimiter equal to the row delimiter", { columnDelimiter: "\n" }],
			["non-ASCII single-byte column delimiter", { columnDelimiter: new Uint8Array([0xff]) }],
			["quote byte as column delimiter", { columnDelimiter: '"' }],
			["carriage return as column delimiter", { columnDelimiter: "\r" }],
			["multi-byte row delimiter", { delimiter: "\r\n" }],
			["nonzero position", { position: 2 }],
			["columnScan rows", { columnScan: "rows" }],
		]

		for (const [label, init] of cases) {
			const spy = vi.spyOn(CharacterSequence, "scanCells")

			CSVSpliterator.from("a,b\n1,2\n", { header: false, mode: "array", ...init } as never).toArray()

			const seen = spy.mock.calls.length

			spy.mockRestore()
			expect(seen, label).toBe(0)
		}
	})

	test("take(0) on the sequence yields nothing and does not decode", async ({ expect }) => {
		await CharacterSequence.whenReady()

		const spy = vi.spyOn(CharacterSequence, "scanCells")

		expect(CSVSpliterator.from("a,b\n1,2\n", { header: false, mode: "array" }).take(0).toArray()).toEqual([])
		expect(spy).not.toHaveBeenCalled()
		spy.mockRestore()
	})

	test("the take: 0 option without a header neither decodes nor scans", async ({ expect }) => {
		await CharacterSequence.whenReady()

		const scan = vi.spyOn(CharacterSequence, "scanCells")
		const decode = vi.spyOn(TextDecoder.prototype, "decode")

		try {
			for (const drop of [0, 1]) {
				expect(CSVSpliterator.from("a,b\n1,2\n", { header: false, mode: "array", take: 0, drop }).toArray()).toEqual([])
			}

			expect(scan).not.toHaveBeenCalled()
			expect(decode).not.toHaveBeenCalled()
		} finally {
			scan.mockRestore()
			decode.mockRestore()
		}
	})

	test("a header normalization failure propagates once and is not retried on the row path", async ({ expect }) => {
		await CharacterSequence.whenReady()

		let calls = 0

		const boom = () => {
			calls++

			throw new Error("boom")
		}

		expect(() => CSVSpliterator.from("a,b\n1,2\n", { transformers: { a: boom } }).toArray()).toThrow("boom")
		expect(calls).toBe(1)
	})

	test("without the scanner loaded, from() takes the row path in a fresh process", async ({ expect }) => {
		const { execFile } = await import("node:child_process")
		const { promisify } = await import("node:util")
		const entry = new URL("../../out/index.js", import.meta.url).pathname

		const script = `
			import { CSVSpliterator, CharacterSequence } from ${JSON.stringify(entry)}
			const before = CSVSpliterator.from("a,b\\n1,2\\n", { header: false, mode: "array" }).toArray()
			const ready = await CharacterSequence.whenReady()
			const after = CSVSpliterator.from("a,b\\n1,2\\n", { header: false, mode: "array" }).toArray()
			console.log(JSON.stringify({ before, after, ready }))
		`

		const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script])

		expect(JSON.parse(stdout)).toEqual({
			before: [
				["a", "b"],
				["1", "2"],
			],
			after: [
				["a", "b"],
				["1", "2"],
			],
			ready: true,
		})
	})

	test("the async bulk branch takes the fast path and matches streaming and rows", async ({ expect }) => {
		const spy = vi.spyOn(CharacterSequence, "scanCells")
		const auto = await CSVSpliterator.fromAsync(fixturePath).toArray()
		const autoCalls = spy.mock.calls.length

		spy.mockClear()

		const rows = await CSVSpliterator.fromAsync(fixturePath, { columnScan: "rows" }).toArray()
		const streamed = await CSVSpliterator.fromAsync(fixturePath, { bulkThreshold: 0 } as never).toArray()
		const otherCalls = spy.mock.calls.length

		spy.mockRestore()
		expect(autoCalls).toBeGreaterThan(0)
		expect(otherCalls).toBe(0)
		expect(auto).toEqual(rows)
		expect(auto).toEqual(streamed)
	})

	test("an unsized single-chunk stream takes the fast path; a multi-chunk stream does not", async ({ expect }) => {
		const bytes = encoder.encode("name,age\nAda,36\nBob,41\n")

		const one = async function* () {
			yield bytes
		}

		const many = async function* () {
			yield bytes.subarray(0, 10)
			yield bytes.subarray(10)
		}

		const expected = [
			{ name: "Ada", age: "36" },
			{ name: "Bob", age: "41" },
		]

		const spy = vi.spyOn(CharacterSequence, "scanCells")

		expect(await CSVSpliterator.fromAsync(one()).toArray()).toEqual(expected)

		const oneCalls = spy.mock.calls.length

		spy.mockClear()
		expect(await CSVSpliterator.fromAsync(many()).toArray()).toEqual(expected)

		const manyCalls = spy.mock.calls.length

		spy.mockRestore()
		expect(oneCalls).toBeGreaterThan(0)
		expect(manyCalls).toBe(0)
	})

	test("drop and take on the async bulk path keep fromAsync's callback order", async ({ expect }) => {
		const source = async function* () {
			yield encoder.encode("n\n1\n2\n3\n4\n")
		}

		const seen: string[] = []

		const out = await CSVSpliterator.fromAsync(source(), {
			drop: 1,
			take: 2,
			transformers: {
				n: (v) => {
					seen.push(v)

					return Number(v)
				},
			},
		}).toArray()

		expect(out).toEqual([{ n: 2 }, { n: 3 }])
		// fromAsync maps before it drops, so the dropped row's transformer still ran, as it does today.
		expect(seen).toEqual(["1", "2", "3"])
	})

	test("take(0) leaves a deferred async source unopened", async ({ expect }) => {
		let opened = false

		const source = {
			async *[Symbol.asyncIterator]() {
				opened = true
				yield encoder.encode("a,b\n1,2\n")
			},
		}

		expect(await CSVSpliterator.fromAsync(source, { header: false, mode: "array" }).take(0).toArray()).toEqual([])
		expect(opened).toBe(false)
	})

	test("invalid UTF-8 on the async bulk path falls back to rows", async ({ expect }) => {
		const source = async function* () {
			yield new Uint8Array([0x61, 0x2c, 0xff, 0x0a])
		}

		const spy = vi.spyOn(CharacterSequence, "scanCells")
		const out = await CSVSpliterator.fromAsync(source(), { header: false, mode: "array" }).toArray()
		const calls = spy.mock.calls.length

		spy.mockRestore()
		expect(out).toEqual([["a", "\uFFFD"]])
		expect(calls).toBe(0)
	})

	test("a throwing transformer on the bulk path propagates once", async ({ expect }) => {
		let calls = 0
		let closed = false

		const source = {
			async *[Symbol.asyncIterator]() {
				try {
					yield encoder.encode("a,b\n1,2\n3,4\n")
				} finally {
					closed = true
				}
			},
		}

		await expect(
			CSVSpliterator.fromAsync(source, {
				transformers: {
					a: () => {
						calls++

						throw new Error("boom")
					},
				},
			}).toArray()
		).rejects.toThrow("boom")

		expect(calls).toBe(1)
		expect(closed).toBe(true)
	})

	test("TSV and PSV inherit the fast path through their column delimiter", async ({ expect }) => {
		const spy = vi.spyOn(CharacterSequence, "scanCells")

		const source = async function* () {
			yield encoder.encode("a\tb\n1\t2\n")
		}

		const out = await TSVSpliterator.fromAsync(source(), { header: false, mode: "array" }).toArray()
		const calls = spy.mock.calls.length

		spy.mockRestore()

		expect(out).toEqual([
			["a", "b"],
			["1", "2"],
		])

		expect(calls).toBeGreaterThan(0)
	})

	test("a nested parse inside a transformer does not disturb the outer batch", async ({ expect }) => {
		await CharacterSequence.whenReady()

		const inner = "x,y\n1,2\n3,4\n"
		const outerRows = Array.from({ length: 300 }, (_, i) => `${i},v${i}`)
		const outer = "id,val\n" + outerRows.join("\n") + "\n"
		const expected = CSVSpliterator.from(outer, { columnScan: "rows" }).toArray()
		const seen: unknown[] = []

		const out = CSVSpliterator.from(outer, {
			transformers: {
				val: (v) => {
					// Runs while the outer batch still has unread cells, and stages its own windows into WASM memory.
					seen.push(CSVSpliterator.from(inner).toArray().length)

					return v
				},
			},
		}).toArray()

		expect(out).toEqual(expected)
		expect(seen).toHaveLength(outerRows.length)
		expect(new Set(seen)).toEqual(new Set([2]))
	})

	test("two interleaved fast-path parsers stay independent", async ({ expect }) => {
		await CharacterSequence.whenReady()

		const a = "h\n" + Array.from({ length: 200 }, (_, i) => `a${i}`).join("\n") + "\n"
		const b = "h\n" + Array.from({ length: 200 }, (_, i) => `b${i}`).join("\n") + "\n"
		const one = CSVSpliterator.from(a, { mode: "array" })[Symbol.iterator]()
		const two = CSVSpliterator.from(b, { mode: "array" })[Symbol.iterator]()
		const merged: string[] = []

		for (;;) {
			const x = one.next()
			const y = two.next()

			if (x.done && y.done) break

			if (!x.done) {
				merged.push((x.value as string[])[0]!)
			}

			if (!y.done) {
				merged.push((y.value as string[])[0]!)
			}
		}

		expect(merged).toEqual(Array.from({ length: 200 }, (_, i) => [`a${i}`, `b${i}`]).flat())
	})

	test("a header-time throw closes a streaming source and propagates once", async ({ expect }) => {
		let closed = false
		let reads = 0

		const source = {
			async *[Symbol.asyncIterator]() {
				try {
					yield encoder.encode("name,")
					yield encoder.encode("age\nAda,36\n")
					yield encoder.encode("Bob,41\n")
				} finally {
					closed = true
				}
			},
		}

		const transformers = {
			get name(): never {
				reads++

				throw new Error("boom")
			},
		}

		await expect(
			CSVSpliterator.fromAsync(source, { transformers, bulkThreshold: 0 } as never).toArray()
		).rejects.toThrow("boom")

		expect(reads).toBe(1)
		expect(closed).toBe(true)
	})
})
