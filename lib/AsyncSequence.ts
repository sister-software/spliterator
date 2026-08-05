/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { ReadableStream, type ReadableWritablePair, type StreamPipeOptions } from "stream/web"

/**
 * A chainable operation in a fused pipeline.
 *
 * Ops are **descriptors**, not closures over iteration state — `take`/`drop` counters live in the iterator, not here,
 * so a sequence can describe its chain before anyone pulls from it.
 */
type Op =
	| { kind: typeof OP_MAP; fn: (value: any, counter: number) => unknown }
	| { kind: typeof OP_FILTER; fn: (value: any, counter: number) => unknown }
	| { kind: typeof OP_TAKE; limit: number }
	| { kind: typeof OP_DROP; limit: number }

const OP_MAP = 0
const OP_FILTER = 1
const OP_TAKE = 2
const OP_DROP = 3

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return value !== null && typeof value === "object" && typeof (value as PromiseLike<unknown>).then === "function"
}

/**
 * What a sequence can be built over.
 *
 * The thunk form defers construction until the first pull, which is what lets a `fromAsync` whose underlying open is
 * asynchronous still return a sequence synchronously — the caller chains immediately and no file is opened until
 * something iterates.
 */
export type SequenceSource<T> =
	| AsyncIterable<T>
	| Iterable<T>
	| (() => AsyncIterable<T> | Iterable<T> | PromiseLike<AsyncIterable<T> | Iterable<T>>)

function toAsyncIterator<T>(source: AsyncIterable<T> | Iterable<T>): AsyncIterator<T> {
	if (Symbol.asyncIterator in source) return source[Symbol.asyncIterator]()

	const iterator = source[Symbol.iterator]()

	return {
		next: async () => iterator.next(),
		return: async (value?: unknown) => iterator.return?.(value) ?? { value: undefined, done: true },
	} as AsyncIterator<T>
}

async function* flattenValues<T, U>(
	source: AsyncIterable<T>,
	fn: (value: T, counter: number) => AsyncIterable<U> | Iterable<U> | PromiseLike<AsyncIterable<U> | Iterable<U>>
): AsyncGenerator<U> {
	let counter = 0

	for await (const value of source) {
		const mapped = fn(value, counter++)
		const inner = isThenable(mapped) ? await mapped : mapped

		if (inner === null || typeof inner !== "object") {
			throw new TypeError(`flatMap callback must return an iterable, received ${typeof inner}`)
		}

		yield* inner as AsyncIterable<U>
	}
}

async function* batchValues<T>(source: AsyncIterable<T>, size: number): AsyncGenerator<T[]> {
	let batch: T[] = []

	for await (const value of source) {
		batch.push(value)

		if (batch.length === size) {
			yield batch

			batch = []
		}
	}

	if (batch.length) {
		yield batch
	}
}

async function* mapValuesConcurrently<T, U>(
	source: AsyncIterable<T>,
	fn: (value: T, counter: number) => U | PromiseLike<U>,
	limit: number,
	signal?: AbortSignal
): AsyncGenerator<U> {
	const upstream = source[Symbol.asyncIterator]()
	// Slots key this map, not items: a source may repeat a value (a list of file paths routinely does), and two `===`
	// equal keys would collapse into one entry, losing a result and deleting the wrong dispatch.
	const inflight = new Map<number, Promise<{ slot: number; value: U }>>()
	let slot = 0
	let exhausted = false

	try {
		for (;;) {
			if (signal?.aborted) break

			while (!exhausted && inflight.size < limit) {
				const result = await upstream.next()

				if (result.done) {
					exhausted = true

					break
				}

				const current = slot++
				const produced = fn(result.value, current)

				inflight.set(
					current,
					Promise.resolve(produced).then((value) => ({ slot: current, value }))
				)
			}

			if (!inflight.size) break

			const { slot: settled, value } = await Promise.race(inflight.values())

			inflight.delete(settled)

			yield value
		}
	} finally {
		await upstream.return?.()
		// Settle whatever is still running so an abandoned rejection is never unobserved.
		await Promise.allSettled(inflight.values())
	}
}

/**
 * Options for {@linkcode AsyncSequence.parallelMap}.
 */
export interface ParallelMapSequenceOptions {
	/**
	 * Maximum callbacks in flight at once.
	 *
	 * For I/O-bound work this peaks **low** — often ~2–3 — and then _degrades_ as callers contend for the same disk or
	 * socket. Sweep it rather than reaching for `availableParallelism()`.
	 */
	concurrency: number

	/**
	 * Abort signal. When aborted, iteration stops after the currently-yielded value; in-flight callbacks are allowed to
	 * settle so none reject unobserved.
	 */
	signal?: AbortSignal
}

