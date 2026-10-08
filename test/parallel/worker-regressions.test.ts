/**
 * @license MIT
 * @author Teffen Ellis, et al. Lifecycle edges of the worker layer: omitted options, early exit, shared pools, and
 *   workers that die.
 * @copyright Sister Software
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { AsyncSpliterator, parallelMapWorkers, WorkerPool } from "spliterator"
import { runPool } from "spliterator/parallel-map-runtime"
import { afterAll, describe, expect, test } from "vitest"

const dir = mkdtempSync(join(tmpdir(), "spliterator-worker-regressions-"))
afterAll(async () => (await import("node:fs/promises")).rm(dir, { recursive: true, force: true }))

const segmentHandlers = fileURLToPath(new URL("../fixtures/segment-handlers/", import.meta.url))
const parallelHandlers = fileURLToPath(new URL("../fixtures/parallel-handlers/", import.meta.url))

const text = Array.from({ length: 2000 }, (_, i) => `row-${i}`).join("\n") + "\n"
const file = join(dir, "rows.txt")
writeFileSync(file, text)

const oracle = text
	.split("\n")
	.filter(Boolean)
	.map((s) => s.toUpperCase())
	.toSorted()

async function* range(n: number): AsyncIterableIterator<number> {
	for (let i = 0; i < n; i++) {
		yield i
	}
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = []

	for await (const value of iterable) {
		out.push(value)
	}

	return out
}

function sleep(ms: number): Promise<void> {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms)
	})
}

/**
 * Run `fn`, then keep watching the process for `settle` ms so a late error from a worker is attributed to this test.
 */
async function withoutUncaught<T>(fn: () => Promise<T>, settle = 400): Promise<T> {
	const caught: unknown[] = []
	const onUncaught = (error: unknown) => caught.push(error)

	process.on("uncaughtException", onUncaught)

	try {
		const result = await fn()

		await sleep(settle)

		expect(caught).toEqual([])

		return result
	} finally {
		process.off("uncaughtException", onUncaught)
	}
}

describe("asManyWorkers delimiter default", () => {
	test("unpooled: omitting delimiter splits on newline", async () => {
		const got = await collect(
			AsyncSpliterator.asManyWorkers<string>(file, { worker: join(segmentHandlers, "uppercase.ts"), concurrency: 2 })
		)

		expect(got.toSorted()).toEqual(oracle)
	})

	test("pooled: omitting delimiter splits on newline", async () => {
		await using pool = new WorkerPool({ size: 2 })

		const got = await collect(
			AsyncSpliterator.asManyWorkers<string>(file, {
				worker: join(segmentHandlers, "uppercase.ts"),
				concurrency: 2,
				pool,
			})
		)

		expect(got.toSorted()).toEqual(oracle)
	})
})

describe("pooled asManyWorkers early exit", () => {
	test("breaking out leaves the pool usable and raises nothing later", async () => {
		await withoutUncaught(async () => {
			await using pool = new WorkerPool({ size: 1 })

			// oxlint-disable-next-line no-unreachable-loop
			for await (const _ of AsyncSpliterator.asManyWorkers<string>(file, {
				worker: join(segmentHandlers, "slow.ts"),
				delimiter: "\n",
				concurrency: 1,
				maxInFlight: 1,
				batchSize: 4,
				pool,
			})) {
				void _

				break
			}

			const again = await collect(
				AsyncSpliterator.asManyWorkers<string>(file, {
					worker: join(segmentHandlers, "uppercase.ts"),
					delimiter: "\n",
					concurrency: 1,
					pool,
				})
			)

			expect(again.toSorted()).toEqual(oracle)
		})
	})
})

