/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 *
 * The fast cell scan against two oracles: the reference row path (`columnScan: "rows"` is what `CSVSpliterator` will
 * offer; here it is `Spliterator.fromSync` rows split by `splitRowColumns`), and, for the shape of the contract, a
 * String-derived expectation. Windows and batches are shrunk so every boundary case crosses one.
 */

import { CharacterSequence, Spliterator } from "spliterator"
import { beforeAll, describe, expect, test } from "vitest"

const encoder = new TextEncoder()
const lossy = new TextDecoder()

interface Case {
	enableQuoteHandling?: boolean
	crlf?: boolean
	trim?: boolean
	skipEmpty?: boolean
	columnDelimiter?: number
}

// `csv-cells.js` and `csv-columns.js` are not re-exported from the package root, so they must be reached by relative
// path into the compiled output (per AGENTS.md) rather than through `"spliterator"`. A *static* import of a path
// under `out/` makes tsc -b treat the generated `.d.ts` there as a root input of this project (rootDir is the whole
// project, which contains outDir) — a second `tsc -b` run then fails with TS5055 "would overwrite input file"
// because the emit target is that same file. Building the specifiers at runtime keeps them non-literal `import()`s,
// which tsc does not resolve statically, avoiding the cycle. The imported members are untyped as a result.
let scanCsvCells: (
	source: Uint8Array,
	text: string,
	init: {
		rowDelimiter: number
		columnDelimiter: number
		enableQuoteHandling: boolean
		crlf: boolean
		trim: boolean
		skipEmpty: boolean
		windowSize?: number
		maxCells?: number
	}
) => Generator<string[]>

let splitRowColumns: (
	row: Uint8Array,
	columnDelimiter: CharacterSequence,
	decoder: TextDecoder,
	enableQuoteHandling: boolean,
	trim?: boolean
) => string[]

/**
 * What the row path yields for `text` under the same options: the parity oracle.
 */
function reference(text: string, opts: Case = {}): string[][] {
	const { enableQuoteHandling = true, crlf = true, trim = false, skipEmpty = true, columnDelimiter = 0x2c } = opts
	const bytes = encoder.encode(text)
	const columns = new CharacterSequence(columnDelimiter)
	const rows: string[][] = []

	for (const row of Spliterator.fromSync(bytes, { delimiter: 0x0a, crlf, enableQuoteHandling, skipEmpty })) {
		rows.push(splitRowColumns(row, columns, lossy, enableQuoteHandling, trim))
	}

	return rows
}

function fast(text: string, opts: Case = {}, windowSize = 7, maxCells = 3): string[][] {
	const { enableQuoteHandling = true, crlf = true, trim = false, skipEmpty = true, columnDelimiter = 0x2c } = opts
	const bytes = encoder.encode(text)
	const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)

	return Array.from(
		scanCsvCells(bytes, decoded, {
			rowDelimiter: 0x0a,
			columnDelimiter,
			enableQuoteHandling,
			crlf,
			trim,
			skipEmpty,
			windowSize,
			maxCells,
		})
	)
}

beforeAll(async () => {
	if (!(await CharacterSequence.whenReady())) throw new Error("WASM SIMD scanner must be available")
})

beforeAll(async () => {
	const csvCellsPath = "../../out/lib/formats/csv-cells.js"

	const csvColumnsPath = "../../out/lib/formats/csv-columns.js"

	;({ scanCsvCells } = await import(csvCellsPath))
	;({ splitRowColumns } = await import(csvColumnsPath))
})

