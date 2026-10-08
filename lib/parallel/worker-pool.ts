/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { loadWorkerThreads, siblingUrl } from "../internal/node-modules.js"

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
 * Listener lifetime belongs to the lease rather than the caller. Handlers registered here are detached on
 * {@linkcode release}, so a worker can serve many leases without handlers from the previous lease firing. Messages are
 * matched on {@linkcode id}, so a batch posted just before a release cannot be delivered to the next lease.
 */
export interface WorkerLease {
	/**
	 * Identifies this lease in the wire protocol. Every message the worker sends back carries it.
	 */
	readonly id: number

	post(message: unknown, transfer?: readonly ArrayBuffer[]): void
	onMessage(handler: (message: unknown) => void): void
	/**
	 * A thrown error, or the worker exiting while leased. The worker is terminated and not reused.
	 */
	onError(handler: (error: Error) => void): void

	/**
	 * Mark the worker unfit for reuse, for example when it did not acknowledge a cancellation. It is terminated on
	 * {@linkcode release}.
	 */
	discard(): void

	/**
	 * Return the worker to the pool. Idempotent.
	 */
	release(): void
}

export interface WorkerPoolOptions {
	/**
	 * Maximum warm workers. Acquiring past this queues rather than spawning.
	 *
	 * Size it for the work rather than the core count. The guidance on `parallelMapWorkers.concurrency` applies here too:
	 * handlers that are I/O- or memory-bound peak around 2–3 and degrade past that.
	 */
	size: number

	/**
	 * Forwarded to every worker on construction.
	 */
	workerData?: unknown

	/**
	 * Override worker construction. Defaults to spawning the pooled entry on a `node:worker_threads` Worker, imported
	 * dynamically so the module stays isomorphic. Tests inject fakes.
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
	/**
	 * Held by a lease right now. An idle worker that dies is evicted directly; a leased one is evicted on release.
	 */
	leased: boolean
}

