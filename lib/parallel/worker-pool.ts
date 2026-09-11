/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

/**
 * The slice of `worker_threads.Worker` the pool depends on. Narrow enough that the pool's mechanics test against fakes
 * without spawning threads, matching how the rest of the worker protocol is covered.
 */
export interface PoolWorkerLike {
	postMessage(message: unknown, transfer?: readonly ArrayBuffer[]): void
	on(event: string, listener: (payload: never) => void): void
	off(event: string, listener: (payload: never) => void): void
	terminate(): Promise<unknown>
	unref?(): void
}

/**
 * An exclusive hold on a pooled worker for the duration of one unit of work.
 *
 * Listener lifetime belongs to the lease, not the caller: handlers registered here are detached on {@linkcode release},
 * so a worker can serve many leases without the previous one's handlers still firing. Messages are matched on
 * {@linkcode id}, so a batch posted just before a release cannot be delivered to the next lease.
 */
export interface WorkerLease {
	/**
	 * Identifies this lease in the wire protocol. Every message the worker sends back carries it.
	 */
	readonly id: number

	post(message: unknown, transfer?: readonly ArrayBuffer[]): void
	onMessage(handler: (message: unknown) => void): void
	onError(handler: (error: Error) => void): void

	/**
	 * Return the worker to the pool. Idempotent.
	 */
	release(): void
}

export interface WorkerPoolOptions {
	/**
	 * Maximum warm workers. Acquiring past this queues rather than spawning.
	 *
	 * Size it for the work, not the core count — the guidance on `parallelMapWorkers.concurrency` applies here too:
	 * handlers that are I/O- or memory-bound peak around 2–3 and degrade past that.
	 */
	size: number

	/**
	 * Forwarded to every worker on construction.
	 */
	workerData?: unknown

	/**
	 * Override worker construction. Defaults to spawning the pooled entry on a `node:worker_threads` Worker, imported
	 * dynamically so the module stays isomorphic; tests inject fakes.
	 */
	createWorker?: () => PoolWorkerLike | Promise<PoolWorkerLike>

	/**
	 * Call `unref()` on each worker so the pool alone cannot keep the process alive.
	 *
	 * Off by default: a pool the caller owns should behave like a resource the caller owns, and a process exiting out
	 * from under in-flight work is worse than one that waits. Turn it on for a pool kept warm for the process lifetime.
	 *
	 * @default false
	 */
	unref?: boolean
}

interface PooledEntry {
	worker: PoolWorkerLike
	/**
	 * Set when the worker has failed and must not be handed out again.
	 */
	broken: boolean
}

/**
 * A fixed-size set of warm worker threads, reused across calls.
 *
 * Spawning a worker costs real time — measured at 17ms for one and 48ms for eight, which was **half to two-thirds** of
 * a small `asManyWorkers` call — and the handler module's top-level initialisation (loading a model, opening a
 * connection) is usually far more expensive still. Both are paid once per worker here instead of once per call.
 *
 * **The handler module therefore outlives a single call.** A pooled worker imports it once and keeps it, so top-level
 * state persists across every call routed through that worker. That is the reason to want a pool, and it is a real
 * difference from the unpooled path, where each call gets a freshly imported module. Handlers with per-call state must
 * not assume they start clean.
 *
 * Ownership is explicit: nothing is shared implicitly and nothing is kept warm behind the caller's back. Dispose it
 * when finished, or bind it with `await using`.
 *
 * @example
 * 	;```ts
 * 	await using pool = new WorkerPool({ size: 4 })
 *
 * 	for (const path of paths) {
 * 		for await (const row of AsyncSpliterator.asManyWorkers(path, { worker: "./handler.js", concurrency: 4, pool })) {
 * 			// ...
 * 		}
 * 	}
 * 	```
 */
export class WorkerPool implements AsyncDisposable {
	readonly #size: number
	readonly #createWorker: () => PoolWorkerLike | Promise<PoolWorkerLike>
	readonly #unref: boolean

	/**
	 * Warm workers not currently leased.
	 */
	readonly #idle: PooledEntry[] = []
	/**
	 * Every worker the pool has spawned and not discarded, leased or not.
	 */
	readonly #all = new Set<PooledEntry>()
	/**
	 * Acquires waiting for a worker to come free, in arrival order.
	 */
	readonly #waiting: Array<(entry: PooledEntry) => void> = []

	#leaseCounter = 0
	#disposed = false
	#disposal: Promise<void> | undefined
	#outstanding = 0
	#drained: (() => void) | undefined

