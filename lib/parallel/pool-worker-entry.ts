/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 *
 * Runs inside a pooled worker thread (spawned by `WorkerPool`). Unlike the single-use entries, this one takes no
 * assignment at construction: it idles until the parent leases it, serves that lease, and idles again.
 *
 * Handler modules are imported on demand and kept. That is deliberate — amortising a handler's top-level
 * initialisation across calls is the main reason a pool is worth having — and it is why a pooled worker can serve
 * leases for different handlers without respawning.
 */

import { parentPort, workerData } from "node:worker_threads"

import { AsyncSpliterator } from "../core/AsyncSpliterator.js"
import type { ParallelHandler } from "./parallel-map-workers.js"
import { runSegment, type SegmentHandler } from "./segment-runtime.js"

interface SegmentLease {
	type: "segment"
	leaseId: number
	handlerUrl: string
	source: string
	start: number
	end: number
	delimiter: unknown
	segmentIndex: number
	batchSize: number
	maxInFlight: number
}

interface MapLease {
	type: "map"
	leaseId: number
	handlerUrl: string
}

interface ItemsMessage {
	type: "items"
	leaseId: number
	batch: unknown[]
}

interface AckMessage {
	type: "ack"
	leaseId: number
}

type Incoming = SegmentLease | MapLease | ItemsMessage | AckMessage

const port = parentPort!

/**
 * Resolved handler exports, keyed by module URL. The ESM loader already caches the module; this caches the export
 * lookup so a lease does not re-await an import it has already resolved.
 */
const handlers = new Map<string, Promise<unknown>>()

function loadHandler(handlerUrl: string, exportName: "handleRecord" | "handleItem"): Promise<unknown> {
	const key = `${exportName}:${handlerUrl}`
	let pending = handlers.get(key)

	if (!pending) {
		pending = import(handlerUrl).then((mod: Record<string, unknown>) => mod[exportName] ?? mod.default)

		handlers.set(key, pending)
	}

	return pending
}

function fail(leaseId: number, error: unknown): void {
	port.postMessage({
		type: "failed",
		leaseId,
		message: error instanceof Error ? error.message : String(error),
	})
}

/**
 * Per-lease ack state for segment work. Cleared when the lease completes so a late ack cannot credit the next one.
 */
let activeSegment: { leaseId: number; acked: number; wake?: () => void } | undefined

/**
 * Per-lease item index for map work, so `ctx.index` still counts within a single call rather than across the worker's
 * whole lifetime.
 */
let mapLease: { leaseId: number; handlerUrl: string; nextIndex: number } | undefined

async function runSegmentLease(message: SegmentLease): Promise<void> {
	const { leaseId } = message

	try {
		const handleRecord = (await loadHandler(message.handlerUrl, "handleRecord")) as SegmentHandler | undefined

		if (typeof handleRecord !== "function") {
			throw new TypeError(`Worker module ${message.handlerUrl} has no handleRecord export.`)
		}

		const state = { leaseId, acked: 0, wake: undefined as (() => void) | undefined }
		activeSegment = state

		let posted = 0

		const { createChunkIterator } = await import("spliterator/node/fs")
		const chunkIterator = await createChunkIterator(message.source, { start: message.start, end: message.end - 1 })

		const records = new AsyncSpliterator(chunkIterator, {
			delimiter: message.delimiter as never,
			autoDispose: true,
		})

		await runSegment({
			records,
			handleRecord,
			segmentIndex: message.segmentIndex,
			batchSize: message.batchSize,
			maxInFlight: message.maxInFlight,
			post: (batch, transfer) => {
				posted++
				port.postMessage({ type: "records", leaseId, records: batch }, transfer)
			},
			waitForAck: () =>
				new Promise<void>((resolve) => {
					state.wake = resolve
				}),
			inFlight: () => posted - state.acked,
		})

		port.postMessage({ type: "done", leaseId })
	} catch (error) {
		fail(leaseId, error)
	} finally {
		if (activeSegment?.leaseId === leaseId) {
			activeSegment = undefined
		}
	}
}

async function runMapBatch(message: ItemsMessage): Promise<void> {
	const lease = mapLease

	if (!lease || lease.leaseId !== message.leaseId) return

	try {
		const handleItem = (await loadHandler(lease.handlerUrl, "handleItem")) as ParallelHandler | undefined

		if (typeof handleItem !== "function") {
			throw new TypeError(`Worker module ${lease.handlerUrl} has no handleItem export.`)
		}

		const results: unknown[] = []
		const transfer: ArrayBuffer[] = []

		for (const item of message.batch) {
			const result = await handleItem(item, { index: lease.nextIndex++ })

			if (result === undefined) continue

			results.push(result)

			if (result instanceof Uint8Array) {
				transfer.push(result.buffer as ArrayBuffer)
			}
		}

		port.postMessage({ type: "results", leaseId: message.leaseId, results }, transfer)
	} catch (error) {
		fail(message.leaseId, error)
	}
}

port.on("message", (raw: unknown) => {
	const message = raw as Incoming

	switch (message?.type) {
		case "segment":
			void runSegmentLease(message)

			return

		case "map":
			mapLease = { leaseId: message.leaseId, handlerUrl: message.handlerUrl, nextIndex: 0 }

			return

		case "items":
			void runMapBatch(message)

			return

		case "ack":
			if (activeSegment?.leaseId !== message.leaseId) return

			activeSegment.acked++
			activeSegment.wake?.()
			activeSegment.wake = undefined
	}
})

// Referenced so bundlers keep the construction-time payload wired; the pool forwards it as `userData`.
void workerData
