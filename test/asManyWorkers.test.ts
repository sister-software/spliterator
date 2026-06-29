/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { AsyncSpliterator } from "spliterator"
import { afterAll, describe, expect, test } from "vitest"

const dir = mkdtempSync(join(tmpdir(), "spliterator-workers-"))
afterAll(async () => (await import("node:fs/promises")).rm(dir, { recursive: true, force: true }))

const handlerDir = fileURLToPath(new URL("./fixtures/segment-handlers/", import.meta.url))
const text = Array.from({ length: 5000 }, (_, i) => `row-${i}`).join("\n") + "\n"
const file = join(dir, "rows.txt")
writeFileSync(file, text)

describe("asManyWorkers", () => {
	test("parity with the sequential transform (results back to main)", async () => {
		const oracle = text
			.split("\n")
			.filter(Boolean)
			.map((s) => s.toUpperCase())
			.sort()

		const got: string[] = []

		for await (const r of AsyncSpliterator.asManyWorkers<string>(file, {
			worker: join(handlerDir, "uppercase.js"),
			delimiter: "\n",
			concurrency: 4,
		})) {
			got.push(r)
		}

		expect(got.sort()).toEqual(oracle) // interleaved across segments → compare as sets
	})

	test("Uint8Array results survive the transfer path", async () => {
		const dec = new TextDecoder()
		const lines: string[] = []

		for await (const bytes of AsyncSpliterator.asManyWorkers<Uint8Array>(file, {
			worker: join(handlerDir, "to-json-bytes.js"),
			delimiter: "\n",
			concurrency: 4,
		})) {
			lines.push(dec.decode(bytes).trim())
		}

		expect(lines).toHaveLength(5000)
		expect(JSON.parse(lines[0]!)).toHaveProperty("line")
	})

	test("rejects on a non-path source", () => {
		expect(() =>
			AsyncSpliterator.asManyWorkers((async function* () {})() as never, { worker: "x", concurrency: 2 })
		).toThrow(TypeError)
	})

	test("a throwing handler rejects the iterator", async () => {
		await expect(
			(async () => {
				for await (const _ of AsyncSpliterator.asManyWorkers(file, {
					worker: join(handlerDir, "throws.js"),
					delimiter: "\n",
					concurrency: 2,
				}))
					void _
			})()
		).rejects.toThrow(/boom/)
	})
})
