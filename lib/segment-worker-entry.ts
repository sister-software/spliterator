/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 *
 * Runs inside a worker thread (spawned by runSegmentWorkers). Reads its segment via its own handle,
 * runs the user handler per record, and posts batched results to the parent with ack backpressure.
 */

import { parentPort, workerData } from "node:worker_threads"

import { AsyncSpliterator } from "./AsyncSpliterator.js"
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

	// Ack backpressure: the parent posts `"ack"` per consumed batch; we track outstanding batches.
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

	const { createChunkIterator } = await import("spliterator/node/fs")
	const chunkIterator = await createChunkIterator(data.source, { start: data.start, end: data.end - 1 })
	const records = new AsyncSpliterator(chunkIterator, { delimiter: data.delimiter as never, autoDispose: true })

	try {
		await runSegment({
			records,
			handleRecord,
			segmentIndex: data.segmentIndex,
			batchSize: data.batchSize,
			maxInFlight: data.maxInFlight,
			post: (batch, transfer) => {
				posted++
				port.postMessage({ type: "batch", records: batch }, transfer)
			},
			waitForAck: () => new Promise<void>((resolve) => (wakeAck = resolve)),
			inFlight: () => posted - acked,
		})

		port.postMessage({ type: "done" })
	} catch (error) {
		port.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) })
	}
}

void main()
