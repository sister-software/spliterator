/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { Worker } from "node:worker_threads"

import { type PoolWorker, runPool } from "./parallel-map-runtime.js"

/** Per-item handler a parallelMap worker module exports. `index` is per-worker monotonic. */
export type ParallelHandler<T = unknown, R = unknown> = (
	item: T,
	ctx: { index: number }
) => R | Uint8Array | undefined | Promise<R | Uint8Array | undefined>

export interface ParallelMapOptions {
	/** Worker module path/URL exporting `handleItem(item, ctx)`. Top-level code = per-worker init. */
	worker: string | URL
	/**
	 * Number of worker threads in the pool. Keep it SMALL for I/O- or memory-bound handlers (per-row DB lookups, large
	 * shared datasets): throughput typically peaks at ~2–3 and _degrades_ past that as workers contend for the shared
	 * resource — only CPU-bound handlers scale toward the core count. Also bounded by RAM (each worker re-inits its
	 * deps). Sweep it for your workload rather than defaulting to `availableParallelism()`.
	 */
	concurrency: number
	/** Items per dispatched batch. @default 64 */
	batchSize?: number
	/** Forwarded to every worker via `workerData.userData` (must be structured-cloneable). */
	workerData?: unknown
}

/** Wrap a worker as a pool slot: dispatch one batch, await its result. One batch in flight at a time. */
function workerHandle<T, R>(worker: Worker): PoolWorker<T, R> {
	let pending: { resolve: (results: R[]) => void; reject: (error: Error) => void } | null = null

	const settle = (fn: (p: NonNullable<typeof pending>) => void) => {
		if (!pending) return
		const p = pending
		pending = null
		fn(p)
	}

	worker.on("message", (msg: { type: "result"; results: R[] } | { type: "error"; message: string }) => {
		if (msg?.type === "result") settle((p) => p.resolve(msg.results))
		else if (msg?.type === "error") settle((p) => p.reject(new Error(msg.message)))
	})

	worker.on("error", (error: unknown) =>
		settle((p) => p.reject(error instanceof Error ? error : new Error(String(error))))
	)

	return {
		process(batch) {
			return new Promise<R[]>((resolve, reject) => {
				pending = { resolve, reject }
				worker.postMessage({ type: "batch", batch })
			})
		},
	}
}

/**
 * Map an async (or sync) iterable through a pool of worker threads. Main pulls items from `source`, batches them, and
 * dispatches each batch to an idle worker running the `worker` handler module; results stream back as a single merged
 * async iterator in **completion order** (not input order). A handler returning `undefined` drops that item; a
 * `Uint8Array` is transferred zero-copy.
 *
 * **When it pays (measure — don't assume).** Threading only wins when per-item work is heavy relative to the ~µs
 * cross-thread dispatch cost (structured-clone in + out). From real workloads: light per-row work — CSV/JSON parse,
 * string normalize, `JSON.parse` — is _dispatch-bound_ and runs **0.3–0.9× of single-threaded (a net loss)**; ms-scale
 * per-row work — model inference, geocoding, crypto/image ops — is where threads win. If the per-row cost isn't clearly
 * milliseconds, benchmark against the single-threaded version before adopting.
 *
 * **Concurrency is not core count.** Heavy work that is I/O- or memory-bound (random reads into one large on-disk DB,
 * anything sharing memory bandwidth) peaks _low_ — often ~2–3 workers — and then _degrades_, because the workers
 * contend for the shared resource, not the CPU. Start small and sweep; don't reach for `availableParallelism()`. Only
 * CPU-bound per-row work (pure compute) scales out toward the core count.
 *
 * All workers are terminated on completion, error, or early `return()`.
 */
export function parallelMap<T, R = unknown>(
	source: AsyncIterable<T> | Iterable<T>,
	options: ParallelMapOptions
): AsyncIterableIterator<R> {
	const handlerUrl =
		options.worker instanceof URL ? options.worker.href : new URL(options.worker, `file://${process.cwd()}/`).href
	const concurrency = Math.max(1, Math.floor(options.concurrency))
	const batchSize = options.batchSize ?? 64
	const entryUrl = new URL("./parallel-map-worker-entry.js", import.meta.url)
	const workers: Worker[] = []

	async function* run(): AsyncIterableIterator<R> {
		try {
			const pool = Array.from({ length: concurrency }, () => {
				const worker = new Worker(entryUrl, { workerData: { handlerUrl, userData: options.workerData } })
				workers.push(worker)

				return workerHandle<T, R>(worker)
			})

			yield* runPool(pool, source, batchSize)
		} finally {
			await Promise.all(workers.map((worker) => worker.terminate()))
		}
	}

	return run()
}
