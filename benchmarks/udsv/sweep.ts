/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 *
 * Run uDSV's benchmark harness over spliterator and a few of the parsers it ships adapters for, and write the
 * results to `benchmarks/udsv/results.json` for `render.ts`.
 *
 * The harness, its competitor adapters, and its timing metric (geometric mean over three-second cycles, MiB/s) are
 * uDSV's own and run unmodified; this script only spawns `bench/runone.cjs` and collects its JSON. One generated
 * copy of that runner skips reading the file into a string so the streaming count adapters can take a file past
 * V8's string limit.
 *
 * Memory is measured here rather than taken from the harness, whose figure is the largest RSS step between timing
 * cycles and so reads zero for a parser that allocates its working set on the first parse. Each run goes through
 * GNU `time`, and the child's peak RSS less the baseline the runner reports before loading the parser is recorded.
 * For an in-memory run that includes the input string, which every parser is handed alike; for a count run it is
 * the parser's own footprint.
 *
 * Setup:
 *
 *     git clone https://github.com/leeoniya/uDSV ../uDSV
 *     (cd ../uDSV && npm install && npm run build && cd bench && npm install && node litmus_gen.cjs)
 *     yarn compile
 *
 * Usage: node out/benchmarks/udsv/sweep.js [--udsv=../uDSV] [--memory] [--stream] <csv path>...
 *
 * `--memory` runs the in-memory string parsers, `--stream` the file-streaming ones; both by default. A dataset
 * without an entry in uDSV's `bench/expected.json` gets one computed by uDSV itself when it fits in a string, and
 * runs with verification off when it does not. Dataset paths are resolved from the current directory and linked into
 * the harness's data directory, because the harness keys expectations on the file name. Results merge into
 * `results.json` per dataset, so a later sweep over one file refreshes only its tables.
 */

import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { parseArgs } from "node:util"

import type { SweepResult } from "./render.ts"

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		udsv: { type: "string", default: "../uDSV" },
		memory: { type: "boolean", default: false },
		stream: { type: "boolean", default: false },
	},
})

const udsvRoot = resolve(values.udsv)
const bench = resolve(udsvRoot, "bench")
const adapters = new URL("./adapters/", import.meta.url).pathname
const runMemory = values.memory || !values.stream
const runStream = values.stream || !values.memory

if (!existsSync(resolve(bench, "runone.cjs"))) {
	console.error(`No uDSV bench at ${bench}. See the setup notes at the top of this script.`)

	process.exit(1)
}

if (!positionals.length) {
	console.error("Usage: node out/benchmarks/udsv/sweep.js [--udsv=../uDSV] [--memory] [--stream] <csv path>...")

	process.exit(1)
}

/**
 * V8 refuses strings above this many bytes, so larger files only stream.
 */
const STRING_LIMIT = 512 * 1024 * 1024

const memoryParsers = [
	adapters + "spliterator-memory.js",
	"./non-streaming/untyped/uDSV.cjs",
	"./non-streaming/untyped/PapaParse.cjs",
	"./non-streaming/untyped/csv-simple-parser.cjs",
	"./non-streaming/untyped/d3-dsv.cjs",
	"./non-streaming/untyped/but-csv.cjs",
]

const retainedParsers = [
	adapters + "spliterator-stream.js",
	"./streaming/untyped/retained/uDSV.cjs",
	"./streaming/untyped/retained/PapaParse.cjs",
]

const countParsers = [
	adapters + "spliterator-count.js",
	adapters + "spliterator-rows-count.js",
	adapters + "spliterator-parallel-count.js",
	adapters + "udsv-count.js",
	adapters + "papaparse-count.js",
]

// The runner reads the whole file into a string unless the adapter path says otherwise. The count adapters never
// need it, and the largest files cannot provide it, so a generated copy of the runner widens that test.
const peakFile = join(mkdtempSync(join(tmpdir(), "udsv-sweep-")), "peak")

const runner = readFileSync(resolve(bench, "runone.cjs"), "utf8")
const streamingRunner = resolve(bench, "runone-streaming.generated.cjs")

writeFileSync(
	streamingRunner,
	runner.replace("!parserMod.includes('/streaming/non-retained')", "!/non-retained|-count\\.js$/.test(parserMod)")
)

const expectedPath = resolve(bench, "expected.json")
const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as Record<string, { rows: number; cols: number }>
const require = createRequire(udsvRoot + "/")

