/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 * Benchmark: WASM SIMD vs JS Boyer-Moore-Horspool for multi-byte delimiter scanning.
 * Usage: node out/benchmarks/wasm-delimiter.js
 */

import { CharacterSequence, Delimiters } from "../index.js"
import type { WasmDelimiterScanner } from "../lib/wasm_module.js"

interface BenchmarkResult {
	label: string
	path: "wasm" | "bmh"
	haystackMB: number
	iterations: number
	totalMs: number
	throughputMBps: number
}

/** Generate a haystack of CRLF-delimited lines (~100 bytes each). */
function generateHaystack(sizeBytes: number): Uint8Array {
	const encoder = new TextEncoder()
	const line = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt.\r\n"
	const lineBytes = encoder.encode(line)
	const buf = new Uint8Array(sizeBytes)

	let offset = 0

	while (offset + lineBytes.length <= sizeBytes) {
		buf.set(lineBytes, offset)
		offset += lineBytes.length
	}

	if (offset < sizeBytes) {
		buf.set(lineBytes.subarray(0, sizeBytes - offset), offset)
	}

	return buf
}

/**
 * JS Boyer-Moore-Horspool search with a pre-computed skip table.
 *
 * Mirrors CharacterSequence.search's BMH path exactly.
 */
class BmhSearcher {
	readonly #skipTable: number[]
	readonly #needle: Uint8Array

	constructor(needle: Uint8Array) {
		this.#needle = needle
		this.#skipTable = new Array(256).fill(needle.length)

		for (let i = 0; i < needle.length - 1; i++) {
			this.#skipTable[needle[i]!] = needle.length - 1 - i
		}
	}

	search(haystack: Uint8Array, start: number = 0, end: number = haystack.length): number {
		const n = this.#needle.length
		let pos = start

		while (pos <= end - n) {
			let j = n - 1

			while (j >= 0 && this.#needle[j] === haystack[pos + j]) {
				j--
			}

			if (j < 0) return pos

			pos += this.#skipTable[haystack[pos + n - 1]!]!
		}

		return -1
	}
}

/** Scan entire haystack for all delimiter positions using BMH. */
function bmhScanAll(haystack: Uint8Array, searcher: BmhSearcher): number[] {
	const positions: number[] = []
	let offset = 0

	while (offset < haystack.length) {
		const found = searcher.search(haystack, offset)

		if (found < 0) break

		positions.push(found)
		offset = found + 2 // CRLF = 2 bytes
	}

	return positions
}

/** Scan entire haystack for all delimiter positions using WASM-backed CharacterSequence. */
function wasmScanAll(haystack: Uint8Array, delimiter: Uint8Array): number[] {
	const seq = new CharacterSequence(delimiter)
	const positions: number[] = []
	let offset = 0

	while (offset < haystack.length) {
		const found = seq.search(haystack, offset)

		if (found < 0) break

		positions.push(found)
		offset = found + delimiter.length
	}

	return positions
}

