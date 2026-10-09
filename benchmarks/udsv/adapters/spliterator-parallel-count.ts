/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 *
 * uDSV bench adapter: count rows with one worker thread per delimiter-aligned segment
 * (`AsyncSpliterator.segments`, the library's documented boundary primitive), each worker scanning its own range at
 * engine speed and reporting a single number. Workers persist across the harness's cycles, so the timed parse
 * measures the scan, not the spawn.
 *
 * Segments align to the record delimiter without regard to quote state, so a file carrying the row delimiter inside
 * a quoted field can be miscounted. Every published dataset is verified against the sequential `countAsync` before
 * its numbers land in the tables (see HANDOFF.md).
 */

import { availableParallelism } from "node:os"
import { Worker } from "node:worker_threads"

import { AsyncSpliterator } from "spliterator"

import type { CountRowsReply, CountRowsRequest } from "./parallel-count-worker.ts"

const concurrency = availableParallelism()

export const name = `spliterator (stream, row count, ${concurrency} workers)`
export const repo = "https://github.com/sister-software/spliterator"

const workers: Worker[] = []

export async function load() {
	if (!workers.length) {
		const workerUrl = new URL("./parallel-count-worker.js", import.meta.url)

		for (let i = 0; i < concurrency; i++) {
			workers.push(new Worker(workerUrl))
		}
	}

	// Requests are serialized per worker; the harness awaits each parse, so a worker never holds more than one.
	const queues = new WeakMap<Worker, Promise<unknown>>()

	const send = (worker: Worker, request: CountRowsRequest): Promise<number> => {
		const run = (queues.get(worker) ?? Promise.resolve()).then(
			() =>
				new Promise<number>((resolve, reject) => {
					const onMessage = (reply: CountRowsReply) => {
						worker.off("message", onMessage)

						if (reply.error === undefined) {
							resolve(reply.rows ?? 0)
						} else {
							reject(new Error(reply.error))
						}
					}

					worker.on("message", onMessage)
					worker.postMessage(request)
				})
		)

		queues.set(
			worker,
			run.catch(() => {})
		)

		return run
	}

	return async (_csvStr: string, path: string) => {
		const segments = await AsyncSpliterator.segments(path, { concurrency })

		const counts = await Promise.all(
			segments.map(([start, end], index) => send(workers[index % workers.length]!, { source: path, start, end }))
		)

		let rows = 0

		for (const count of counts) {
			rows += count
		}

		return [[rows]]
	}
}

export async function unload() {
	await Promise.all(workers.map((worker) => worker.terminate()))

	workers.length = 0
}