describe("scanCsvCells parity with the row path", () => {
	const inputs: Array<[string, string, Case?]> = [
		["plain", "a,b\nc,d\n"],
		["no trailing delimiter", "a,b\nc,d"],
		["empty source", ""],
		["single cell", "x"],
		["single empty line", "\n"],
		["empty rows kept", "a\n\n\nb\n", { skipEmpty: false }],
		["empty rows dropped", "a\n\n\nb\n"],
		["empty cells", ",,\n,a,\n"],
		["trailing column delimiter", "a,b,\n"],
		["trailing column delimiter at eof, no newline", "a,b,"],
		["trailing column delimiter at eof after rows", "a,b\nc,"],
		["crlf on", "a,b\r\nc,d\r\n"],
		["crlf off", "a,b\r\nc,d\r\n", { crlf: false }],
		["crlf-only line is empty", "a\r\n\r\nb\r\n"],
		["crlf-only line kept", "a\r\n\r\nb\r\n", { skipEmpty: false }],
		["lone cr is data", "a\rb,c\n"],
		["cr at eof", "a,b\r"],
		["quoted delimiter", 'a,"b,c",d\n'],
		["quoted newline", 'a,"b\nc",d\n'],
		["doubled quote", 'a,"b""c"\n'],
		["quote-only cell", '"",a\n'],
		["quote-only line is not empty", '""\n'],
		["unmatched quote runs to eof", 'a,"b,c\nd,e\n'],
		["unmatched quote mid-cell", '5" pipe,b\n'],
		["quotes off", 'a,"b,c"\n', { enableQuoteHandling: false }],
		["padding outside quotes with trim", ' " Ada " , 36 \n', { trim: true }],
		["trim", "  a , b  \n c ,d\n", { trim: true }],
		["whitespace-only line is not empty", "a\n   \nb\n"],
		["utf8 widths", "é,한,😀,z\né한😀,x\n"],
		["utf8 at every offset", "😀😀😀😀,a\nb,😀\n"],
		["bom at source start", "﻿a,b\nc,d\n"],
		["bom at row starts", "﻿a,b\n﻿c,d\n"],
		["bom after column delimiter stays", "a,﻿b\n"],
		["bom inside quotes stays", '"﻿a",b\n'],
		["bom-only row", "﻿\na\n"],
		["bom-only single cell", "﻿"],
		["repeated bom", "﻿﻿a\n"],
		["tab columns", "a\tb\nc\td\n", { columnDelimiter: 0x09 }],
		["pipe columns", "a|b\nc|d\n", { columnDelimiter: 0x7c }],
	]

	test.each(inputs)("%s", (_label, text, opts) => {
		expect(fast(text, opts)).toEqual(reference(text, opts))
	})

	test.each(inputs)("%s, wide window and batch", (_label, text, opts) => {
		expect(fast(text, opts, 64 * 1024, 4096)).toEqual(reference(text, opts))
	})

	test("a quoted newline straddling the window", () => {
		const text = 'a,"bbbbbbbb\ncccccccc",d\ne,f\n'

		for (let windowSize = 1; windowSize <= text.length + 1; windowSize++) {
			expect(fast(text, {}, windowSize, 2), `window ${windowSize}`).toEqual(reference(text))
		}
	})

	test("a supplementary character straddling the window", () => {
		const text = "😀,a\nbb,😀\n"

		for (let windowSize = 1; windowSize <= 16; windowSize++) {
			expect(fast(text, {}, windowSize, 2), `window ${windowSize}`).toEqual(reference(text))
		}
	})

	test("CRLF straddling the window", () => {
		const text = "ab\r\ncd\r\n"

		for (const crlf of [true, false]) {
			for (let windowSize = 1; windowSize <= text.length + 1; windowSize++) {
				expect(fast(text, { crlf }, windowSize, 2), `crlf ${crlf} window ${windowSize}`).toEqual(
					reference(text, { crlf })
				)
			}
		}
	})

	test("a BOM-only single-cell source", () => {
		for (const skipEmpty of [true, false]) {
			expect(fast("﻿", { skipEmpty })).toEqual(reference("﻿", { skipEmpty }))
		}
	})

	test("a row wider than the batch and longer than the window", () => {
		const cells = Array.from({ length: 50 }, (_, i) => `cell${i}`)
		const text = cells.join(",") + "\n" + cells.join(",")

		expect(fast(text, {}, 16, 3)).toEqual(reference(text))
	})

	test("a large mixed source with the production window and batch", () => {
		const rows: string[] = []

		for (let i = 0; i < 30_000; i++) {
			rows.push(i % 5 === 0 ? `${i},"q, ""${i}""\nmore",é한😀` : `${i},plain ${i},x`)
		}

		const text = rows.join("\r\n") + "\r\n"

		expect(fast(text, {}, 64 * 1024, 4096)).toEqual(reference(text))
	})
})
