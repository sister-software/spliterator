/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createNewlineWriter, TextSpliterator } from "spliterator"
import { afterAll, describe, expect, test } from "vitest"

const dir = mkdtempSync(join(tmpdir(), "spliterator-writer-"))

afterAll(async () => {
	const { rm } = await import("node:fs/promises")
	await rm(dir, { recursive: true, force: true })
})

describe("createNewlineWriter", () => {
	test("delimits each write with a newline", async () => {
		const file = join(dir, "lines.txt")

		{
			await using out = createNewlineWriter(file)
			await out.write("alpha")
			await out.write("beta")
			await out.write("gamma")
		}

		expect(readFileSync(file, "utf8")).toBe("alpha\nbeta\ngamma\n")
	})

	test("round-trips through a spliterator", async () => {
		const file = join(dir, "roundtrip.txt")
		const rows = ["350 5th Ave", "1600 Pennsylvania Ave NW", "400 Broad St"]

		{
			await using out = createNewlineWriter(file)

			for (const row of rows) await out.write(row)
		}

		expect(Array.from(TextSpliterator.from(readFileSync(file)))).toEqual(rows)
	})

	test("delimits chunk writes given an explicit encoding", async () => {
		const file = join(dir, "encoded.txt")

		{
			await using out = createNewlineWriter(file)
			await out.write(Buffer.from("héllo"), "utf8")
			await out.write(Buffer.from("wörld"), "utf8")
		}

		expect(readFileSync(file, "utf8")).toBe("héllo\nwörld\n")
	})

	test("writes an empty file when nothing is written", async () => {
		const file = join(dir, "empty.txt")

		{
			await using out = createNewlineWriter(file)
		}

		expect(readFileSync(file, "utf8")).toBe("")
	})

	test("an empty line is still a line", async () => {
		const file = join(dir, "blank.txt")

		{
			await using out = createNewlineWriter(file)
			await out.write("a")
			await out.write("")
			await out.write("b")
		}

		expect(readFileSync(file, "utf8")).toBe("a\n\nb\n")
	})
})
