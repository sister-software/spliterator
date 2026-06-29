/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { AsyncSpliterator, TextSpliterator } from "spliterator"
import { afterAll, describe, expect, test } from "vitest"

const dir = mkdtempSync(join(tmpdir(), "spliterator-many-"))
afterAll(async () => (await import("node:fs/promises")).rm(dir, { recursive: true, force: true }))

const text = Array.from({ length: 5000 }, (_, i) => `row-${i}-data`).join("\n") + "\n"
const file = join(dir, "rows.txt")
writeFileSync(file, text)

async function flatten(spliterators: AsyncSpliterator[]): Promise<string[]> {
	const dec = new TextDecoder()
	const out: string[] = []

	for (const s of spliterators) for await (const row of s) out.push(dec.decode(row))

	return out
}

describe("asMany", () => {
	for (const concurrency of [1, 4, 9]) {
		test(`parity with sequential parse at concurrency ${concurrency}`, async () => {
			const oracle: string[] = []

			for await (const line of TextSpliterator.fromAsync(file)) oracle.push(line)

			const spliterators = await AsyncSpliterator.asMany(file, { delimiter: "\n", concurrency })
			expect(spliterators.length).toBeLessThanOrEqual(concurrency)

			const got = await flatten(spliterators)
			expect(got).toEqual(oracle)
		})
	}
})
