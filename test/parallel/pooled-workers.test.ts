/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 *
 * The pooled path with real threads. `worker-pool.test.ts` covers the pool's mechanics against fakes;
 * this is the only place the pooled wire protocol actually runs in a worker.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { AsyncSpliterator, parallelMapWorkers, WorkerPool } from "spliterator"
import { afterAll, describe, expect, test } from "vitest"

const dir = mkdtempSync(join(tmpdir(), "spliterator-pool-"))
afterAll(async () => (await import("node:fs/promises")).rm(dir, { recursive: true, force: true }))

const segmentHandlers = fileURLToPath(new URL("../fixtures/segment-handlers/", import.meta.url))
const parallelHandlers = fileURLToPath(new URL("../fixtures/parallel-handlers/", import.meta.url))

const text = Array.from({ length: 5000 }, (_, i) => `row-${i}`).join("\n") + "\n"
const file = join(dir, "rows.txt")
writeFileSync(file, text)

const oracle = text
	.split("\n")
	.filter(Boolean)
	.map((line) => line.toUpperCase())
	.toSorted()

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = []

	for await (const value of iterable) {
		out.push(value)
	}

	return out
}

/**
 * Collect while watching the pool. `peakLeased` is the assertion that binds these tests to the pooled path — every
 * other expectation here is equally satisfied by spawn-per-call, as a mutation that ignored the pool proved by leaving
 * 9 of 10 green.
 */
async function collectWatching<T>(
	pool: WorkerPool,
	iterable: AsyncIterable<T>
): Promise<{ out: T[]; peakLeased: number }> {
	const out: T[] = []
	let peakLeased = 0

	for await (const value of iterable) {
		out.push(value)

		if (pool.leased > peakLeased) {
			peakLeased = pool.leased
		}
	}

	return { out, peakLeased }
}

describe("pooled asManyWorkers", () => {
	test("parity with the unpooled path", async () => {
		await using pool = new WorkerPool({ size: 4 })

		const { out, peakLeased } = await collectWatching(
			pool,
			AsyncSpliterator.asManyWorkers<string>(file, {
				worker: join(segmentHandlers, "uppercase.js"),
				delimiter: "\n",
				concurrency: 4,
				pool,
			})
		)

		expect(out.toSorted(), "Interleaved across segments, so compared as sets").toEqual(oracle)
		expect(peakLeased, "The records actually came from pooled workers").toBeGreaterThan(0)
	})

	test("a second call reuses the same warm workers", async () => {
		await using pool = new WorkerPool({ size: 4 })

		const first = await collect(
			AsyncSpliterator.asManyWorkers<string>(file, {
				worker: join(segmentHandlers, "uppercase.js"),
				delimiter: "\n",
				concurrency: 4,
				pool,
			})
		)

		expect(pool.leased, "Every lease was returned").toBe(0)

		const second = await collect(
			AsyncSpliterator.asManyWorkers<string>(file, {
				worker: join(segmentHandlers, "uppercase.js"),
				delimiter: "\n",
				concurrency: 4,
				pool,
			})
		)

		expect(first.toSorted(), "First call correct").toEqual(oracle)
		expect(second.toSorted(), "Second call correct on reused workers").toEqual(oracle)
	})

	// The headline reason to pool: a handler's top-level initialisation is paid once per worker, not
	// once per call. The observable consequence is that its state survives between calls.
	test("handler module state persists across calls", async () => {
		await using pool = new WorkerPool({ size: 1 })

		const runOnce = () =>
			collect(
				AsyncSpliterator.asManyWorkers<number>(file, {
					worker: join(segmentHandlers, "call-counter.js"),
					delimiter: "\n",
					concurrency: 1,
					pool,
				})
			)

		const first = await runOnce()
		const second = await runOnce()

		expect(Math.min(...first), "The first call starts from a fresh module").toBe(1)

		expect(Math.min(...second), "The second call continues the first's count rather than restarting").toBeGreaterThan(
			Math.max(...first) - 1
		)
	})

	test("a pool smaller than concurrency still parses every record", async () => {
		await using pool = new WorkerPool({ size: 2 })

		const { out, peakLeased } = await collectWatching(
			pool,
			AsyncSpliterator.asManyWorkers<string>(file, {
				worker: join(segmentHandlers, "uppercase.js"),
				delimiter: "\n",
				concurrency: 6,
				pool,
			})
		)

		expect(out.toSorted(), "Segments queue onto the two workers").toEqual(oracle)
		expect(peakLeased, "Never more leases than the pool holds").toBeGreaterThan(0)
		expect(peakLeased, "Six segments never exceed the pool of two").toBeLessThanOrEqual(2)
	})

	test("Uint8Array results survive the pooled transfer path", async () => {
		await using pool = new WorkerPool({ size: 3 })
		const decoder = new TextDecoder()

		const got = await collect(
			AsyncSpliterator.asManyWorkers<Uint8Array>(file, {
				worker: join(segmentHandlers, "to-json-bytes.js"),
				delimiter: "\n",
				concurrency: 3,
				pool,
			})
		)

		expect(got).toHaveLength(5000)
		expect(JSON.parse(decoder.decode(got[0]!).trim())).toHaveProperty("line")
	})

	test("a throwing handler rejects and leaves the pool usable", async () => {
		await using pool = new WorkerPool({ size: 2 })

		await expect(
			collect(
				AsyncSpliterator.asManyWorkers(file, {
					worker: join(segmentHandlers, "throws.js"),
					delimiter: "\n",
					concurrency: 2,
					pool,
				})
			),
			"The failure surfaces"
		).rejects.toThrow(/boom|handler/i)

		expect(pool.leased, "Leases are returned even on failure").toBe(0)

		const recovered = await collect(
			AsyncSpliterator.asManyWorkers<string>(file, {
				worker: join(segmentHandlers, "uppercase.js"),
				delimiter: "\n",
				concurrency: 2,
				pool,
			})
		)

		expect(recovered.toSorted(), "The pool still serves work afterwards").toEqual(oracle)
	})

	test("workerData alongside a pool is rejected rather than silently dropped", async () => {
		await using pool = new WorkerPool({ size: 1 })

		await expect(
			collect(
				AsyncSpliterator.asManyWorkers(file, {
					worker: join(segmentHandlers, "uppercase.js"),
					delimiter: "\n",
					concurrency: 1,
					pool,
					workerData: { nope: true },
				})
			)
		).rejects.toThrow(/workerData cannot be combined with `pool`|`workerData` cannot be combined/)
	})
})