/**
 * A lazy, chainable async iterator.
 *
 * The core methods (`map`, `filter`, `take`, `drop`, `flatMap`, `reduce`, `toArray`, `forEach`, `some`, `every`,
 * `find`) match the [async iterator helpers proposal][proposal] in name, arity, and semantics — including the `counter`
 * second argument handed to every callback. Callbacks may return promises. Code written against this keeps working
 * verbatim if the proposal ever ships natively.
 *
 * [proposal]: https://github.com/tc39/proposal-async-iterator-helpers
 *
 * **Chain depth is nearly free.** A chain is an op list plus a source, not nested generators, so one async boundary is
 * paid per item no matter how many operators you stack; only the op loop grows. Measured on Node 26 over 2M items:
 * ~5.4M items/s at three operators and ~4.9M/s at six, against ~2.3M/s for the equivalent nested-generator
 * implementation, where each operator adds a microtask hop. Doubling the operator count costs ~10% here and would cost
 * ~2× there. Only {@linkcode flatMap}, {@linkcode chunks}, and {@linkcode parallelMap} break fusion, because they need
 * inner-iterator state.
 *
 * Callback results are awaited **only when thenable**, so synchronous callbacks — the common case — cost no microtask
 * hop at all.
 *
 * **When not to reach for this.** Wrapping costs ~1.9× a bare async generator (~10.3M/s), one extra async frame per
 * item. On parsed rows (`JSON.parse` at ~1–3µs) that is 3–8%, invisible. On raw {@linkcode Uint8Array} ranges with no
 * per-row parse it is most of the cost — iterate the {@linkcode AsyncSpliterator} directly there.
 *
 * Single-shot, like the iterators the proposal specifies: iterating consumes the source.
 */
export class AsyncSequence<T> implements AsyncIterableIterator<T> {
	readonly #source: SequenceSource<unknown>
	readonly #ops: readonly Op[]

	/**
	 * Indices of `take` ops, precomputed so the exhaustion pre-check costs nothing when there are none.
	 */
	readonly #takeIndices: readonly number[]

	#upstream: AsyncIterator<unknown> | null = null
	#syncUpstream: Iterator<unknown> | null = null
	#counters: number[] | null = null
	#budgets: number[] | null = null
	#done = false

	constructor(source: SequenceSource<unknown>, ops: readonly Op[] = []) {
		this.#source = source
		this.#ops = ops

		const takeIndices: number[] = []

		for (let i = 0; i < ops.length; i++) {
			if (ops[i]!.kind === OP_TAKE) {
				takeIndices.push(i)
			}
		}

		this.#takeIndices = takeIndices
	}

	/**
	 * Wrap any iterable or async iterable as a chainable sequence.
	 */
	static from<T>(source: SequenceSource<T>): AsyncSequence<T> {
		return source instanceof AsyncSequence ? source : new AsyncSequence<T>(source)
	}

