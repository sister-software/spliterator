/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

import { Readable } from "node:stream"

import { AsyncSpliterator, CharacterSequence, Spliterator } from "spliterator"
import { beforeAll, describe, expect, test } from "vitest"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function chunked(bytes: Uint8Array, size: number): AsyncIterable<Uint8Array> {
	return {
		async *[Symbol.asyncIterator]() {
			for (let i = 0; i < bytes.length; i += size) {
				yield bytes.subarray(i, Math.min(bytes.length, i + size))
			}
		},
	}
}

beforeAll(async () => {
	await CharacterSequence.whenReady()
})

describe("CharacterSequence.search against a mutating haystack", () => {
	test("sees bytes appended into the same buffer after a prior search", () => {
		const needle = new CharacterSequence("\r\n")
		const buf = new Uint8Array(8192).fill(65)

		expect(needle.search(buf, 0, 4096)).toBe(-1)

		buf[6000] = 13
		buf[6001] = 10

		expect(needle.search(buf, 0, 8192)).toBe(6000)
	})

	test("does not see bytes that were overwritten since a prior search", () => {
		const needle = new CharacterSequence("\r\n")
		const buf = new Uint8Array(8192).fill(65)
		buf[5000] = 13
		buf[5001] = 10

		expect(needle.search(buf, 0, 8192)).toBe(5000)

		buf[5000] = 65
		buf[5001] = 65

		expect(needle.search(buf, 0, 8192)).toBe(-1)
	})
})

describe("streaming engine with a multi-byte delimiter and long rows", () => {
	const rowCount = 3000
	const rows = Array.from({ length: rowCount }, (_, i) => `R${String(i).padStart(6, "0")}` + "x".repeat(1000))
	const bytes = encoder.encode(rows.join("\r\n") + "\r\n")

	for (const chunkSize of [16 * 1024, 64 * 1024]) {
		test(`reproduces every row across ${chunkSize}-byte chunks`, async () => {
			const spliterator = new AsyncSpliterator(chunked(bytes, chunkSize), { delimiter: "\r\n" })
			const out = await spliterator.toDecodedArray()

			expect(out).toHaveLength(rowCount)
			expect(out).toEqual(rows)
		})
	}
})

describe("multi-byte delimiter with records denser than the kernel's result capacity", () => {
	// More than WASM_MAX_RESULTS (4096) records per 64 KiB window and per chunk, so every scan fills the result
	// buffer and the engines must resume from the partial tail rather than skipping the rest of the window.
	const rowCount = 50_000
	const rows = Array.from({ length: rowCount }, (_, i) => String(i % 7))
	const text = rows.join("ab") + "ab"
	const bytes = encoder.encode(text)

	test("sync engine reproduces every row", () => {
		expect(Spliterator.fromSync(bytes, { delimiter: "ab", skipEmpty: false }).toDecodedArray()).toEqual([...rows, ""])
	})

	for (const chunkSize of [4096, 65_536, 100_000]) {
		test(`async engine reproduces every row across ${chunkSize}-byte chunks`, async () => {
			const spliterator = new AsyncSpliterator(chunked(bytes, chunkSize), { delimiter: "ab", skipEmpty: false })

			expect(await spliterator.toDecodedArray()).toEqual([...rows, ""])
		})
	}
})

describe("AsyncSpliterator yielded slices", () => {
	const rowCount = 40_000
	const rows = Array.from({ length: rowCount }, (_, i) => `R${String(i).padStart(6, "0")}`)
	const bytes = encoder.encode(rows.join("\n") + "\n")

	test("toArray returns rows that survive buffer compaction", async () => {
		const spliterator = new AsyncSpliterator(chunked(bytes, 4096), { delimiter: "\n" })
		const out = await spliterator.toArray()

		expect(out).toHaveLength(rowCount)
		expect(decoder.decode(out[0])).toBe("R000000")
		expect(decoder.decode(out[rowCount - 1])).toBe(`R${String(rowCount - 1).padStart(6, "0")}`)
	})
})

describe("AsyncSpliterator after return()", () => {
	test("next() reports done and does not finalize twice", async () => {
		let disposed = 0

		const source = {
			async *[Symbol.asyncIterator]() {
				yield encoder.encode("a\nb\nc\n")
			},
			[Symbol.asyncDispose]: async () => {
				disposed++
			},
		}

		const spliterator = new AsyncSpliterator(source as never, { delimiter: "\n", autoDispose: true })

		expect(decoder.decode((await spliterator.next()).value)).toBe("a")
		await spliterator.return()

		expect((await spliterator.next()).done).toBe(true)
		expect((await spliterator.next()).done).toBe(true)
		expect(disposed).toBe(1)
	})

	test("next() after asyncDispose reports done", async () => {
		const spliterator = new AsyncSpliterator(chunked(encoder.encode("a\nb\n"), 1), { delimiter: "\n" })

		expect(decoder.decode((await spliterator.next()).value)).toBe("a")
		await spliterator[Symbol.asyncDispose]()

		expect((await spliterator.next()).done).toBe(true)
	})
})

describe("AsyncSpliterator closing an unpulled stream", () => {
	test("return() before the first pull destroys the source stream", async () => {
		let destroyed = false

		const stream = new Readable({
			read() {},
			destroy(error, callback) {
				destroyed = true
				callback(error)
			},
		})

		const spliterator = new AsyncSpliterator(stream as never, { delimiter: "\n" })

		await spliterator.return()

		expect(destroyed).toBe(true)
	})
})

describe("CharacterSequence construction", () => {
	test("rejects an empty delimiter", () => {
		expect(() => new CharacterSequence("")).toThrow(TypeError)
		expect(() => new CharacterSequence(new Uint8Array(0))).toThrow(TypeError)
		expect(() => Spliterator.fromSync("abc", { delimiter: "" })).toThrow(TypeError)
	})

	test("typed-array methods produce plain Uint8Arrays", () => {
		const needle = new CharacterSequence("\r\n")

		expect(needle.slice()).toBeInstanceOf(Uint8Array)
		expect(needle.slice()).not.toBeInstanceOf(CharacterSequence)
		expect(Array.from(needle.subarray(1))).toEqual([10])
	})
})

describe("Spliterator position", () => {
	test("at the end of the source yields nothing", () => {
		expect(Spliterator.fromSync("abc", { position: 3 }).toDecodedArray()).toEqual([])
	})

	test("past the end of the source yields nothing", () => {
		expect(Spliterator.fromSync("abc", { position: 10 }).toDecodedArray()).toEqual([])
	})

	test("inside the source yields the remainder", () => {
		expect(Spliterator.fromSync("a\nbc", { position: 2 }).toDecodedArray()).toEqual(["bc"])
	})
})