/**
 * A fixed-size set of warm worker threads, reused across calls.
 *
 * Spawning a worker costs real time — measured at 17ms for one and 48ms for eight, which was **half to two-thirds** of
 * a small `asManyWorkers` call — and the handler module's top-level initialisation (loading a model, opening a
 * connection) is usually far more expensive still. Both are paid once per worker here instead of once per call.
 *
 * **The handler module outlives a single call.** A pooled worker imports it once and keeps it, so top-level state
 * persists across every call routed through that worker. That is the reason to want a pool, and it is a real difference
 * from the unpooled path, where each call gets a freshly imported module. Handlers with per-call state must not assume
 * they start clean.
 *
 * Ownership is explicit. The pool shares no state implicitly and keeps no worker warm behind the caller's back. Dispose
 * it when finished, or bind it with `await using`.
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
	readonly #waiting: Array<{ resolve: (entry: PooledEntry) => void; reject: (error: unknown) => void }> = []

	#leaseCounter = 0
	#disposed = false
	#disposal: Promise<void> | undefined
	#outstanding = 0
	/**
	 * Acquires that have not yet been handed a worker. Disposal waits for these as well as for held leases.
	 */
	#arriving = 0
	#drained: (() => void) | undefined

	constructor(options: WorkerPoolOptions) {
		this.#size = Math.max(1, Math.floor(options.size))
		this.#unref = options.unref ?? false

		const workerData = options.workerData

		this.#createWorker =
			options.createWorker ??
			(async () => {
				const { Worker } = await loadWorkerThreads()

				return new Worker(siblingUrl("./pool-worker-entry.js", import.meta.url), {
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

		// Counted from the request, so a disposal that starts during a spawn or a wait drains this acquire too
		// instead of terminating a pool with a worker still arriving.
		this.#arriving++

		let entry: PooledEntry

		try {
			entry = this.#idle.pop() ?? (this.#all.size < this.#size ? await this.#spawn() : await this.#waitForIdle())
		} catch (error) {
			this.#arriving--
			this.#settle()

			throw error
		}

		this.#arriving--

		if (this.#disposed) {
			this.#idle.push(entry)
			this.#settle()

			throw new Error("WorkerPool has been disposed.")
		}

		this.#outstanding++

		return this.#lease(entry)
	}

	/**
	 * Terminate every worker. Outstanding leases are awaited first, so a worker remains available until its work
	 * finishes. Further acquires throw after disposal.
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
		if (this.#outstanding === 0 && this.#arriving === 0) return Promise.resolve()

		return new Promise<void>((resolve) => {
			this.#drained = resolve
		})
	}

	/**
	 * Resolve a pending disposal once nothing is held and nothing is arriving.
	 */
	#settle(): void {
		if (this.#outstanding === 0 && this.#arriving === 0) {
			this.#drained?.()
			this.#drained = undefined
		}
	}

	async #spawn(): Promise<PooledEntry> {
		// Reserve the slot before awaiting, so concurrent acquires cannot both decide there is room.
		const reservation: PooledEntry = { worker: undefined as unknown as PoolWorkerLike, broken: false, leased: false }

		this.#all.add(reservation)

		try {
			const worker = await this.#createWorker()

			if (this.#unref) {
				worker.unref?.()
			}

			reservation.worker = worker
			this.#watch(reservation)

			return reservation
		} catch (error) {
			this.#all.delete(reservation)

			throw error
		}
	}

	/**
	 * Listeners for the worker's whole life, not one lease's. Between leases nothing else is listening, and an `error`
	 * event with no listener is an uncaught exception in the parent. A worker that errors or exits is never handed out
	 * again: evicted now if idle, on release if leased.
	 */
	#watch(entry: PooledEntry): void {
		const evict = () => {
			entry.broken = true

			if (entry.leased) return

			const idleIndex = this.#idle.indexOf(entry)

			if (idleIndex !== -1) {
				this.#idle.splice(idleIndex, 1)
			}

			this.#all.delete(entry)
			void entry.worker.terminate()
		}

		entry.worker.on("error", evict as (payload: never) => void)
		entry.worker.on("exit", evict as (payload: never) => void)
	}

	#waitForIdle(): Promise<PooledEntry> {
		return new Promise<PooledEntry>((resolve, reject) => {
			this.#waiting.push({ resolve, reject })
		})
	}

	/**
	 * Hand a freed worker to the longest-waiting acquire, or park it as idle.
	 */
	#recycle(entry: PooledEntry): void {
		if (entry.broken) {
			this.#all.delete(entry)

			// A waiter must never receive the worker that just died. Spawn its replacement instead, and if
			// that fails tell the waiter, because no later release is guaranteed to come.
			if (this.#waiting.length && this.#all.size < this.#size) {
				const waiter = this.#waiting.shift()!

				void this.#spawn().then(waiter.resolve, waiter.reject)
			}

			return
		}

		const waiter = this.#waiting.shift()

		if (waiter) {
			waiter.resolve(entry)

			return
		}

		this.#idle.push(entry)
	}

	#lease(entry: PooledEntry): WorkerLease {
		const id = ++this.#leaseCounter
		let released = false

		entry.leased = true
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

			// A worker that throws is unsafe to reuse because its module state is unknown.
			entry.broken = true
			void entry.worker.terminate()

			onError?.(error instanceof Error ? error : new Error(String(error)))
		}

		const exitListener = (code: number): void => {
			errorListener(new Error(`Worker exited with code ${code} while leased.`))
		}

		entry.worker.on("message", messageListener as (payload: never) => void)
		entry.worker.on("error", errorListener as (payload: never) => void)
		entry.worker.on("exit", exitListener as (payload: never) => void)

		return {
			id,
			post: (message, transfer) => entry.worker.postMessage(message, transfer),
			onMessage: (handler) => {
				onMessage = handler
			},
			onError: (handler) => {
				onError = handler
			},
			discard: () => {
				entry.broken = true
				void entry.worker.terminate()
			},
			release: () => {
				if (released) return

				released = true
				entry.leased = false

				entry.worker.off("message", messageListener as (payload: never) => void)
				entry.worker.off("error", errorListener as (payload: never) => void)
				entry.worker.off("exit", exitListener as (payload: never) => void)

				this.#outstanding--
				this.#recycle(entry)
				this.#settle()
			},
		}
	}
}
