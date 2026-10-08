/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

import type { Worker } from "node:worker_threads"

import type { CharacterSequenceInput } from "#core/CharacterSequence"
import { loadWorkerThreads, workerEntryUrl } from "#internal/node-modules"
import { isPathBuilderLike, toPathString, type AsyncDataResource, type ByteRange } from "#internal/shared"
import { mergeAsyncIterators } from "#parallel/merge-async-iterators"
import { computeSegments } from "#parallel/segments"
import type { WorkerLease, WorkerPool } from "#parallel/worker-pool"

export { mergeAsyncIterators } from "#parallel/merge-async-iterators"

export interface MinimalWorker {
	on(event: "message", cb: (msg: unknown) => void): void
	on(event: "error", cb: (err: Error) => void): void
	on(event: "exit", cb: (code: number) => void): void
}

type WorkerMessage<R> = { type: "batch"; records: R[] } | { type: "done" } | { type: "error"; message: string }

/**
 * Drain a worker's batched messages into an async iterator. Listeners attach **eagerly** (messages posted before
 * iteration starts are buffered for later consumption) and draining uses a `batches[] + head` pointer (no
 * `Array.shift()`). `onBatchConsumed` fires once per batch after its records are yielded. It acknowledges backpressure.
 * An `error` message or worker `error` rejects the iterator.
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

	// A worker that dies without posting `done` (a handler that calls `process.exit`, an OOM) would otherwise
	// leave the drain waiting forever.
	worker.on("exit", (code) => {
		if (done) return

		error = new Error(`Worker exited with code ${code} before finishing its segment.`)
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
	 * Desired number of segments/workers. The value is clamped to ≥ 1, and fewer may run.
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
function leaseAsWorker(lease: WorkerLease, onSettled: () => void): MinimalWorker {
	return {
		on(event: string, callback: (payload: never) => void): void {
			if (event === "message") {
				lease.onMessage((raw) => {
					const message = raw as { type: string; records?: unknown[]; message?: string }

					if (message.type === "records") {
						;(callback as (m: unknown) => void)({ type: "batch", records: message.records })
					} else if (message.type === "done") {
						onSettled()
						;(callback as (m: unknown) => void)({ type: "done" })
					} else if (message.type === "failed") {
						onSettled()
						;(callback as (m: unknown) => void)({ type: "error", message: message.message })
					}
				})

				return
			}

			if (event === "error") {
				lease.onError((error) => {
					onSettled()
					;(callback as (e: Error) => void)(error)
				})
			}

			// The lease reports a worker exit through `onError`.
		},
	} as MinimalWorker
}

/**
 * How long a cancelled pooled segment may take to acknowledge before its worker is discarded rather than reused.
 */
const CANCEL_GRACE_MS = 2000

/**
 * Spawn one worker per delimiter-aligned segment, each running the `worker` handler module over its own handle, and
 * merge their results into a single async iterator. Results interleave across segments. Sends an `ack` per consumed
 * batch (backpressure). It terminates all workers on completion, error, or early return.
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
			// Each segment takes its lease when one is available and releases it on completion, so a pool
			// smaller than the segment count serves segments as workers come free.
			const iterables = segments.map(([start, end], segmentIndex) => {
				return (async function* (): AsyncIterableIterator<R> {
					const lease = await pool.acquire()

					leases.push(lease)

					let settled = false
					let wakeSettled: (() => void) | undefined

					const onSettled = () => {
						settled = true
						wakeSettled?.()
					}

					try {
						const drain = workerToIterable<R>(leaseAsWorker(lease, onSettled), () =>
							lease.post({ type: "ack", leaseId: lease.id })
						)

						lease.post({
							type: "segment",
							leaseId: lease.id,
							handlerUrl,
							source: sourcePath,
							start,
							end,
							delimiter: options.delimiter,
							segmentIndex,
							batchSize,
							maxInFlight,
						})

						yield* drain
					} finally {
						// Leaving early: the worker is still reading its range, and it outlives this call. Tell it to
						// stop and wait for the `done` that follows, so the next lease finds the worker idle rather
						// than mid-segment. One that does not answer is discarded instead of reused.
						if (!settled) {
							lease.post({ type: "cancel", leaseId: lease.id })

							let grace: NodeJS.Timeout | undefined

							const acknowledged = await Promise.race([
								new Promise<true>((resolve) => {
									wakeSettled = () => resolve(true)
								}),
								new Promise<false>((resolve) => {
									grace = setTimeout(() => resolve(false), CANCEL_GRACE_MS)
								}),
							])

							// A pending timer would keep the process alive for the full grace period after a clean cancel.
							clearTimeout(grace)

							if (!acknowledged) {
								lease.discard()
							}
						}

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
	const entryUrl = workerEntryUrl("#parallel/segment-worker-entry")
	// Lazy: keeps `node:worker_threads` out of the root's static graph for browser bundlers.
	const { Worker } = await loadWorkerThreads()

	try {
		const iterables = segments.map(([start, end], segmentIndex) => {
			const worker = new Worker(entryUrl, {
				workerData: {
					source: sourcePath,
					handlerUrl,
					start,
					end,
					delimiter: options.delimiter,
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
