/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

import { test } from "vitest"

import { renderTable, renderTables, type SweepResult } from "../../benchmarks/udsv/render.ts"

const result = (overrides: Partial<SweepResult>): SweepResult => ({
	data: "a.csv",
	mib: 2,
	name: "x",
	gmean_ms: 10,
	mibs: 200,
	rss_mib: 10,
	rows: 1000,
	error: null,
	...overrides,
})

test("renderTable sorts fastest first, scales bars per column, and lists errors last", ({ expect }) => {
	const table = renderTable([
		result({ name: "slow", mibs: 100, rss_mib: 5 }),
		result({ name: "fast", mibs: 200, rss_mib: 10 }),
		result({ name: "broken", mibs: null, gmean_ms: null, rss_mib: null, rows: null, error: "Wrong row count!" }),
	])

	const lines = table.split("\n")

	expect(lines[0]).toBe("**a.csv (2 MiB, 1K rows), in-memory string**")
	expect(lines[1]).toBe("")
	expect(lines[2]).toMatch(/^\| Name\s+\| Throughput \(MiB\/s\)\s+\| Peak RSS above baseline \(MiB\)\s+\|$/)
	expect(lines[3]).toMatch(/^\| -+ \| -+ \| -+ \|$/)
	expect(lines[4]).toMatch(/^\| fast\s+\| ░{40} 200\s+\| ░{40} 10\s+\|$/)
	expect(lines[5]).toMatch(/^\| slow\s+\| ░{20} 100\s+\| ░{20} 5\s+\|$/)
	expect(lines[6]).toContain("broken")
	expect(lines[6]).toContain("Wrong row count!")
	expect(new Set(lines.slice(2).map((line) => line.length)).size).toBe(1)
})

test("renderTable reports sizes past a GiB in GiB", ({ expect }) => {
	expect(renderTable([result({ mib: 1454.2, rows: 2 })]).split("\n")[0]).toBe("**a.csv (1.42 GiB), in-memory string**")
})

test("renderTables groups by dataset and mode in first-seen order", ({ expect }) => {
	const out = renderTables([
		result({ data: "b.csv" }),
		result({ data: "a.csv" }),
		result({ data: "b.csv", name: "y (stream)" }),
		result({ data: "b.csv", name: "z" }),
	])

	// Each table opens with its bold caption; the blank line after a caption is not a table break.
	const tables = out.split(/\n\n(?=\*\*)/)

	expect(tables).toHaveLength(3)
	expect(tables[0]).toContain("b.csv")
	expect(tables[0]).toContain("in-memory string")
	expect(tables[0]).toContain("| z")
	expect(tables[1]).toContain("a.csv")
	expect(tables[2]).toContain("streamed from file")
	expect(tables[2]).toContain("| y (stream)")
})
