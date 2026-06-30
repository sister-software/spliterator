/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 *
 * Runs inside a worker thread (spawned by parallelMap). Imports the handler module once (top-level =
 * per-worker init), then maps each dispatched batch and posts the results back. Processes one batch at
 * a time — the pool never dispatches the next until this batch's result returns.
 */

import { parentPort, workerData } from "node:worker_threads"

import type { ParallelHandler } from "./parallel-map.js"

interface WorkerData {
	handlerUrl: string
	userData: unknown
}

const data = workerData as WorkerData
const port = parentPort!

let nextIndex = 0
const handlerReady = import(data.handlerUrl).then(
	(mod: { handleItem?: ParallelHandler; default?: ParallelHandler }) => mod.handleItem ?? mod.default
)

port.on("message", async (msg: unknown) => {
	const message = msg as { type: "batch"; batch: unknown[] }

	if (message?.type !== "batch") return

	try {
		const handleItem = await handlerReady

		if (typeof handleItem !== "function") {
			throw new Error(`Worker module ${data.handlerUrl} has no handleItem export.`)
		}

		const results: unknown[] = []
		const transfer: ArrayBuffer[] = []

		for (const item of message.batch) {
			const result = await handleItem(item, { index: nextIndex++ })

			if (result === undefined) continue

			results.push(result)

			if (result instanceof Uint8Array) transfer.push(result.buffer as ArrayBuffer)
		}

		port.postMessage({ type: "result", results }, transfer)
	} catch (error) {
		port.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) })
	}
})
