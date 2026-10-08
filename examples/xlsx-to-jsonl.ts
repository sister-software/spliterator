/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

/**
 * Convert an XLSX workbook to JSONL, typing columns on the way through.
 *
 * The workbook is the UN World Population Prospects 2024 "Demographic Indicators (compact)" release — 26 MB, two sheets
 * of ~22,900 rows × 65 typed columns, one row per region/country per year. It downloads once into `examples/data/`
 * (gitignored) and is reused after that.
 *
 * Usage: node examples/xlsx-to-jsonl.ts [output.jsonl] [--sheet "Medium variant"]
 *
 * Note that unlike the byte-level spliterators, XLSX parsing materializes the whole workbook in memory — the output
 * JSONL, by contrast, streams back in bounded memory.
 *
 * Data: United Nations, DESA, Population Division (2024). World Population Prospects 2024, Online Edition. CC BY 3.0
 * IGO.
 */

import { createWriteStream } from "node:fs"
import { stat } from "node:fs/promises"
import { pipeline } from "node:stream/promises"
import { parseArgs } from "node:util"

import { normalizeColumnNames, XLSXSpliterator } from "spliterator"

const WPP_URL =
	"https://population.un.org/wpp/assets/Excel%20Files/1_Indicator%20(Standard)/EXCEL_FILES/1_General/WPP2024_GEN_F01_DEMOGRAPHIC_INDICATORS_COMPACT.xlsx"

// The release is unversioned at the URL, so the byte count is a cheap guard that the file we got is the file we
// wrote the column handling for. A new revision changes it and fails loudly here rather than in the transformers.
const WPP_BYTES = 26_142_942
const WPP_PATH = new URL("./data/WPP2024_GEN_F01_DEMOGRAPHIC_INDICATORS_COMPACT.xlsx", import.meta.url)
// Rows above the header are the UN's title block and citation.
const PREAMBLE_ROWS = 16

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: { sheet: { type: "string", default: "Estimates" } },
})

const [outputPath = "examples/data/wpp-population.jsonl"] = positionals

/**
 * Download the workbook once, verifying the byte count both before (the response header) and after (the file on disk)
 * so a truncated or revised download never masquerades as the expected one.
 */
async function ensureWorkbook(): Promise<URL> {
	const size = await stat(WPP_PATH).then(
		(s) => s.size,
		() => 0
	)

	if (size === WPP_BYTES) return WPP_PATH

	console.error(`Downloading ${(WPP_BYTES / 1e6).toFixed(1)} MB from population.un.org…`)

	const response = await fetch(WPP_URL)

	if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`)

	const announced = Number(response.headers.get("content-length"))

	if (announced !== WPP_BYTES) {
		throw new Error(
			`Expected ${WPP_BYTES} bytes but the server announced ${announced}; the WPP release may have changed`
		)
	}

	await pipeline(response.body, createWriteStream(WPP_PATH))

	const written = (await stat(WPP_PATH)).size

	if (written !== WPP_BYTES) throw new Error(`Download truncated: ${written} of ${WPP_BYTES} bytes`)

	return WPP_PATH
}

const workbook = await ensureWorkbook()

// The sheet has a title block above its header, so read raw rows and take the header ourselves: the first row past
// the preamble names the columns, and every row after it is data.
const rows = XLSXSpliterator.fromAsync(workbook, { sheet: values.sheet, header: false }).drop(PREAMBLE_ROWS)
const header = await rows.take(1).toArray()

// `take` closed that sequence; open a fresh one positioned past the header for the data.
const data = XLSXSpliterator.fromAsync(workbook, { sheet: values.sheet, header: false }).drop(PREAMBLE_ROWS + 1)

if (!header[0]) throw new Error(`No header row found in sheet "${values.sheet}"`)

const keys = normalizeColumnNames(header[0].map((cell) => String(cell ?? "")))
const output = createWriteStream(outputPath)

let count = 0

const records = data
	.map((cells) => Object.fromEntries(keys.map((key, i) => [key, cells[i] ?? null])))
	// Aggregates (World, SDG regions, income groups) share the sheet with countries; keep the countries.
	.filter((record) => record.type === "Country/Area")

for await (const record of records) {
	count++

	if (!output.write(JSON.stringify(record) + "\n")) {
		await new Promise((resolve) => {
			output.once("drain", resolve)
		})
	}
}

await new Promise((resolve) => {
	output.end(resolve)
})

console.log(`Wrote ${count} country-year records from sheet "${values.sheet}" to ${outputPath}`)
