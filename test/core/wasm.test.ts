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
		// The module loads asynchronously. Awaiting it lets the synchronous
		// engine use it, so the tests exercise the SIMD implementation rather than
		// the JS fallback, defeating the purpose of the suite.
		const ready = await CharacterSequence.whenReady()

		if (!ready) {
			throw new Error("WASM SIMD scanner must be available in this environment")
		}
	})

	// `wasm_module.ts` is not re-exported from the package root, so it must be reached by
	// relative path into the compiled output (per AGENTS.md, the way `benchmarks/` reaches
	// internals) rather than through `"spliterator"`. A *static* import of a path under `out/`
	// makes tsc -b treat the generated `.d.ts` there as a root input of this project (rootDir is
	// the whole project, which contains outDir) — a second `tsc -b` run then fails with
	// TS5055 "would overwrite input file" because the emit target is that same file. Building
	// the specifier at runtime keeps it a non-literal `import()`, which tsc does not resolve
	// statically, avoiding the cycle. The imported members are untyped as a result.
	// Shared by the `scan_csv_cells` and `CharacterSequence.scanCells` describe blocks below.
	let loadWasmModule: () => Promise<any>
	let CELL_RESULT_HEADER: number
	let CELL_RESULT_STRIDE: number
	let CELL_FLAG_ROW_END: number
	let CELL_FLAG_HAS_QUOTE: number

	beforeAll(async () => {
		const wasmModulePath = "../../out/lib/core/wasm_module.js"

		;({ loadWasmModule, CELL_RESULT_HEADER, CELL_RESULT_STRIDE, CELL_FLAG_ROW_END, CELL_FLAG_HAS_QUOTE } = await import(
			wasmModulePath
		))
	})

	test("whenReady() resolves true once the SIMD scanner is loaded", async () => {
		expect(await CharacterSequence.whenReady()).toBe(true)
	})

	/**
	 * Independent oracle mirroring searchAll's JS semantics (incl. trailing empty field).
	 */
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

		if (start <= buf.length) {
			ranges.push([start, buf.length])
		}

		return ranges
	}

	/**
	 * Build a >= threshold haystack of exactly `length` bytes with commas at `positions`.
	 */
	function commaHaystack(length: number, positions: number[]): Uint8Array {
		const buf = new Uint8Array(length).fill(Delimiters.Zero)

		for (const p of positions) {
			buf[p] = Delimiters.Comma
		}

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

	/**
	 * Oracle for searchMatches: each delimiter/quote byte, in order, with its pattern id.
	 */
	function referenceMatches(
		buf: Uint8Array,
		delim: number,
		quote: number
	): Array<{ offset: number; patternId: number }> {
		const matches: Array<{ offset: number; patternId: number }> = []

		for (let i = 0; i < buf.length; i++) {
			if (buf[i] === delim) {
				matches.push({ offset: i, patternId: 0 })
			} else if (buf[i] === quote) {
				matches.push({ offset: i, patternId: 1 })
			}
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

	/**
	 * Build a >= threshold haystack of `length` bytes with a CRLF at each given start.
	 */
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
		// ...the next search on `rows` must still read its own bytes rather than leftovers.
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

			for (let c = 0; c < 800; c++) {
				cells.push(`r${r}c${c}`)
			}

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

	// WASM_THRESHOLD is 512, so a ~1 KB buffer now takes the WASM path. Guard that the
	// newly-included mid-size range stays at parity with the JS oracle for both scanners.
	test("searchAll matches the oracle for a mid-size (>= threshold, < 4096) haystack", () => {
		const comma = new CharacterSequence(Delimiters.Comma)
		const buf = commaHaystack(1024, [10, 200, 700, 1000])

		expect(comma.searchAll(buf)).toEqual(referenceRanges(buf, comma))
	})

	test("searchMatches matches the oracle for a mid-size (>= threshold, < 4096) haystack", () => {
		const comma = new CharacterSequence(Delimiters.Comma)
		const quote = new CharacterSequence(Delimiters.DoubleQuote)
		const buf = new Uint8Array(1024).fill(Delimiters.Zero)
		buf[10] = Delimiters.Comma
		buf[11] = Delimiters.DoubleQuote
		buf[500] = Delimiters.DoubleQuote
		buf[1000] = Delimiters.Comma

		expect(comma.searchMatches(buf, quote)).toEqual(referenceMatches(buf, Delimiters.Comma, Delimiters.DoubleQuote))
	})

	test("bounded range scans resume without truncating dense input", () => {
		const comma = new CharacterSequence(Delimiters.Comma)
		const buf = encoder.encode("x,".repeat(300))
		const ranges: Array<[number, number]> = []
		let state = { scanCursor: 0, pendingSliceStart: 0, insideQuotes: false }

		while (state.scanCursor < buf.length) {
			const scan = comma.scanRanges(buf, state, buf.length, undefined, 7)

			expect(scan).not.toBeNull()

			for (let i = 0; i < scan!.count; i++) {
				ranges.push([scan!.ranges[i * 2]!, scan!.ranges[i * 2 + 1]!])
			}

			expect(scan!.scanCursor).toBeGreaterThan(state.scanCursor)
			state = scan!
		}

		// scanRanges emits completed delimiter-terminated ranges. Spliterator handles the EOF tail.
		expect(ranges).toEqual(referenceRanges(buf, comma).slice(0, -1))
		expect(state.pendingSliceStart).toBe(buf.length)
	})

	test("bounded range scans carry quote state across result batches", () => {
		const comma = new CharacterSequence(Delimiters.Comma)
		const quote = new CharacterSequence(Delimiters.DoubleQuote)
		const text = `${'a,"b,c",'.repeat(80)}tail`
		const buf = encoder.encode(text)
		const ranges: Array<[number, number]> = []
		let state = { scanCursor: 0, pendingSliceStart: 0, insideQuotes: false }

		while (state.scanCursor < buf.length) {
			const scan = comma.scanRanges(buf, state, buf.length, quote, 3)

			expect(scan).not.toBeNull()

			for (let i = 0; i < scan!.count; i++) {
				ranges.push([scan!.ranges[i * 2]!, scan!.ranges[i * 2 + 1]!])
			}

			expect(scan!.scanCursor).toBeGreaterThan(state.scanCursor)
			state = scan!
		}

		const values = ranges.map(([start, end]) => new TextDecoder().decode(buf.subarray(start, end)))

		expect(values).toEqual(Array.from({ length: 80 }, () => ["a", '"b,c"']).flat())
		expect(state.insideQuotes).toBe(false)
		expect(new TextDecoder().decode(buf.subarray(state.pendingSliceStart))).toBe("tail")
	})

	// Regression: `scanRanges` used to stage the whole buffer into WASM memory on every call
	// (`set(haystack.subarray(0, end))`) even though the scan resumes at `state.scanCursor`. A record
	// spanning many reads was therefore re-copied once per read — 76.36GB for a 100MB quoted field,
	// a second O(n²) alongside the `BufferController.set` one. Only the unscanned window is staged
	// now, which means emitted offsets are window-relative and the wrapper must rebase them.
	describe("windowed staging", () => {
		test("resuming mid-buffer still emits absolute ranges", () => {
			const comma = new CharacterSequence(Delimiters.Comma)
			const buf = commaHaystack(4096, [10, 2000, 3000, 3500, 4000])

			// Pretend bytes up to 2001 are already scanned and a record opened at 1500 — i.e.
			// `pendingSliceStart` sits well behind `scanCursor`, which is the shape a long record makes.
			const scan = comma.scanRanges(buf, { scanCursor: 2001, pendingSliceStart: 1500, insideQuotes: false }, 4096)

			expect(scan, "WASM path is active").not.toBeNull()
			expect(scan!.count, "Three delimiters remain past the cursor").toBe(3)

			// The first range begins before the staged window and must carry the absolute start.
			expect([scan!.ranges[0], scan!.ranges[1]], "First range spans from the carried slice start").toEqual([1500, 3000])

			expect([scan!.ranges[2], scan!.ranges[3]], "Second range is absolute").toEqual([3001, 3500])
			expect([scan!.ranges[4], scan!.ranges[5]], "Third range is absolute").toEqual([3501, 4000])

			expect(scan!.scanCursor, "Cursor is absolute").toBe(4096)
			expect(scan!.pendingSliceStart, "Pending slice start is absolute").toBe(4001)
		})

		test("a record spanning several bounded batches keeps its true start", () => {
			const comma = new CharacterSequence(Delimiters.Comma)
			// One long record from 0 to 5000, then short ones — the giant-quoted-field shape.
			const buf = commaHaystack(8192, [5000, 5100, 5200, 5300, 5400])
			const ranges: Array<[number, number]> = []
			let state = { scanCursor: 0, pendingSliceStart: 0, insideQuotes: false }

			while (state.scanCursor < buf.length) {
				const scan = comma.scanRanges(buf, state, buf.length, undefined, 2)

				expect(scan, "WASM path is active").not.toBeNull()

				for (let i = 0; i < scan!.count; i++) {
					ranges.push([scan!.ranges[i * 2]!, scan!.ranges[i * 2 + 1]!])
				}

				expect(scan!.scanCursor, "Each batch advances").toBeGreaterThan(state.scanCursor)
				state = scan!
			}

			expect(ranges, "Batched scan reproduces the oracle exactly").toEqual(referenceRanges(buf, comma).slice(0, -1))

			expect(ranges[0], "The long leading record survives batching intact").toEqual([0, 5000])
		})

		test("quote state and absolute offsets survive together across batches", () => {
			const comma = new CharacterSequence(Delimiters.Comma)
			const quote = new CharacterSequence(Delimiters.DoubleQuote)
			// A quoted region holding commas, opened well before the first batch boundary.
			const text = `${"x".repeat(600)},"${",".repeat(400)}",tail,`
			const buf = encoder.encode(text)
			const ranges: Array<[number, number]> = []
			let state = { scanCursor: 0, pendingSliceStart: 0, insideQuotes: false }

			while (state.scanCursor < buf.length) {
				const scan = comma.scanRanges(buf, state, buf.length, quote, 1)

				expect(scan, "WASM path is active").not.toBeNull()

				for (let i = 0; i < scan!.count; i++) {
					ranges.push([scan!.ranges[i * 2]!, scan!.ranges[i * 2 + 1]!])
				}

				state = scan!
			}

			const values = ranges.map(([start, end]) => new TextDecoder().decode(buf.subarray(start, end)))

			expect(values, "Commas inside the quoted region never split it").toEqual([
				"x".repeat(600),
				`"${",".repeat(400)}"`,
				"tail",
			])

			expect(state.insideQuotes, "Quote state closed").toBe(false)
		})

		// The staging region sits immediately after the copied bytes, so its offset reveals how much
		// was copied. Staging the whole buffer would put it past `end`; staging only the window puts
		// it just past the window. This is the property that makes the scan linear rather than
		// quadratic for a record spanning many reads.
		test("only the unscanned window is staged into WASM memory", () => {
			const comma = new CharacterSequence(Delimiters.Comma)
			const buf = commaHaystack(65_536, [64_000, 65_000])

			const scan = comma.scanRanges(buf, { scanCursor: 63_000, pendingSliceStart: 62_000, insideQuotes: false }, 65_536)

			expect(scan, "WASM path is active").not.toBeNull()

			expect(
				scan!.ranges.byteOffset,
				"Results are staged just past the 2.5KB window, not past the 64KB buffer"
			).toBeLessThan(65_536)
		})
	})

	// A haystack ending exactly on a delimiter has a trailing empty field.
	// The JS scan emits it (matching String.split); the WASM kernel must too, or the last column silently
	// disappears for wide rows ending in a separator.
	test("searchAll emits the trailing empty field when the haystack ends on a delimiter", () => {
		const comma = new CharacterSequence(Delimiters.Comma)
		const buf = commaHaystack(4100, [10, 2000, 4099]) // final byte is the delimiter

		expect(buf.at(-1)).toBe(Delimiters.Comma)

		const ranges = comma.searchAll(buf)

		expect(ranges).toEqual(referenceRanges(buf, comma))
		expect(ranges.at(-1)).toEqual([4100, 4100])
	})

	describe("scan_csv_cells", () => {
		/**
		 * Stage `bytes` at offset 0 and run the kernel once. Returns the header and the cells as plain numbers.
		 */
		async function scan(
			bytes: Uint8Array,
			{
				quote = 0x22,
				crlf = 1,
				insideQuotes = 0,
				cellStartUnits = 0,
				cellHasQuote = 0,
				previousByte = -1,
				maxCells = 64,
			} = {}
		) {
			const wasm = await loadWasmModule()

			if (!wasm) throw new Error("scanner unavailable")

			const resultsOffset = Math.ceil(bytes.length / 4) * 4
			const needed = resultsOffset + (CELL_RESULT_HEADER + maxCells * CELL_RESULT_STRIDE) * 4

			if (needed > wasm.memory.buffer.byteLength) {
				wasm.memory.grow(Math.ceil((needed - wasm.memory.buffer.byteLength) / 65_536))
			}

			new Uint8Array(wasm.memory.buffer, 0, bytes.length).set(bytes)

			const count = wasm.scanCsvCells(
				0,
				bytes.length,
				0x0a,
				0x2c,
				quote,
				crlf,
				insideQuotes,
				cellStartUnits,
				cellHasQuote,
				previousByte,
				resultsOffset,
				maxCells
			)

			const block = new Int32Array(wasm.memory.buffer, resultsOffset, CELL_RESULT_HEADER + count * CELL_RESULT_STRIDE)
			const cells: Array<[number, number, number]> = []

			for (let i = 0; i < count; i++) {
				const base = CELL_RESULT_HEADER + i * CELL_RESULT_STRIDE

				cells.push([block[base]!, block[base + 1]!, block[base + 2]!])
			}

			return {
				cursor: block[0]!,
				units: block[1]!,
				insideQuotes: block[2]!,
				cellStartUnits: block[3]!,
				cellHasQuote: block[4]!,
				cells,
			}
		}

		test("emits cells with row-end flags and leaves the tail open", async () => {
			const result = await scan(encoder.encode("a,bb\ncc,d"))

			expect(result.cells).toEqual([
				[0, 1, 0],
				[2, 4, CELL_FLAG_ROW_END],
				[5, 7, 0],
			])

			expect(result).toMatchObject({ cursor: 9, units: 9, insideQuotes: 0, cellStartUnits: 8, cellHasQuote: 0 })
		})

		test("a delimiter inside quotes is data, and the cell is flagged", async () => {
			const result = await scan(encoder.encode('"x,y",z\n'))

			expect(result.cells).toEqual([
				[0, 5, CELL_FLAG_HAS_QUOTE],
				[6, 7, CELL_FLAG_ROW_END],
			])

			expect(result.insideQuotes).toBe(0)
		})

		test("crlf drops the carriage return from the cell end, but not at EOF", async () => {
			const withCr = await scan(encoder.encode("a\r\nb\r"))

			expect(withCr.cells).toEqual([[0, 1, CELL_FLAG_ROW_END]])
			expect(withCr.cellStartUnits).toBe(3)
			expect(withCr.units).toBe(5)

			const raw = await scan(encoder.encode("a\r\nb\r"), { crlf: 0 })

			expect(raw.cells).toEqual([[0, 2, CELL_FLAG_ROW_END]])
		})

		test("a row delimiter at window start consults previous_byte for the carriage return", async () => {
			const result = await scan(encoder.encode("\nb"), { previousByte: 0x0d, cellStartUnits: -3 })

			// The open cell began three units before this window, and the CR is the unit just before the LF.
			expect(result.cells).toEqual([[-3, -1, CELL_FLAG_ROW_END]])
		})

		test("counts UTF-16 units: 2- and 3-byte sequences are one unit, 4-byte are two", async () => {
			const result = await scan(encoder.encode("é,한,😀,z\n"))

			expect(result.cells).toEqual([
				[0, 1, 0],
				[2, 3, 0],
				[4, 6, 0],
				[7, 8, CELL_FLAG_ROW_END],
			])

			expect(result.units).toBe(9)
		})

		test("a continuation byte at window start counts zero units", async () => {
			const bytes = encoder.encode("😀,a")

			// Split the emoji: the first window is its first two bytes, the second window the rest.
			const first = await scan(bytes.subarray(0, 2), { maxCells: 64 })

			expect(first.units).toBe(2)
			expect(first.cells).toEqual([])

			const second = await scan(bytes.subarray(2), { cellStartUnits: -2 })

			// The remaining two continuation bytes contribute zero (already counted in `first`),
			// leaving only "," and "a": 1 + 1 = 2. `first.units + second.units` must equal the
			// full string's UTF-16 length ("😀,a".length === 4), which 2 + 2 satisfies and 2 + 3
			// would not.
			expect(second.units).toBe(2)
			expect(second.cells).toEqual([[-2, 0, 0]])
		})

		test("stops when max_cells is reached, with the cursor just past the delimiter that filled it", async () => {
			const result = await scan(encoder.encode("a,b,c\n"), { maxCells: 1 })

			expect(result.cells).toEqual([[0, 1, 0]])
			expect(result).toMatchObject({ cursor: 2, units: 2, cellStartUnits: 2 })
		})

		test("stops at max_cells inside the SIMD loop, in the first and a later vector", async () => {
			// 35 bytes: two full 16-byte vectors run through the SIMD loop before the scalar tail. The 6-byte case above
			// only reaches the tail.
			const bytes = encoder.encode("aaaa,bbbb,cccc,dddd,eeee,ffff,gggg\n")

			// Filled by the comma at 9, in the first vector.
			const first = await scan(bytes, { maxCells: 2 })

			expect(first.cells).toEqual([
				[0, 4, 0],
				[5, 9, 0],
			])

			expect(first).toMatchObject({ cursor: 10, units: 10, cellStartUnits: 10 })

			// Filled by the comma at 19, in the second vector.
			const second = await scan(bytes, { maxCells: 4 })

			expect(second.cells).toEqual([
				[0, 4, 0],
				[5, 9, 0],
				[10, 14, 0],
				[15, 19, 0],
			])

			expect(second).toMatchObject({ cursor: 20, units: 20, cellStartUnits: 20 })
		})

		test("carries an open quoted cell across calls", async () => {
			const first = await scan(encoder.encode('"ab'))

			expect(first).toMatchObject({ cursor: 3, units: 3, insideQuotes: 1, cellStartUnits: 0, cellHasQuote: 1 })

			const second = await scan(encoder.encode('c",d\n'), { insideQuotes: 1, cellStartUnits: -3, cellHasQuote: 1 })

			expect(second.cells).toEqual([
				[-3, 2, CELL_FLAG_HAS_QUOTE],
				[3, 4, CELL_FLAG_ROW_END],
			])
		})

		test("quote handling off treats the quote byte as data", async () => {
			const result = await scan(encoder.encode('"a,b"\n'), { quote: -1 })

			expect(result.cells).toEqual([
				[0, 2, 0],
				[3, 5, CELL_FLAG_ROW_END],
			])
		})

		test("a window longer than 16 bytes with matches in every vector agrees with a scalar oracle", async () => {
			// Quoted items must not embed a real comma: the oracle below splits on every comma in
			// the raw text without tracking quote state, which is only valid when no quoted item's
			// span actually contains one (quote-inside-comma masking has its own dedicated test
			// above). This test's job is vector-boundary agreement across 200 varying-length items.
			const text = Array.from({ length: 200 }, (_, i) => (i % 3 === 0 ? `"q${i}x"` : `c${i}é`)).join(",") + "\n"
			const bytes = encoder.encode(text)
			const result = await scan(bytes, { maxCells: 4096 })
			const expected: Array<[number, number, number]> = []
			let start = 0

			for (let i = 0; i < text.length; i++) {
				if (text[i] === ",") {
					const cell = text.slice(start, i)

					expected.push([start, i, cell.includes('"') ? CELL_FLAG_HAS_QUOTE : 0])
					start = i + 1
				}
			}

			expected.push([start, text.length - 1, CELL_FLAG_ROW_END])
			expect(result.cells).toEqual(expected)
		})
	})

	describe("CharacterSequence.scanCells", () => {
		const options = { rowDelimiter: 0x0a, columnDelimiter: 0x2c, quote: 0x22, crlf: true }
		const initial = { scanCursor: 0, units: 0, insideQuotes: false, cellStartUnits: 0, cellHasQuote: false }

		test("rebases a window's cells and state to absolute offsets", () => {
			const bytes = encoder.encode("é,a\nbb,c")
			// Scan the first row only, then resume.
			const first = CharacterSequence.scanCells(bytes, initial, 5, options)!

			expect(Array.from(first.cells)).toEqual([0, 1, 0, 2, 3, CELL_FLAG_ROW_END])

			expect(first).toMatchObject({
				scanCursor: 5,
				units: 4,
				insideQuotes: false,
				cellStartUnits: 4,
				cellHasQuote: false,
			})

			const second = CharacterSequence.scanCells(bytes, first, bytes.length, options)!

			expect(Array.from(second.cells)).toEqual([4, 6, 0])
			expect(second).toMatchObject({ scanCursor: 9, units: 8, cellStartUnits: 7 })
		})

		test("a cell open across the window edge keeps its absolute start", () => {
			const bytes = encoder.encode('a,"b\nc",d\n')
			const first = CharacterSequence.scanCells(bytes, initial, 4, options)!

			expect(Array.from(first.cells)).toEqual([0, 1, 0])

			expect(first).toMatchObject({
				scanCursor: 4,
				units: 4,
				insideQuotes: true,
				cellStartUnits: 2,
				cellHasQuote: true,
			})

			const second = CharacterSequence.scanCells(bytes, first, bytes.length, options)!

			expect(Array.from(second.cells)).toEqual([2, 7, CELL_FLAG_HAS_QUOTE, 8, 9, CELL_FLAG_ROW_END])
		})

		test("supplies previous_byte so a CRLF split by the window is trimmed", () => {
			const bytes = encoder.encode("ab\r\ncd\n")
			const first = CharacterSequence.scanCells(bytes, initial, 3, options)!

			expect(first.count).toBe(0)

			const second = CharacterSequence.scanCells(bytes, first, bytes.length, options)!

			expect(Array.from(second.cells)).toEqual([0, 2, CELL_FLAG_ROW_END, 4, 6, CELL_FLAG_ROW_END])
		})

		test("returns an owned copy that survives a later scan", () => {
			const bytes = encoder.encode("a,b\n")
			const result = CharacterSequence.scanCells(bytes, initial, bytes.length, options)!
			const snapshot = Array.from(result.cells)

			CharacterSequence.scanCells(encoder.encode("zzzzzzzz,yyyyyyyy\n"), initial, 18, options)

			expect(Array.from(result.cells)).toEqual(snapshot)
		})

		test("honours maxCells and reports where it stopped", () => {
			const bytes = encoder.encode("a,b,c\n")
			const result = CharacterSequence.scanCells(bytes, initial, bytes.length, { ...options, maxCells: 2 })!

			expect(result.count).toBe(2)
			expect(result).toMatchObject({ scanCursor: 4, units: 4, cellStartUnits: 4 })
		})

		test("returns null for an empty window", () => {
			expect(
				CharacterSequence.scanCells(
					encoder.encode("a"),
					{ ...initial, scanCursor: 1, units: 1, cellStartUnits: 1 },
					1,
					options
				)
			).toBeNull()
		})
	})
})
