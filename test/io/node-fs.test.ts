/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createChunkIterator, fsConcurrency, readBytes } from "spliterator/node/fs"
import { afterAll, afterEach, describe, expect, test } from "vitest"

const dir = mkdtempSync(join(tmpdir(), "spliterator-fs-"))
const file = join(dir, "abc.txt")
writeFileSync(file, "0123456789")

afterAll(async () => {
	const { rm } = await import("node:fs/promises")
	await rm(dir, { recursive: true, force: true })
})

async function collect(it: AsyncIterable<Uint8Array | string>): Promise<Uint8Array> {
	const parts: Uint8Array[] = []

	for await (const c of it) {
		parts.push(c as Uint8Array)
	}

	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
	let o = 0

	for (const p of parts) {
		out.set(p, o)
		o += p.length
	}

	return out
}

describe("createChunkIterator end bound", () => {
	test("reads only [start, end] inclusive", async () => {
		const it = await createChunkIterator(file, { start: 2, end: 5 })
		const bytes = await collect(it)

		expect(new TextDecoder().decode(bytes)).toBe("2345")
	})
})

describe("readBytes", () => {
	test("reads a window from an offset", async () => {
		const bytes = await readBytes(file, 3, 4)

		expect(new TextDecoder().decode(bytes)).toBe("3456")
	})

	test("clamps at EOF", async () => {
		const bytes = await readBytes(file, 8, 100) // file is 10 bytes

		expect(new TextDecoder().decode(bytes)).toBe("89")
	})
})

describe("fsConcurrency", () => {
	const original = process.env.UV_THREADPOOL_SIZE

	afterEach(() => {
		if (original === undefined) {
			delete process.env.UV_THREADPOOL_SIZE
		} else {
			process.env.UV_THREADPOOL_SIZE = original
		}
	})

	test("defaults to libuv's four-thread pool", () => {
		delete process.env.UV_THREADPOOL_SIZE

		expect(fsConcurrency()).toBe(4)
	})

	test("reads UV_THREADPOOL_SIZE", () => {
		process.env.UV_THREADPOOL_SIZE = "16"

		expect(fsConcurrency()).toBe(16)
	})

	test("parses like libuv's atoi", () => {
		const cases: [string, number][] = [
			["0", 1],
			["abc", 1],
			["", 1],
			["  8", 8],
			["+8", 8],
			["8abc", 8],
			["2.5", 2],
			["-3", 1024],
		]

		for (const [raw, expected] of cases) {
			process.env.UV_THREADPOOL_SIZE = raw

			expect(fsConcurrency(), JSON.stringify(raw)).toBe(expected)
		}
	})

	test("caps at libuv's maximum", () => {
		process.env.UV_THREADPOOL_SIZE = "99999"

		expect(fsConcurrency()).toBe(1024)
	})
})
