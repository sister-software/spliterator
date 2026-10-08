/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createChunkIterator, readBytes } from "spliterator/node/fs"
import { afterAll, describe, expect, test } from "vitest"

const dir = mkdtempSync(join(tmpdir(), "spliterator-reader-"))
const file = join(dir, "abc.txt")
writeFileSync(file, "0123456789")

afterAll(async () => {
	const { rm } = await import("node:fs/promises")
	await rm(dir, { recursive: true, force: true })
})

async function collect(it: AsyncIterable<Uint8Array | string>): Promise<Uint8Array> {
	const parts: Uint8Array[] = []

	for await (const chunk of it) {
		parts.push(chunk as Uint8Array)
	}

	const output = new Uint8Array(parts.reduce((length, part) => length + part.length, 0))
	let offset = 0

	for (const part of parts) {
		output.set(part, offset)
		offset += part.length
	}

	return output
}

describe("createChunkIterator", () => {
	test("reads only [start, end] inclusive", async () => {
		const iterator = await createChunkIterator(file, { start: 2, end: 5 })
		const bytes = await collect(iterator)

		expect(new TextDecoder().decode(bytes)).toBe("2345")
	})
})

describe("readBytes", () => {
	test("reads a window from an offset", async () => {
		const bytes = await readBytes(file, 3, 4)

		expect(new TextDecoder().decode(bytes)).toBe("3456")
	})

	test("clamps at EOF", async () => {
		const bytes = await readBytes(file, 8, 100)

		expect(new TextDecoder().decode(bytes)).toBe("89")
	})
})