describe("pooled parallelMapWorkers", () => {
	test("parity with the unpooled path", async () => {
		await using pool = new WorkerPool({ size: 3 })

		const { out, peakLeased } = await collectWatching(
			pool,
			parallelMapWorkers<number, number>([1, 2, 3, 4, 5, 6, 7, 8], {
				worker: join(parallelHandlers, "double.js"),
				concurrency: 3,
				pool,
			})
		)

		expect(out.toSorted((a, b) => a - b)).toEqual([2, 4, 6, 8, 10, 12, 14, 16])
		expect(peakLeased, "The mapping actually ran on pooled workers").toBeGreaterThan(0)
		expect(pool.leased, "Every lease was returned").toBe(0)
	})

	test("concurrency is clamped to the pool size rather than hanging", async () => {
		await using pool = new WorkerPool({ size: 2 })

		const { out, peakLeased } = await collectWatching(
			pool,
			parallelMapWorkers<number, number>([1, 2, 3, 4], {
				worker: join(parallelHandlers, "double.js"),
				// Deliberately larger than the pool: asking for eight leases from a pool of two could
				// only be satisfied by workers this very call is holding.
				concurrency: 8,
				pool,
			})
		)

		expect(out.toSorted((a, b) => a - b)).toEqual([2, 4, 6, 8])
		expect(peakLeased, "Clamped to the pool rather than the request").toBeLessThanOrEqual(2)
		expect(peakLeased, "And it really used the pool").toBeGreaterThan(0)
	})

	test("a pool shared between both APIs serves each in turn", async () => {
		await using pool = new WorkerPool({ size: 2 })

		const mapped = await collect(
			parallelMapWorkers<number, number>([1, 2, 3], {
				worker: join(parallelHandlers, "double.js"),
				concurrency: 2,
				pool,
			})
		)

		const parsed = await collect(
			AsyncSpliterator.asManyWorkers<string>(file, {
				worker: join(segmentHandlers, "uppercase.js"),
				delimiter: "\n",
				concurrency: 2,
				pool,
			})
		)

		expect(mapped.toSorted((a, b) => a - b)).toEqual([2, 4, 6])
		expect(parsed.toSorted(), "The same workers then serve segment work").toEqual(oracle)
	})
})
