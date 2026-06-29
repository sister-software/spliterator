/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { Worker } from "node:worker_threads"

import type { CharacterSequenceInput } from "./CharacterSequence.js"
import { computeSegments } from "./segments.js"
import type { AsyncDataResource, ByteRange } from "./shared.js"

export interface MinimalWorker {
	on(event: "message", cb: (msg: unknown) => void): void
	on(event: "error", cb: (err: Error) => void): void
}

type WorkerMessage<R> = { type: "batch"; records: R[] } | { type: "done" } | { type: "error"; message: string }

/**
 * Drain a worker's batched messages into an async iterator. Listeners attach **eagerly** (messages posted before
 * iteration starts are buffered, not lost) and draining uses a `batches[] + head` pointer (no `Array.shift()`).
 * `onBatchConsumed` fires once per batch after its records are yielded — the ack hook for backpressure. An `error`
 * message or worker `error` rejects the iterator.
 */
export function workerToIterable<R>(worker: MinimalWorker, onBatchConsumed: () => void): AsyncIterableIterator<R> {
	const batches: R[][] = []
	let head = 0
	let done = false
	let error: Error | undefined
	let wake: (() => void) | undefined

	const signal = () => {
		wake?.()
		wake = undefined
	}

	worker.on("message", (msg) => {
		const m = msg as WorkerMessage<R>

		if (m.type === "batch") batches.push(m.records)
		else if (m.type === "done") done = true
		else if (m.type === "error") {
			error = new Error(m.message)
			done = true
		}

		signal()
	})

	worker.on("error", (err) => {
		error = err
		done = true
		signal()
	})

	async function* drain(): AsyncIterableIterator<R> {
		for (;;) {
			if (head < batches.length) {
				const batch = batches[head++]!

				for (const record of batch) yield record

				onBatchConsumed()
				continue
			}

			if (error) throw error

			if (done) return

			await new Promise<void>((resolve) => (wake = resolve))
		}
	}

	return drain()
}

export interface AsManyWorkersOptions {
	/** Module path or URL exporting `handleRecord(bytes, ctx)`. Runs once per worker at import. */
	worker: string | URL
	/** The record delimiter. @default LineFeed */
	delimiter?: CharacterSequenceInput
	/** Desired number of segments/workers. Clamped to ≥ 1; fewer may run. */
	concurrency: number
	/** Bytes read at each ideal boundary to find the next delimiter. @default 65536 */
	probeSize?: number
	/** Results per message. @default 256 */
	batchSize?: number
	/** Unacked batches per worker before it pauses. @default 4 */
	maxInFlight?: number
	/** Forwarded to every worker via `workerData.userData`. */
	workerData?: unknown
}

/**
 * Spawn one worker per delimiter-aligned segment, each running the `worker` handler module over its own handle, and
 * merge their results into a single async iterator. Results interleave across segments. Sends an `ack` per consumed
 * batch (backpressure); terminates all workers on completion, error, or early return.
 */
export async function* runSegmentWorkers<R>(
	source: AsyncDataResource,
	options: AsManyWorkersOptions
): AsyncIterableIterator<R> {
	if (typeof source !== "string" && !(source instanceof URL)) {
		throw new TypeError("asManyWorkers requires a file path or URL — file handles cannot cross threads.")
	}

	const handlerUrl =
		options.worker instanceof URL ? options.worker.href : new URL(options.worker, `file://${process.cwd()}/`).href
	const sourcePath = source instanceof URL ? source.href : source
	const segments: ByteRange[] = await computeSegments(source, {
		delimiter: options.delimiter,
		concurrency: options.concurrency,
		probeSize: options.probeSize,
	})

	const workers: Worker[] = []
	const entryUrl = new URL("./segment-worker-entry.js", import.meta.url)

	try {
		const iterables = segments.map(([start, end], segmentIndex) => {
			const worker = new Worker(entryUrl, {
				workerData: {
					source: sourcePath,
					handlerUrl,
					start,
					end,
					delimiter: options.delimiter ?? null,
					segmentIndex,
					batchSize: options.batchSize ?? 256,
					maxInFlight: options.maxInFlight ?? 4,
					userData: options.workerData,
				},
			})

			workers.push(worker)

			return workerToIterable<R>(worker, () => worker.postMessage("ack"))
		})

		// Each worker runs concurrently and fills ahead (bounded by maxInFlight); draining their
		// iterators in turn still interleaves wall-clock work. Order across segments is not guaranteed.
		for (const iterable of iterables) {
			yield* iterable
		}
	} finally {
		await Promise.all(workers.map((w) => w.terminate()))
	}
}
