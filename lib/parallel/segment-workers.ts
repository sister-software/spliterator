/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { Worker } from "node:worker_threads"

import type { CharacterSequenceInput } from "../core/CharacterSequence.js"
import { isPathBuilderLike, toPathString, type AsyncDataResource, type ByteRange } from "../internal/shared.js"
import { mergeAsyncIterators } from "./merge-async-iterators.js"
import { computeSegments } from "./segments.js"
import type { WorkerLease, WorkerPool } from "./worker-pool.js"

export { mergeAsyncIterators } from "./merge-async-iterators.js"

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

		if (m.type === "batch") {
			batches.push(m.records)
		} else if (m.type === "done") {
			done = true
		} else if (m.type === "error") {
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

				for (const record of batch) {
					yield record
				}

				onBatchConsumed()

				continue
			}

			if (error) throw error

			if (done) return

			// oxlint-disable-next-line no-loop-func no-promise-executor-return
			await new Promise<void>((resolve) => (wake = resolve))
		}
	}

	return drain()
}

export interface AsManyWorkersOptions {
	/**
	 * Module path or URL exporting `handleRecord(bytes, ctx)`. Runs once per worker at import.
	 */
	worker: string | URL
	/**
	 * The record delimiter. @default LineFeed
	 */
	delimiter?: CharacterSequenceInput
	/**
	 * Desired number of segments/workers. Clamped to ≥ 1; fewer may run.
	 */
	concurrency: number
	/**
	 * Bytes read at each ideal boundary to find the next delimiter. @default 65536
	 */
	probeSize?: number
	/**
	 * Results per message. @default 256
	 */
	batchSize?: number
	/**
	 * Unacked batches per worker before it pauses (bounds memory). @default 8
	 */
	maxInFlight?: number
	/**
	 * Forwarded to every worker via `workerData.userData`.
	 *
	 * Not accepted alongside {@linkcode pool} — a pooled worker's `workerData` is fixed when the pool spawns it, so a
	 * per-call value could not reach it. Pass it to the {@linkcode WorkerPool} constructor instead.
	 */
	workerData?: unknown

	/**
	 * Reuse warm workers from this pool instead of spawning and terminating one per segment.
	 *
	 * Worth it for repeated calls and for handlers with expensive top-level initialisation — spawning alone measured half
	 * to two-thirds of a small call. Note that the handler module is then imported once per worker rather than once per
	 * call, so its top-level state persists across calls.
	 *
	 * Segments beyond the pool's size wait for a worker rather than running concurrently, so a pool smaller than
	 * `concurrency` bounds the real parallelism.
	 */
	pool?: WorkerPool
}

/**
 * Present a pooled lease as the minimal worker {@linkcode workerToIterable} drains, translating the lease-scoped
 * protocol into the single-use one so the drain logic is shared and tested once.
 */
function leaseAsWorker(lease: WorkerLease): MinimalWorker {
	return {
		on(event: string, callback: (payload: never) => void): void {
			if (event === "message") {
				lease.onMessage((raw) => {
					const message = raw as { type: string; records?: unknown[]; message?: string }

					if (message.type === "records") {
						;(callback as (m: unknown) => void)({ type: "batch", records: message.records })
					} else if (message.type === "done") {
						;(callback as (m: unknown) => void)({ type: "done" })
					} else if (message.type === "failed") {
						;(callback as (m: unknown) => void)({ type: "error", message: message.message })
					}
				})

				return
			}

			lease.onError(callback as unknown as (error: Error) => void)
		},
	} as MinimalWorker
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
	if (!isPathBuilderLike(source) && !(source instanceof URL)) {
		throw new TypeError("asManyWorkers requires a file path or URL — file handles cannot cross threads.")
	}

	if (options.pool && options.workerData !== undefined) {
		throw new TypeError(
			"`workerData` cannot be combined with `pool` — a pooled worker's workerData is fixed when the pool spawns it. Pass it to the WorkerPool constructor instead."
		)
	}

	const handlerUrl =
		options.worker instanceof URL ? options.worker.href : new URL(options.worker, `file://${process.cwd()}/`).href

	// Resolved here rather than in the worker: a PathBuilder is callable and cannot cross `postMessage`.
	const sourcePath = source instanceof URL ? source.href : toPathString(source)

	const segments: ByteRange[] = await computeSegments(source, {
		delimiter: options.delimiter,
		concurrency: options.concurrency,
		probeSize: options.probeSize,
	})

	const batchSize = options.batchSize ?? 256
	const maxInFlight = options.maxInFlight ?? 8

	if (options.pool) {
		const pool = options.pool
		const leases: WorkerLease[] = []

		try {
			// Acquiring is sequential by necessity: a pool smaller than the segment count hands workers
			// out as they come free, so awaiting all of them up front would deadlock. Each segment takes
			// its lease when one is available and releases it on completion.
			const iterables = segments.map(([start, end], segmentIndex) => {
				return (async function* (): AsyncIterableIterator<R> {
					const lease = await pool.acquire()

					leases.push(lease)

					try {
						const drain = workerToIterable<R>(leaseAsWorker(lease), () =>
							lease.post({ type: "ack", leaseId: lease.id })
						)

						lease.post({
							type: "segment",
							leaseId: lease.id,
							handlerUrl,
							source: sourcePath,
							start,
							end,
							delimiter: options.delimiter ?? null,
							segmentIndex,
							batchSize,
							maxInFlight,
						})

						yield* drain
					} finally {
						lease.release()
					}
				})()
			})

			yield* mergeAsyncIterators(iterables)
		} finally {
			// Releasing twice is a no-op, so an early return that skipped a generator's `finally` is safe.
			for (const lease of leases) {
				lease.release()
			}
		}

		return
	}

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
					batchSize,
					maxInFlight,
					userData: options.workerData,
				},
			})

			workers.push(worker)

			return workerToIterable<R>(worker, () => worker.postMessage("ack"))
		})

		// Drain all workers concurrently so they run in parallel — a sequential drain would consume one
		// to completion while the rest stall at their in-flight window. Order across segments is not
		// guaranteed (results arrive in completion order).
		yield* mergeAsyncIterators(iterables)
	} finally {
		await Promise.all(workers.map((w) => w.terminate()))
	}
}
