/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 *
 * Pool mechanics against fake workers — no threads. Real workers are exercised by
 * `pooled-workers.test.ts`, following the same bottom-up split as the segment suites.
 */

import { WorkerPool, type PoolWorkerLike } from "spliterator"
import { test } from "vitest"

interface FakeWorker extends PoolWorkerLike {
	readonly posted: unknown[]
	readonly listeners: Map<string, Set<(payload: never) => void>>
	terminated: boolean
	emit(event: string, payload: unknown): void
}

function createFakeWorker(): FakeWorker {
	const listeners = new Map<string, Set<(payload: never) => void>>()

	return {
		posted: [],
		listeners,
		terminated: false,
		postMessage(message) {
			this.posted.push(message)
		},
		on(event, listener) {
			if (!listeners.has(event)) {
				listeners.set(event, new Set())
			}

			listeners.get(event)!.add(listener as never)
		},
		off(event, listener) {
			listeners.get(event)?.delete(listener as never)
		},
		emit(event, payload) {
			for (const listener of listeners.get(event) ?? []) {
				;(listener as (p: unknown) => void)(payload)
			}
		},
		async terminate() {
			this.terminated = true
		},
		unref() {},
	}
}

function pooled(size: number) {
	const created: FakeWorker[] = []

	const pool = new WorkerPool({
		size,
		createWorker: () => {
			const worker = createFakeWorker()
			created.push(worker)

			return worker
		},
	})

	return { pool, created }
}

test("workers are created lazily, up to the pool size", async ({ expect }) => {
	const { pool, created } = pooled(3)

	expect(created, "Nothing is spawned before the first acquire").toHaveLength(0)

	const first = await pool.acquire()
	expect(created, "One worker for one lease").toHaveLength(1)

	const second = await pool.acquire()
	expect(created, "A second lease spawns a second worker").toHaveLength(2)

	first.release()
	second.release()

	await pool.dispose()
})

test("a released worker is reused rather than respawned", async ({ expect }) => {
	const { pool, created } = pooled(2)

	const lease = await pool.acquire()
	lease.release()

	const next = await pool.acquire()

	expect(created, "The warm worker was reused").toHaveLength(1)

	next.release()
	await pool.dispose()
})

test("acquiring past the pool size queues until a lease is released", async ({ expect }) => {
	const { pool, created } = pooled(1)

	const held = await pool.acquire()

	let granted = false

	const queued = pool.acquire().then((lease) => {
		granted = true

		return lease
	})

	await Promise.resolve()
	expect(granted, "The second acquire is still waiting").toBe(false)
	expect(created, "No extra worker is spawned to satisfy it").toHaveLength(1)

	held.release()

	const lease = await queued
	expect(granted, "Releasing hands the worker to the waiter").toBe(true)

	lease.release()
	await pool.dispose()
})

test("messages reach only the lease that is listening", async ({ expect }) => {
	const { pool, created } = pooled(1)

	const first = await pool.acquire()
	const seenByFirst: unknown[] = []
	first.onMessage((message) => seenByFirst.push(message))

	created[0]!.emit("message", { type: "records", leaseId: first.id, records: [1] })
	expect(seenByFirst, "The active lease sees its own message").toHaveLength(1)

	first.release()

	// A late message from the previous lease must not reach the next one.
	const second = await pool.acquire()
	const seenBySecond: unknown[] = []
	second.onMessage((message) => seenBySecond.push(message))

	created[0]!.emit("message", { type: "records", leaseId: first.id, records: [2] })

	expect(seenByFirst, "The released lease stops receiving").toHaveLength(1)
	expect(seenBySecond, "A stale message from a prior lease is dropped").toHaveLength(0)

	created[0]!.emit("message", { type: "records", leaseId: second.id, records: [3] })
	expect(seenBySecond, "The current lease receives its own").toHaveLength(1)

	second.release()
	await pool.dispose()
})

test("a worker that errors is discarded rather than returned to the pool", async ({ expect }) => {
	const { pool, created } = pooled(2)

	const lease = await pool.acquire()
	const errors: Error[] = []
	lease.onError((error) => errors.push(error))

	created[0]!.emit("error", new Error("worker exploded"))

	expect(errors, "The lease is told").toHaveLength(1)
	expect(created[0]!.terminated, "The broken worker is terminated").toBe(true)

	lease.release()

	const next = await pool.acquire()
	expect(created, "A fresh worker replaces it").toHaveLength(2)

	next.release()
	await pool.dispose()
})

test("dispose terminates every worker and rejects later acquires", async ({ expect }) => {
	const { pool, created } = pooled(2)

	const first = await pool.acquire()
	const second = await pool.acquire()
	first.release()
	second.release()

	await pool.dispose()

	expect(
		created.every((worker) => worker.terminated),
		"Every warm worker is terminated"
	).toBe(true)

	await expect(pool.acquire(), "The pool is closed").rejects.toThrow(/disposed/i)
})

test("dispose waits for outstanding leases", async ({ expect }) => {
	const { pool, created } = pooled(1)

	const lease = await pool.acquire()

	let disposed = false

	const pending = pool.dispose().then(() => {
		disposed = true

		return void 0
	})

	await Promise.resolve()
	expect(disposed, "Dispose does not yank a worker out from under a live lease").toBe(false)
	expect(created[0]!.terminated, "The leased worker is still running").toBe(false)

	lease.release()
	await pending

	expect(created[0]!.terminated, "It is terminated once the lease ends").toBe(true)
})

test("await using disposes the pool", async ({ expect }) => {
	const created: FakeWorker[] = []

	{
		await using pool = new WorkerPool({
			size: 1,
			createWorker: () => {
				const worker = createFakeWorker()
				created.push(worker)

				return worker
			},
		})

		const lease = await pool.acquire()
		lease.release()
	}

	expect(created[0]!.terminated, "Leaving the block disposed the pool").toBe(true)
})