	/**
	 * Resolve the source once, keeping a synchronous iterator as such.
	 *
	 * Adapting a sync iterator to the async protocol would allocate a promise per pulled value for an iterator that never
	 * needs one, which is most of the cost of parsing an in-memory source: 0.733ms against a 0.540ms floor over a 68KB
	 * file.
	 */
	async #openUpstream(): Promise<AsyncIterator<unknown> | Iterator<unknown>> {
		if (this.#upstream) return this.#upstream

		if (this.#syncUpstream) return this.#syncUpstream

		const source = this.#source
		const resolved = typeof source === "function" ? await source() : source

		if (!(Symbol.asyncIterator in resolved)) {
			this.#syncUpstream = resolved[Symbol.iterator]()

			return this.#syncUpstream
		}

		this.#upstream = toAsyncIterator(resolved)

		return this.#upstream
	}

	#derive<U>(op: Op): AsyncSequence<U> {
		return new AsyncSequence<U>(this.#source, [...this.#ops, op])
	}

	//#region Spec-compatible core — lazy

	/**
	 * Transform each value. The callback receives `(value, counter)` and may return a promise.
	 */
	map<U>(fn: (value: T, counter: number) => U | PromiseLike<U>): AsyncSequence<U> {
		return this.#derive<U>({ kind: OP_MAP, fn })
	}

	/**
	 * Keep values for which the callback is truthy. The callback receives `(value, counter)` and may return a promise.
	 */
	filter(fn: (value: T, counter: number) => unknown): AsyncSequence<T> {
		return this.#derive<T>({ kind: OP_FILTER, fn })
	}

	/**
	 * Yield at most `limit` values, then close the underlying iterator.
	 *
	 * The close is what makes this safe on a file-backed source — `take(5)` over a 40GB file releases the handle rather
	 * than leaving it open until GC.
	 */
	take(limit: number): AsyncSequence<T> {
		const normalized = Math.trunc(limit)

		if (!Number.isFinite(normalized) || normalized < 0) {
			throw new RangeError(`take(${limit}): limit must be a non-negative finite number`)
		}

		return this.#derive<T>({ kind: OP_TAKE, limit: normalized })
	}

	/**
	 * Skip the first `limit` values.
	 */
	drop(limit: number): AsyncSequence<T> {
		const normalized = Math.trunc(limit)

		if (!Number.isFinite(normalized) || normalized < 0) {
			throw new RangeError(`drop(${limit}): limit must be a non-negative finite number`)
		}

		return this.#derive<T>({ kind: OP_DROP, limit: normalized })
	}

	/**
	 * Map each value to an iterable and flatten one level.
	 *
	 * **Fusion barrier.** Unlike the other operators this needs inner-iterator state, so it starts a fresh fused segment
	 * rather than joining the current op list. Stacking `flatMap` costs one async boundary each; stacking
	 * `map`/`filter`/`take`/`drop` costs nothing.
	 */
	flatMap<U>(
		fn: (value: T, counter: number) => AsyncIterable<U> | Iterable<U> | PromiseLike<AsyncIterable<U> | Iterable<U>>
	): AsyncSequence<U> {
		return new AsyncSequence<U>(flattenValues(this, fn))
	}

	//#endregion

	//#region Spec-compatible core — terminal

	/**
	 * Collect every remaining value into an array.
	 *
	 * **Reads the whole source into memory.** On a sequence backed by a file this defeats the point of streaming — filter
	 * and map first so only what you keep is materialized.
	 */
	async toArray(): Promise<T[]> {
		const values: T[] = []

		for await (const value of this) {
			values.push(value)
		}

		return values
	}

	/**
	 * Invoke the callback for each value, for side effects.
	 */
	async forEach(fn: (value: T, counter: number) => unknown): Promise<void> {
		let counter = 0

		for await (const value of this) {
			const result = fn(value, counter++)

			if (isThenable(result)) {
				await result
			}
		}
	}

	/**
	 * Fold the sequence to a single value. Without `initialValue` the first value seeds the accumulator, and an empty
	 * sequence is a `TypeError` — matching `Array.prototype.reduce`.
	 */
	reduce(fn: (accumulator: T, value: T, counter: number) => T | PromiseLike<T>): Promise<T>
	reduce<U>(fn: (accumulator: U, value: T, counter: number) => U | PromiseLike<U>, initialValue: U): Promise<U>
	async reduce<U>(
		fn: (accumulator: U, value: T, counter: number) => U | PromiseLike<U>,
		...rest: [initialValue?: U]
	): Promise<U> {
		let accumulator = rest[0] as U
		let seeded = rest.length > 0
		let counter = 0

		for await (const value of this) {
			if (!seeded) {
				accumulator = value as unknown as U
				seeded = true

				counter++

				continue
			}

			const next = fn(accumulator, value, counter++)

			accumulator = isThenable(next) ? await next : next
		}

		if (!seeded) throw new TypeError("reduce of empty sequence with no initial value")

		return accumulator
	}

	/**
	 * Whether any value satisfies the callback. Short-circuits and closes the underlying iterator.
	 */
	async some(fn: (value: T, counter: number) => unknown): Promise<boolean> {
		let counter = 0

		for await (const value of this) {
			const result = fn(value, counter++)

			if (isThenable(result) ? await result : result) return true
		}

		return false
	}

	/**
	 * Whether every value satisfies the callback. Short-circuits and closes the underlying iterator.
	 */
	async every(fn: (value: T, counter: number) => unknown): Promise<boolean> {
		let counter = 0

		for await (const value of this) {
			const result = fn(value, counter++)

			if (!(isThenable(result) ? await result : result)) return false
		}

		return true
	}

	/**
	 * The first value satisfying the callback, or `undefined`. Short-circuits and closes the underlying iterator.
	 */
	async find(fn: (value: T, counter: number) => unknown): Promise<T | undefined> {
		let counter = 0

		for await (const value of this) {
			const result = fn(value, counter++)

			if (isThenable(result) ? await result : result) return value
		}

		return undefined
	}

	//#endregion

	//#region Extras — deliberately not spec surface

	/**
	 * Group values into arrays of `size`, with a shorter final batch if the sequence does not divide evenly.
	 *
	 * Distinct from {@linkcode take}, which yields the first `size` _values_. Named for the [iterator chunking
	 * proposal](https://github.com/tc39/proposal-iterator-chunking).
	 *
	 * **Fusion barrier**, like {@linkcode flatMap}.
	 */
	chunks(size: number): AsyncSequence<T[]> {
		const normalized = Math.trunc(size)

		if (!Number.isFinite(normalized) || normalized < 1) {
			throw new RangeError(`chunks(${size}): size must be a positive finite number`)
		}

		return new AsyncSequence<T[]>(batchValues(this, normalized))
	}

	/**
	 * Map values through a callback with up to `concurrency` calls in flight, yielding in **completion order** — not
	 * input order.
	 *
	 * The callback is a closure, so it runs on the caller's thread. This overlaps _latency_ (file reads, network) and
	 * does nothing for CPU-bound work; for that, cross a thread boundary with `parallelMapWorkers` or
	 * `AsyncSpliterator.asManyWorkers`, which take a module path precisely because a closure cannot.
	 *
	 * **Fusion barrier**, like {@linkcode flatMap}.
	 */
	parallelMap<U>(
		fn: (value: T, counter: number) => U | PromiseLike<U>,
		{ concurrency, signal }: ParallelMapSequenceOptions
	): AsyncSequence<U> {
		return new AsyncSequence<U>(mapValuesConcurrently(this, fn, Math.max(1, Math.trunc(concurrency)), signal))
	}

	/**
	 * Expose the sequence as a web stream, for interop with `pipeThrough`/`pipeTo` consumers.
	 */
	toReadableStream(): ReadableStream<T> {
		const iterator = this[Symbol.asyncIterator]()

		return new ReadableStream<T>({
			pull: async (controller) => {
				const { done, value } = await iterator.next()

				if (done) {
					controller.close()
				} else {
					controller.enqueue(value)
				}
			},
			cancel: async () => void (await iterator.return?.()),
		})
	}

	/**
	 * Pipe the sequence through a transform stream.
	 */
	pipeThrough<U>(transform: ReadableWritablePair<U, T>, options?: StreamPipeOptions): ReadableStream<U> {
		return this.toReadableStream().pipeThrough(transform, options)
	}

	//#endregion

	//#region Iteration

	async next(): Promise<IteratorResult<T>> {
		if (this.#done) return { value: undefined, done: true }

		const ops = this.#ops
		const length = ops.length

		this.#counters ??= Array.from<number>({ length }).fill(0)

		this.#budgets ??= ops.map((op) => (op.kind === OP_TAKE || op.kind === OP_DROP ? op.limit : 0))

		const counters = this.#counters
		const budgets = this.#budgets

		// A satisfied `take` must close the source WITHOUT pulling again — the whole point of `take(5)` on a huge file is
		// that the sixth row is never read.
		for (const index of this.#takeIndices) {
			if (budgets[index]! <= 0) return this.#finish()
		}

		const upstream = await this.#openUpstream()
		const isSync = upstream === this.#syncUpstream

		try {
			outer: for (;;) {
				const pulled = upstream.next()
				const result = isSync ? (pulled as IteratorResult<unknown>) : await pulled

				if (result.done) {
					this.#done = true

					return { value: undefined, done: true }
				}

				let value: unknown = result.value

				for (let i = 0; i < length; i++) {
					const op = ops[i]!

					switch (op.kind) {
						case OP_MAP: {
							const mapped = op.fn(value, counters[i]!++)

							value = isThenable(mapped) ? await mapped : mapped

							break
						}

						case OP_FILTER: {
							const keep = op.fn(value, counters[i]!++)

							if (!(isThenable(keep) ? await keep : keep)) continue outer

							break
						}

						case OP_DROP: {
							if (budgets[i]! > 0) {
								budgets[i]!--

								continue outer
							}

							break
						}

						case OP_TAKE: {
							if (budgets[i]! <= 0) return this.#finish()

							budgets[i]!--

							break
						}
					}
				}

				return { value: value as T, done: false }
			}
		} catch (error) {
			// A rejected `next()` does not make `for await` call `return()` — the iterator is presumed broken — so a
			// throwing callback would otherwise strand the source's resources.
			await this.#finish()

			throw error
		}
	}

	/**
	 * Close the sequence and release the underlying source.
	 */
	async return(): Promise<IteratorResult<T>> {
		return this.#finish()
	}

	async #finish(): Promise<IteratorResult<T>> {
		if (this.#done) return { value: undefined, done: true }

		this.#done = true

		// An eager source may already hold a resource that no pull ever touched, so closing has to reach it even along
		// paths like `take(0)`. A thunk source that was never invoked has nothing open to release, and invoking it here
		// would open a file purely to close it.
		const source = this.#source

		const upstream =
			this.#upstream ?? this.#syncUpstream ?? (typeof source === "function" ? null : toAsyncIterator(source))

		this.#upstream = null
		this.#syncUpstream = null

		await upstream?.return?.()

		return { value: undefined, done: true }
	}

	[Symbol.asyncIterator](): AsyncIterableIterator<T> {
		return this
	}

	//#endregion
}