	constructor(options: WorkerPoolOptions) {
		this.#size = Math.max(1, Math.floor(options.size))
		this.#unref = options.unref ?? false

		const workerData = options.workerData

		this.#createWorker =
			options.createWorker ??
			(async () => {
				const { Worker } = await import("node:worker_threads")

				return new Worker(new URL("./pool-worker-entry.js", import.meta.url), {
					workerData: { userData: workerData },
				}) as unknown as PoolWorkerLike
			})
	}

	/**
	 * Warm workers currently held by a lease.
	 */
	public get leased(): number {
		return this.#outstanding
	}

	/**
	 * Maximum warm workers.
	 */
	public get size(): number {
		return this.#size
	}

	/**
	 * Take exclusive hold of a worker, spawning one if the pool has room and waiting otherwise.
	 */
	public async acquire(): Promise<WorkerLease> {
		if (this.#disposed) {
			throw new Error("WorkerPool has been disposed.")
		}

		const entry = this.#idle.pop() ?? (this.#all.size < this.#size ? await this.#spawn() : await this.#waitForIdle())

		this.#outstanding++

		return this.#lease(entry)
	}

	/**
	 * Terminate every worker. Outstanding leases are awaited first — a worker is never pulled out from under work in
	 * flight — after which further acquires throw.
	 */
	public dispose(): Promise<void> {
		this.#disposed = true

		this.#disposal ??= this.#drain().then(async () => {
			const entries = [...this.#all]

			this.#all.clear()
			this.#idle.length = 0

			await Promise.all(entries.map((entry) => entry.worker.terminate()))

			return void 0
		})

		return this.#disposal
	}

	public [Symbol.asyncDispose](): Promise<void> {
		return this.dispose()
	}

	#drain(): Promise<void> {
		if (this.#outstanding === 0) return Promise.resolve()

		return new Promise<void>((resolve) => {
			this.#drained = resolve
		})
	}

	async #spawn(): Promise<PooledEntry> {
		// Reserve the slot before awaiting, so concurrent acquires cannot both decide there is room.
		const reservation: PooledEntry = { worker: undefined as unknown as PoolWorkerLike, broken: false }

		this.#all.add(reservation)

		try {
			const worker = await this.#createWorker()

			if (this.#unref) {
				worker.unref?.()
			}

			reservation.worker = worker

			return reservation
		} catch (error) {
			this.#all.delete(reservation)

			throw error
		}
	}

	#waitForIdle(): Promise<PooledEntry> {
		return new Promise<PooledEntry>((resolve) => {
			this.#waiting.push(resolve)
		})
	}

	/**
	 * Hand a freed worker to the longest-waiting acquire, or park it as idle.
	 */
	#recycle(entry: PooledEntry): void {
		if (entry.broken) {
			this.#all.delete(entry)

			// A waiter must never be handed the worker that just died; spawn its replacement instead.
			if (this.#waiting.length && this.#all.size < this.#size) {
				const waiter = this.#waiting.shift()!

				void this.#spawn().then(waiter, () => {
					// Spawning failed; put the waiter back so a later release can satisfy it.
					this.#waiting.unshift(waiter)
				})
			}

			return
		}

		const waiter = this.#waiting.shift()

		if (waiter) {
			waiter(entry)

			return
		}

		this.#idle.push(entry)
	}

	#lease(entry: PooledEntry): WorkerLease {
		const id = ++this.#leaseCounter
		let released = false
		let onMessage: ((message: unknown) => void) | undefined
		let onError: ((error: Error) => void) | undefined

		// Lease-scoped, so a message posted just before release is dropped rather than delivered to
		// whoever holds the worker next.
		const messageListener = (message: unknown): void => {
			if (released) return

			if ((message as { leaseId?: number })?.leaseId !== id) return

			onMessage?.(message)
		}

		const errorListener = (error: Error): void => {
			if (released) return

			// A worker that throws is not safe to reuse — its module state is unknown.
			entry.broken = true
			void entry.worker.terminate()

			onError?.(error instanceof Error ? error : new Error(String(error)))
		}

		entry.worker.on("message", messageListener as (payload: never) => void)
		entry.worker.on("error", errorListener as (payload: never) => void)

		return {
			id,
			post: (message, transfer) => entry.worker.postMessage(message, transfer),
			onMessage: (handler) => {
				onMessage = handler
			},
			onError: (handler) => {
				onError = handler
			},
			release: () => {
				if (released) return

				released = true

				entry.worker.off("message", messageListener as (payload: never) => void)
				entry.worker.off("error", errorListener as (payload: never) => void)

				this.#outstanding--
				this.#recycle(entry)

				if (this.#outstanding === 0) {
					this.#drained?.()
					this.#drained = undefined
				}
			},
		}
	}
}
