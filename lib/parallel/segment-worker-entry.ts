/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 *
 * Runs inside a worker thread (spawned by runSegmentWorkers).
 * Reads its segment via its own handle, runs the user handler per record, and posts batched results to the parent with ack backpressure.
 */

import { parentPort, workerData } from "node:worker_threads"

import { AsyncSpliterator } from "../core/AsyncSpliterator.js"
import { loadNodeFs } from "../internal/node-modules.js"
import { runSegment, type SegmentHandler } from "./segment-runtime.js"

interface WorkerData {
	source: string
	handlerUrl: string
	start: number
	end: number
	delimiter: unknown
	segmentIndex: number
	batchSize: number
	maxInFlight: number
	userData: unknown
}

async function main(): Promise<void> {
	const data = workerData as WorkerData
	const port = parentPort!

	// The parent posts one `"ack"` per consumed batch. Track the outstanding batches.
	let acked = 0
	let posted = 0
	let wakeAck: (() => void) | undefined

	port.on("message", (msg: unknown) => {
		if (msg === "ack") {
			acked++
			wakeAck?.()
			wakeAck = undefined
		}
	})

	const mod = (await import(data.handlerUrl)) as { handleRecord?: SegmentHandler; default?: SegmentHandler }
	const handleRecord = mod.handleRecord ?? mod.default

	if (typeof handleRecord !== "function") {
		port.postMessage({ type: "error", message: `Worker module ${data.handlerUrl} has no handleRecord export.` })

		return
	}

	const { createChunkIterator } = await loadNodeFs()
	const chunkIterator = await createChunkIterator(data.source, { start: data.start, end: data.end - 1 })

	const records = new AsyncSpliterator(chunkIterator, {
		delimiter: (data.delimiter ?? undefined) as never,
		autoDispose: true,
	})

	return runSegment({
		records,
		handleRecord,
		segmentIndex: data.segmentIndex,
		batchSize: data.batchSize,
		maxInFlight: data.maxInFlight,
		post: (batch, transfer) => {
			posted++
			port.postMessage({ type: "batch", records: batch }, transfer)
		},
		waitForAck: () =>
			new Promise<void>((resolve) => {
				wakeAck = resolve
			}),
		inFlight: () => posted - acked,
	})
		.then(() => {
			port.postMessage({ type: "done" })

			return void 0
		})
		.catch((error) => {
			port.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) })
		})
}

void main()
