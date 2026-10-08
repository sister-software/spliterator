/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 *
 * Benchmark: columnScan "auto" (one decode, one kernel pass, sliced cells) against "rows" (decode and split per row).
 * Usage: node --expose-gc out/benchmarks/csv-column-scan.js
 *
 * Fixtures are generated in memory and written to the OS temp directory so the async path reads real files. Prints
 * Node, CPU, revision, and min/median of the repetitions; RSS growth is sampled around each run.
 *
 * Retained-cell memory keeps one cell per row and samples the heap after a GC. It runs for a short cell (`id`) and for
 * one long enough that V8 may slice it from its parent string (`name`, at least 13 characters), which is how a cell
 * from the bulk path can keep the whole decoded source alive. Without `--expose-gc` the samples are taken without a
 * collection and are noisy; the header line says which.
 */

import { execSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { cpus, tmpdir } from "node:os"
import { join } from "node:path"

import { CharacterSequence, CSVSpliterator } from "../index.js"

const REPS = 7
const encoder = new TextEncoder()
// Keeps the parsed rows observable so the engine cannot elide the work.
const sink = { n: 0 }

function csv(rows: number, quoted: boolean, unicode: boolean): Uint8Array {
	const lines = ["id,name,city,state,zip"]

	for (let i = 0; i < rows; i++) {
		const name =
			quoted && i % 4 === 0
				? `"Lovelace, Ada ""${i}"""`
				: unicode && i % 3 === 0
					? `Ada Lovelacé 한 😀 ${i}`
					: `Ada Lovelace ${i}`

		lines.push(`${i},${name},London,LDN,${10_000 + (i % 90_000)}`)
	}

	return encoder.encode(lines.join(quoted ? "\r\n" : "\n") + "\n")
}

async function time(label: string, fn: () => unknown): Promise<void> {
	await fn()

	const samples: number[] = []
	let peak = 0

	for (let i = 0; i < REPS; i++) {
		const before = process.memoryUsage().rss
		const start = process.hrtime.bigint()

		await fn()
		samples.push(Number(process.hrtime.bigint() - start) / 1e6)
		peak = Math.max(peak, process.memoryUsage().rss - before)
	}

	samples.sort((a, b) => a - b)

	console.log(
		label.padEnd(40),
		`min ${samples[0]!.toFixed(1).padStart(7)} ms`,
		`median ${samples[Math.floor(REPS / 2)]!.toFixed(1).padStart(7)} ms`,
		`rss +${(peak / 1024 / 1024).toFixed(0).padStart(4)} MB`
	)
}

function countRows(bytes: Uint8Array, init: object): void {
	for (const row of CSVSpliterator.from(bytes, init as never) as Iterable<unknown>) {
		sink.n += Array.isArray(row) ? row.length : Object.keys(row as object).length
	}
}

function firstRow(bytes: Uint8Array, columnScan: "auto" | "rows"): void {
	const rows = CSVSpliterator.from(bytes, { columnScan })

	rows.next()
	rows.return?.()
}

function firstRows(bytes: Uint8Array, columnScan: "auto" | "rows", count: number): void {
	for (const row of CSVSpliterator.from(bytes, { mode: "array", columnScan }).take(count)) {
		sink.n += row.length
	}
}

const gc = (globalThis as { gc?: () => void }).gc

function collect(): void {
	gc?.()
	gc?.()
}

// Holds the kept cells between the two heap samples. A local would do only if V8 kept it alive, and it does not: a
// local unused after the second sample is collectable there, and a stale one from the previous run can survive into
// the next run's first sample. A module-level slot, cleared before each run, avoids both.
let held: string[] | null = null

function retainedOnce(bytes: Uint8Array, columnScan: "auto" | "rows", column: number): number {
	held = null
	collect()

	const before = process.memoryUsage().heapUsed
	const kept: string[] = (held = [])

	for (const row of CSVSpliterator.from(bytes, { mode: "array", columnScan })) {
		kept.push(row[column]!)
	}

	collect()

	return process.memoryUsage().heapUsed - before
}

/**
 * Heap still held after parsing when one cell per row is kept, as the minimum over a few runs. The kept array itself (8
 * bytes a slot) is included and is the same on both paths.
 */
function retainedCells(bytes: Uint8Array, columnScan: "auto" | "rows", column: number): number {
	let least = Infinity

	for (let i = 0; i < 3; i++) {
		least = Math.min(least, retainedOnce(bytes, columnScan, column))
	}

	sink.n += held?.length ?? 0
	held = null

	return least
}

const revision = execSync("git rev-parse --short HEAD").toString().trim()

console.log(
	`node ${process.version}, ${cpus()[0]?.model ?? "unknown cpu"}, spliterator ${revision}, ${REPS} reps, ` +
		`${gc ? "heap sampled after gc" : "no --expose-gc: heap sampled without gc"}\n`
)

await CharacterSequence.whenReady()

const dir = mkdtempSync(join(tmpdir(), "spliterator-csv-"))

const fixtures: Record<string, Uint8Array> = {
	"1M plain": csv(1_000_000, false, false),
	"1M quoted crlf": csv(1_000_000, true, false),
	"1M unicode": csv(1_000_000, false, true),
	"2K (under bulk threshold)": csv(2000, false, false),
	"8K (under bulk threshold)": csv(8000, false, false),
}

for (const [name, bytes] of Object.entries(fixtures)) {
	const path = join(dir, name.replaceAll(/\W+/g, "-") + ".csv")

	writeFileSync(path, bytes)

	console.log(`— ${name}: ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB`)

	for (const columnScan of ["rows", "auto"] as const) {
		for (const mode of ["array", "object", "entries"] as const) {
			await time(`sync  ${mode.padEnd(7)} ${columnScan}`, () => countRows(bytes, { mode, columnScan }))
		}

		await time(`async object  ${columnScan}`, async () => {
			for await (const row of CSVSpliterator.fromAsync(path, { columnScan })) {
				sink.n += Object.keys(row).length
			}
		})

		await time(`sync  first row only ${columnScan}`, () => firstRow(bytes, columnScan))

		for (const count of [100, 10_000]) {
			await time(`sync  first ${count} rows ${columnScan}`, () => firstRows(bytes, columnScan, count))
		}

		await time(`sync  array trim:false ${columnScan}`, () =>
			countRows(bytes, { mode: "array", trim: false, columnScan })
		)

		for (const [label, column] of [
			["id", 0],
			["name", 1],
		] as const) {
			const bytesHeld = retainedCells(bytes, columnScan, column)

			console.log(
				`sync  retained ${label} cells ${columnScan}`.padEnd(40),
				`heap +${(bytesHeld / 1024 / 1024).toFixed(1).padStart(6)} MB`
			)
		}
	}

	console.log()
}

console.log(`checksum ${sink.n}`)
