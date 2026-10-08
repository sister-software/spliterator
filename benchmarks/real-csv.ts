/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 * Benchmark Spliterator against a real CSV without materializing the input.
 *
 * Usage: node out/benchmarks/real-csv.js <path> [repetitions]
 */

import { stat } from "node:fs/promises"

import { AsyncSpliterator, CharacterSequence, Delimiters } from "../index.js"

interface Result {
	label: string
	rows: number
	payloadBytes: number
	milliseconds: number
	mebibytesPerSecond: number
	rowsPerSecond: number
}

const sourceArgument = process.argv[2]

if (!sourceArgument) {
	console.error("Usage: node out/benchmarks/real-csv.js <path> [repetitions]")

	process.exit(1)
}

const source = sourceArgument

const repetitions = Number.parseInt(process.argv[3] ?? "3", 10)

if (!Number.isSafeInteger(repetitions) || repetitions < 1) {
	throw new RangeError("repetitions must be a positive integer")
}

const sourceBytes = (await stat(source)).size
const wasmReady = await CharacterSequence.whenReady()

async function benchmarkRows(enableQuoteHandling: boolean): Promise<Result> {
	const rows = await AsyncSpliterator.from(source, {
		delimiter: Delimiters.LineFeed,
		skipEmpty: false,
		crlf: true,
		enableQuoteHandling,
	})

	let rowCount = 0
	let payloadBytes = 0
	const start = performance.now()

	for await (const row of rows) {
		rowCount++
		payloadBytes += row.byteLength
	}

	const milliseconds = performance.now() - start
	const seconds = milliseconds / 1000

	return {
		label: enableQuoteHandling ? "native range scan (quotes)" : "native range scan",
		rows: rowCount,
		payloadBytes,
		milliseconds,
		mebibytesPerSecond: sourceBytes / 1024 / 1024 / seconds,
		rowsPerSecond: rowCount / seconds,
	}
}

console.log(JSON.stringify({ source, sourceBytes, repetitions, wasmReady }))

for (let repetition = 1; repetition <= repetitions; repetition++) {
	for (const enableQuoteHandling of [false, true]) {
		console.log(JSON.stringify({ repetition, ...(await benchmarkRows(enableQuoteHandling)) }))
	}
}
