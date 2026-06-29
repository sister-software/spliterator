/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 * Benchmark: WASM searchAll vs Spliterator for CSV column splitting.
 * Usage: node out/benchmarks/csv-columns.js
 */

import { CharacterSequence, CSVSpliterator, Delimiters } from "../index.js"
import { Spliterator } from "../lib/Spliterator.js"

/** Generate a synthetic CSV buffer with `rows` rows × `cols` columns. */
function generateCSV(rows: number, cols: number): Uint8Array {
	const encoder = new TextEncoder()
	const cell = "abcd1234" // ~8 bytes per cell
	const parts: Uint8Array[] = []

	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			parts.push(encoder.encode(cell))

			if (c < cols - 1) parts.push(new Uint8Array([Delimiters.Comma]))
		}
		parts.push(new Uint8Array([Delimiters.LineFeed]))
	}

	const totalLen = parts.reduce((sum, p) => sum + p.length, 0)
	const buf = new Uint8Array(totalLen)
	let offset = 0

	for (const p of parts) {
		buf.set(p, offset)
		offset += p.length
	}

	return buf
}

/** Parse rows using the old Spliterator-based approach. */
function parseWithSpliterator(buf: Uint8Array, commaDelim: CharacterSequence): string[][] {
	const decoder = new TextDecoder()
	const rowDelim = new CharacterSequence(Delimiters.LineFeed)
	const rowInit = { delimiter: rowDelim, skipEmpty: false }
	const colInit = { delimiter: commaDelim, skipEmpty: false }

	const rows: string[][] = []

	for (const row of new Spliterator(buf, rowInit)) {
		const columns = new Spliterator(row, colInit).toDecodedArray(decoder)
		rows.push(columns)
	}

	return rows
}

/** Parse rows using WASM searchAll for column splitting. */
function parseWithSearchAll(buf: Uint8Array, commaDelim: CharacterSequence): string[][] {
	const decoder = new TextDecoder()
	const rowDelim = new CharacterSequence(Delimiters.LineFeed)
	const rowInit = { delimiter: rowDelim, skipEmpty: false }

	const rows: string[][] = []

	for (const row of new Spliterator(buf, rowInit)) {
		const ranges = commaDelim.searchAll(row)
		const columns = ranges.map(([s, e]) => decoder.decode(row.subarray(s, e)))
		rows.push(columns)
	}

	return rows
}

async function main(): Promise<void> {
	console.log("=== CSV Column Splitting Benchmark ===\n")

	// Warm up WASM
	console.log("Warming up WASM...")
	const commaDelim = new CharacterSequence(Delimiters.Comma)
	const warmup = new Uint8Array(5000).fill(65)

	commaDelim.searchAll(warmup)
	await new Promise((resolve) => setTimeout(resolve, 100))
	console.log("WASM warmup complete\n")

	const configs = [
		{ rows: 1000, cols: 10, label: "1K × 10 cols" },
		{ rows: 1000, cols: 100, label: "1K × 100 cols" },
		{ rows: 10000, cols: 10, label: "10K × 10 cols" },
		{ rows: 10000, cols: 50, label: "10K × 50 cols" },
		{ rows: 100000, cols: 10, label: "100K × 10 cols" },
	]

	for (const { rows, cols, label } of configs) {
		console.log(`--- ${label} ---`)
		const buf = generateCSV(rows, cols)
		const sizeMB = (buf.byteLength / (1024 * 1024)).toFixed(2)

		console.log(`  Data size: ${sizeMB} MB`)

		// Parity check (small scale to keep fast)
		if (rows <= 10000) {
			const oldResult = parseWithSpliterator(buf, commaDelim)
			const newResult = parseWithSearchAll(buf, commaDelim)

			if (oldResult.length !== newResult.length) {
				console.error(`  PARITY FAIL: rows ${oldResult.length} vs ${newResult.length}`)
				process.exit(1)
			}

			for (let r = 0; r < oldResult.length; r++) {
				if (oldResult[r]!.length !== newResult[r]!.length) {
					console.error(`  PARITY FAIL at row ${r}: cols ${oldResult[r]!.length} vs ${newResult[r]!.length}`)
					process.exit(1)
				}

				for (let c = 0; c < oldResult[r]!.length; c++) {
					if (oldResult[r]![c] !== newResult[r]![c]) {
						console.error(`  PARITY FAIL at [${r}][${c}]: "${oldResult[r]![c]}" vs "${newResult[r]![c]}"`)
						process.exit(1)
					}
				}
			}

			console.log(`  Parity: ${oldResult.length} rows × ${oldResult[0]!.length} cols ✓`)
		}

		// Benchmark: Spliterator approach
		const spliteratorStart = performance.now()

		parseWithSpliterator(buf, commaDelim)

		const spliteratorMs = performance.now() - spliteratorStart
		const spliteratorMBps = (buf.byteLength / (1024 * 1024)) / (spliteratorMs / 1000)

		console.log(`  Spliterator:    ${spliteratorMs.toFixed(1).padStart(8)}ms  →  ${spliteratorMBps.toFixed(1).padStart(8)} MB/s`)

		// Benchmark: searchAll approach
		const searchAllStart = performance.now()

		parseWithSearchAll(buf, commaDelim)

		const searchAllMs = performance.now() - searchAllStart
		const searchAllMBps = (buf.byteLength / (1024 * 1024)) / (searchAllMs / 1000)
		const speedup = spliteratorMs / searchAllMs

		console.log(`  searchAll:      ${searchAllMs.toFixed(1).padStart(8)}ms  →  ${searchAllMBps.toFixed(1).padStart(8)} MB/s  (${speedup.toFixed(2)}x)`)
	}

	// Summary
	console.log("\n=== Summary ===")
	console.log("Config          |  Spliterator    |  searchAll      |  Speedup")
	console.log("----------------|-----------------|-----------------|----------")

	for (const { rows, cols, label } of configs) {
		const buf = generateCSV(rows, cols)

		// Quick re-measure for summary
		const s1 = performance.now(); parseWithSpliterator(buf, commaDelim); const spliteratorMs = performance.now() - s1
		const s2 = performance.now(); parseWithSearchAll(buf, commaDelim); const searchAllMs = performance.now() - s2

		const spliteratorMBps = (buf.byteLength / (1024 * 1024)) / (spliteratorMs / 1000)
		const searchAllMBps = (buf.byteLength / (1024 * 1024)) / (searchAllMs / 1000)
		const speedup = spliteratorMs / searchAllMs

		console.log(
			`${label.padEnd(14)}  |  ${spliteratorMBps.toFixed(1).padStart(9)} MB/s  |  ${searchAllMBps.toFixed(1).padStart(9)} MB/s  |  ${speedup.toFixed(2)}x`
		)
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
