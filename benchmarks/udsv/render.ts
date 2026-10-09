/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 *
 * Render `results.json` from `sweep.ts` as Markdown tables with the text bars uDSV's README uses, one table per
 * dataset and mode, ready to paste into README.md.
 *
 * Usage: node out/benchmarks/udsv/render.js [results.json]
 */

import { readFileSync } from "node:fs"

/**
 * One parser's run over one dataset, as `sweep.ts` records it. Timing fields are `null` when the harness reported an
 * error instead of timing the parser.
 */
export interface SweepResult {
	data: string
	mib: number
	name: string
	gmean_ms: number | null
	mibs: number | null
	rss_mib: number | null
	rows: number | null
	error: string | null
}

/**
 * Which of the harness's two modes a result came from: parsing a string already in memory, or streaming the file. The
 * streaming adapters carry "stream" in their name, as uDSV's own do.
 */
export function modeOf(result: SweepResult): "memory" | "stream" {
	return result.name.includes("(stream") ? "stream" : "memory"
}

const BAR_WIDTH = 40

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 3 })
const formatNumber = (value: number) => compact.format(value)

function bar(value: number, max: number): string {
	const blocks = max > 0 ? Math.round((value / max) * BAR_WIDTH) : 0

	return "░".repeat(blocks) + " " + formatNumber(value)
}

function table(caption: string, columns: string[], rows: string[][]): string {
	const widths = columns.map((column, i) => Math.max(column.length, ...rows.map((row) => row[i]!.length)))
	const line = (cells: string[]) => "| " + cells.map((cell, i) => cell.padEnd(widths[i]!)).join(" | ") + " |"

	return [
		`**${caption}**`,
		"",
		line(columns),
		"| " + widths.map((width) => "-".repeat(width)).join(" | ") + " |",
		...rows.map(line),
	].join("\n")
}

/**
 * One table for the given results, which must share a dataset and a mode. Errored parsers are listed last with the
 * error in place of their bars; timed parsers are sorted fastest first. Bars scale to the largest value in each column,
 * so the memory bars read relative to the hungriest parser on that table.
 */
export function renderTable(results: SweepResult[]): string {
	const first = results[0]

	if (!first) throw new TypeError("renderTable needs at least one result")

	const timed = results.filter((r) => r.mibs !== null).toSorted((a, b) => b.mibs! - a.mibs!)
	const failed = results.filter((r) => r.mibs === null)
	const maxMibs = Math.max(0, ...timed.map((r) => r.mibs!))
	const maxRss = Math.max(0, ...timed.map((r) => r.rss_mib ?? 0))
	const rowCount = timed.find((r) => r.rows !== null && r.rows > 2)?.rows

	const mode = modeOf(first) === "memory" ? "in-memory string" : "streamed from file"
	const size = first.mib >= 1024 ? `${(first.mib / 1024).toFixed(2)} GiB` : `${formatNumber(first.mib)} MiB`
	const header = `${first.data} (${size}${rowCount ? `, ${formatNumber(rowCount)} rows` : ""}), ${mode}`

	const rows = [
		...timed.map((r) => [r.name, bar(r.mibs!, maxMibs), bar(r.rss_mib ?? 0, maxRss)]),
		...failed.map((r) => [r.name, r.error ?? "error", ""]),
	]

	return table(header, ["Name", "Throughput (MiB/s)", "Peak RSS above baseline (MiB)"], rows)
}

/**
 * One table per dataset and mode, in first-seen order, separated by a blank line.
 */
export function renderTables(results: SweepResult[]): string {
	const groups = new Map<string, SweepResult[]>()

	for (const result of results) {
		const key = result.data + "\0" + modeOf(result)
		const group = groups.get(key) ?? []

		group.push(result)
		groups.set(key, group)
	}

	return [...groups.values()].map(renderTable).join("\n\n")
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
	const path = process.argv[2] ?? new URL("../../../benchmarks/udsv/results.json", import.meta.url).pathname
	const results = JSON.parse(readFileSync(path, "utf8")) as SweepResult[]

	console.log(renderTables(results))
}