interface UDSV {
	inferSchema: (chunk: string) => unknown
	initParser: (schema: unknown) => { stringArrs: (text: string) => string[][] }
}

const datasets = positionals.map((argument) => {
	const source = resolve(argument)
	const name = basename(source)
	const link = resolve(bench, "data", name)
	const size = statSync(source).size

	// A dataset already in the harness's data directory, such as the generated litmus files, needs no link.
	if (source !== link) {
		if (existsSync(link)) {
			unlinkSync(link)
		}

		symlinkSync(source, link)
	}

	if (!expected[name]) {
		if (size <= STRING_LIMIT) {
			const { inferSchema, initParser } = require("./dist/uDSV.cjs.js") as UDSV
			const text = readFileSync(source, "utf8")
			const rows = initParser(inferSchema(text)).stringArrs(text)

			// uDSV drops the header row and the harness accepts a count up to two below the expectation, so an
			// expectation one above uDSV's count admits both it and parsers that keep the header.
			expected[name] = { rows: rows.length + 1, cols: rows[0]!.length }
		} else {
			expected[name] = { rows: 0, cols: 0 }
		}

		writeFileSync(expectedPath, JSON.stringify(expected, null, 2))
	}

	return { name, size, fitsString: size <= STRING_LIMIT }
})

const results: SweepResult[] = []

function run(dataset: (typeof datasets)[number], parser: string, verify: boolean) {
	const counting = countParsers.includes(parser)

	const result = spawnSync(
		"/usr/bin/time",
		[
			"-f",
			"%M",
			"-o",
			peakFile,
			process.execPath,
			"--max-old-space-size=20000",
			counting ? streamingRunner : "./bench/runone.cjs",
			`--data=./bench/data/${dataset.name}`,
			`--parser=${parser}`,
			`--verify=${verify ? 1 : 0}`,
		],
		{ cwd: udsvRoot, env: { ...process.env, UDSV_ROOT: udsvRoot }, maxBuffer: 1 << 28 }
	)

	let parsed: { gmean: number | null; rssBase: number | null; rows: number | null; error: string | null }

	try {
		parsed = JSON.parse(result.stdout.toString().trim())
	} catch {
		parsed = { gmean: null, rssBase: null, rows: null, error: "crash: " + result.stderr.toString().slice(-200).trim() }
	}

	// GNU time reports the peak resident set in KiB.
	const peakKiB = Number(readFileSync(peakFile, "utf8").trim().split("\n").pop())

	const peakAboveBaseline =
		parsed.gmean === null || parsed.rssBase === null ? null : peakKiB / 1024 - parsed.rssBase / 1_048_576

	const name = (require(parser.startsWith("/") ? parser : resolve(bench, parser)) as { name: string }).name
	const mib = dataset.size / 1_048_576

	const row: SweepResult = {
		data: dataset.name,
		mib: +mib.toFixed(1),
		name,
		gmean_ms: parsed.gmean === null ? null : +parsed.gmean.toFixed(1),
		mibs: parsed.gmean === null ? null : +(mib / (parsed.gmean / 1e3)).toFixed(1),
		rss_mib: peakAboveBaseline === null ? null : +peakAboveBaseline.toFixed(0),
		rows: parsed.rows,
		error: parsed.error,
	}

	results.push(row)

	console.log(JSON.stringify(row))
}

for (const dataset of datasets) {
	if (runMemory && dataset.fitsString) {
		for (const parser of memoryParsers) {
			run(dataset, parser, true)
		}
	}

	if (runStream) {
		if (dataset.fitsString) {
			for (const parser of retainedParsers) {
				run(dataset, parser, true)
			}
		}

		for (const parser of countParsers) {
			run(dataset, parser, false)
		}
	}
}

// Results merge per dataset, so a sweep over one file refreshes its tables and leaves the rest alone.
const out = new URL("../../../benchmarks/udsv/results.json", import.meta.url).pathname
const swept = new Set(datasets.map((dataset) => dataset.name))

const kept = existsSync(out)
	? (JSON.parse(readFileSync(out, "utf8")) as SweepResult[]).filter((result) => !swept.has(result.data))
	: []

writeFileSync(out, JSON.stringify([...kept, ...results], null, 2) + "\n")

console.log(`Wrote ${results.length} results to ${out}`)