async function main(): Promise<void> {
	console.log("=== Spliterator WASM SIMD Benchmark ===\n")

	const crlf = new Uint8Array([Delimiters.CarriageReturn, Delimiters.LineFeed])
	const bmhSearcher = new BmhSearcher(crlf)

	// Warm up WASM: CharacterSequence.search() triggers #ensureWasm() on first
	// call with multi-byte + large haystack, which loads the module async.
	// We call it once, wait, then it's ready for all subsequent calls.
	console.log("Warming up WASM module...")
	const warmup = new Uint8Array(5000).fill(65) // 'A'

	new CharacterSequence(crlf).search(warmup)
	await new Promise((resolve) => setTimeout(resolve, 100))

	// Verify WASM loaded by checking if a second search hits the SIMD path
	// (no way to check private static field, but parity check below confirms)
	console.log("WASM warmup complete\n")

	// Parity check: both scanners must find the same positions
	console.log("Running parity check...")
	const testHaystack = generateHaystack(50_000)
	const bmhPositions = bmhScanAll(testHaystack, bmhSearcher)
	const wasmPositions = wasmScanAll(testHaystack, crlf)

	if (bmhPositions.length !== wasmPositions.length) {
		console.error(
			`PARITY FAIL: BMH=${bmhPositions.length} positions, WASM=${wasmPositions.length}`
		)
		process.exit(1)
	}

	for (let i = 0; i < bmhPositions.length; i++) {
		if (bmhPositions[i] !== wasmPositions[i]) {
			console.error(
				`PARITY FAIL at index ${i}: BMH=${bmhPositions[i]}, WASM=${wasmPositions[i]}`
			)
			process.exit(1)
		}
	}

	console.log(`Parity check: ${bmhPositions.length} positions match ✓\n`)

	// Benchmark sizes
	const sizes = [
		{ mb: 0.1, bytes: 100_000, iterations: 200 },
		{ mb: 1, bytes: 1_000_000, iterations: 50 },
		{ mb: 5, bytes: 5_000_000, iterations: 10 },
		{ mb: 10, bytes: 10_000_000, iterations: 5 },
		{ mb: 50, bytes: 50_000_000, iterations: 1 },
	]

	const results: BenchmarkResult[] = []

	for (const { mb, bytes, iterations } of sizes) {
		console.log(`\n--- Haystack: ${mb} MB, ${iterations} iteration(s) ---`)
		const haystack = generateHaystack(bytes)

		// Warm-up (1 iteration, not counted)
		bmhScanAll(haystack, bmhSearcher)

		// BMH
		const bmhStart = performance.now()

		for (let i = 0; i < iterations; i++) {
			bmhScanAll(haystack, bmhSearcher)
		}

		const bmhMs = performance.now() - bmhStart
		const bmhThroughput = (bytes * iterations) / (1024 * 1024) / (bmhMs / 1000)

		console.log(
			`  BMH (JS):      ${bmhMs.toFixed(1).padStart(8)}ms  →  ${bmhThroughput.toFixed(1).padStart(8)} MB/s`
		)

		results.push({
			label: `${mb} MB`,
			path: "bmh",
			haystackMB: mb,
			iterations,
			totalMs: bmhMs,
			throughputMBps: bmhThroughput,
		})

		// WASM
		wasmScanAll(haystack, crlf) // warm-up

		const wasmStart = performance.now()

		for (let i = 0; i < iterations; i++) {
			wasmScanAll(haystack, crlf)
		}

		const wasmMs = performance.now() - wasmStart
		const wasmThroughput = (bytes * iterations) / (1024 * 1024) / (wasmMs / 1000)
		const speedup = bmhMs / wasmMs

		console.log(
			`  WASM (SIMD):   ${wasmMs.toFixed(1).padStart(8)}ms  →  ${wasmThroughput.toFixed(1).padStart(8)} MB/s  (${speedup.toFixed(2)}x)`
		)

		results.push({
			label: `${mb} MB`,
			path: "wasm",
			haystackMB: mb,
			iterations,
			totalMs: wasmMs,
			throughputMBps: wasmThroughput,
		})
	}

	// Summary
	console.log("\n=== Summary ===")
	console.log("Haystack   |  BMH (MB/s)  |  WASM (MB/s)  |  Speedup")
	console.log("-----------|--------------|---------------|----------")

	for (const { mb } of sizes) {
		const bmh = results.find((r) => r.path === "bmh" && r.haystackMB === mb)
		const wasm = results.find((r) => r.path === "wasm" && r.haystackMB === mb)

		if (bmh && wasm) {
			const speedup = bmh.totalMs / wasm.totalMs

			console.log(
				`${String(mb).padStart(6)} MB  |  ${bmh.throughputMBps.toFixed(1).padStart(8)}  |  ${wasm.throughputMBps.toFixed(1).padStart(9)}  |  ${speedup.toFixed(2)}x`
			)
		}
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