describe("pooled parallelMapWorkers sharing", () => {
	test("two concurrent calls on a pool smaller than their combined concurrency both finish", async () => {
		await using pool = new WorkerPool({ size: 2 })

		const run = () =>
			collect(
				parallelMapWorkers<number, number>(range(100), {
					worker: join(parallelHandlers, "double.ts"),
					concurrency: 2,
					batchSize: 8,
					pool,
				})
			)

		const deadlock = sleep(5000).then(() => {
			throw new Error("deadlocked")
		})

		const [a, b] = await Promise.race([Promise.all([run(), run()]), deadlock])

		expect(a.toSorted((x, y) => x - y)).toEqual(Array.from({ length: 100 }, (_, i) => i * 2))
		expect(b.toSorted((x, y) => x - y)).toEqual(Array.from({ length: 100 }, (_, i) => i * 2))
	})
})

describe("runPool source closure", () => {
	test("early exit calls return() on the source", async () => {
		let closed = false

		async function* source() {
			try {
				for (let i = 0; i < 1000; i++) {
					yield i
				}
			} finally {
				closed = true
			}
		}

		const worker = { process: async (batch: number[]) => batch }

		// oxlint-disable-next-line no-unreachable-loop
		for await (const _ of runPool([worker], source(), 10)) {
			void _

			break
		}

		expect(closed).toBe(true)
	})

	test("exhausting the source also finishes the iterator", async () => {
		let closed = false

		async function* source() {
			try {
				yield 1
			} finally {
				closed = true
			}
		}

		const worker = { process: async (batch: number[]) => batch }

		expect(await collect(runPool([worker], source(), 10))).toEqual([1])
		expect(closed).toBe(true)
	})
})

describe("WorkerPool disposal", () => {
	test("dispose during an in-flight spawn waits for it and terminates the worker", async () => {
		let terminated = 0

		const pool = new WorkerPool({
			size: 1,
			createWorker: async () => {
				await sleep(20)

				return {
					postMessage() {},
					on() {},
					off() {},
					async terminate() {
						terminated++
					},
				}
			},
		})

		const pending = pool.acquire()

		await pool.dispose()
		await expect(pending).rejects.toThrow(/disposed/)

		expect(terminated).toBe(1)
	})
})

/**
 * Rejects when `iterable` has not settled within five seconds, so a hang fails instead of timing out the suite.
 */
function collectOrHang<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const hang = sleep(5000).then(() => {
		throw new Error("hung")
	})

	return Promise.race([collect(iterable), hang])
}

describe("a worker that exits without finishing", () => {
	test("asManyWorkers rejects instead of hanging", async () => {
		const run = AsyncSpliterator.asManyWorkers(file, {
			worker: join(segmentHandlers, "exits.ts"),
			delimiter: "\n",
			concurrency: 2,
		})

		await expect(collectOrHang(run)).rejects.toThrow(/exited/)
	})

	test("parallelMapWorkers rejects instead of hanging", async () => {
		const run = parallelMapWorkers(range(50), { worker: join(parallelHandlers, "exits.ts"), concurrency: 2 })

		await expect(collectOrHang(run)).rejects.toThrow(/exited/)
	})

	test("pooled parallelMapWorkers rejects instead of hanging", async () => {
		await using pool = new WorkerPool({ size: 2 })

		const run = parallelMapWorkers(range(50), { worker: join(parallelHandlers, "exits.ts"), concurrency: 2, pool })

		await expect(collectOrHang(run)).rejects.toThrow(/exited/)
	})
})

describe("an idle pooled worker that throws", () => {
	test("does not crash the process, and the pool replaces it", async () => {
		await withoutUncaught(async () => {
			await using pool = new WorkerPool({ size: 1 })

			const first = await collect(
				parallelMapWorkers<number, number>(range(4), {
					worker: join(parallelHandlers, "late-throw.ts"),
					concurrency: 1,
					pool,
				})
			)

			expect(first.toSorted((a, b) => a - b)).toEqual([0, 1, 2, 3])

			await sleep(150)

			const second = await collect(
				parallelMapWorkers<number, number>(range(4), {
					worker: join(parallelHandlers, "double.ts"),
					concurrency: 1,
					pool,
				})
			)

			expect(second.toSorted((a, b) => a - b)).toEqual([0, 2, 4, 6])
		})
	})
})
