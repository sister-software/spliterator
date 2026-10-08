/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

import type { ReadableWritablePair, StreamPipeOptions } from "node:stream/web"

// This type-only import resolves the `{@linkcode}` references and is erased at compile time.
// eslint-disable-next-line no-unused-vars
import type { fsConcurrency } from "spliterator/node/fs"

import { loadNodeFs } from "../internal/node-modules.js"

/**
 * A chainable operation in a fused pipeline.
 *
 * Ops are **descriptors** rather than closures over iteration state. `take` and `drop` counters live in the iterator,
 * rather than here, so a sequence can describe its chain before anyone pulls from it.
 */
type OpFn = (value: unknown, counter: number) => unknown

type Op =
	| { kind: typeof OP_MAP; fn: OpFn }
	| { kind: typeof OP_FILTER; fn: OpFn }
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

/**
 * Wrap a fusion-barrier generator so closing it also closes the sequence it reads from. `return()` on a generator that
 * was never started skips its body — and its `finally` — so without this, `barrier.take(0)` would leave an eager
 * upstream (an already-open file handle) unreleased. Once started, the generator's own `finally` closes `inner`;
 * closing it again is a no-op.
 */
function closingWith<U>(generator: AsyncGenerator<U>, inner: AsyncSequence<unknown>): AsyncIterable<U> {
	return {
		[Symbol.asyncIterator]: () => ({
			next: () => generator.next(),
			return: async () => {
				await generator.return(undefined)
				await inner.return()

				return { value: undefined, done: true }
			},
		}),
	}
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

/**
 * The fan-out used when {@linkcode ParallelMapSequenceOptions.concurrency} is omitted. Parallel callbacks on the
 * caller's thread only pay off for I/O, so the default presumes I/O: in Node it is {@linkcode fsConcurrency} from
 * `spliterator/node/fs` — libuv's threadpool size, the real ceiling on concurrent filesystem calls — resolved lazily
 * through the same dynamic import core uses for file sources, and once per module. Where that import fails or the
 * module is stubbed (browsers, web workers, bundler shims) libuv's own default of 4 stands in.
 */
function defaultConcurrency(): Promise<number> {
	// Optimistic, like `importVendor` in `XLSXSpliterator`: outside Node the module fails to load. `.catch` rather than
	// a rejection handler so a stub module whose `fsConcurrency` is missing or throws is also covered.
	defaultConcurrencyPromise ??= loadNodeFs()
		.then(({ fsConcurrency }) => fsConcurrency())
		.catch(() => 4)

	return defaultConcurrencyPromise
}

let defaultConcurrencyPromise: Promise<number> | undefined

/**
 * Validate a caller-supplied `concurrency` at construction, like {@linkcode AsyncSequence.take} and
 * {@linkcode AsyncSequence.chunks} do: `NaN` would otherwise start no callbacks and yield an empty sequence. Values
 * below 1 clamp to 1; `Infinity` is unbounded.
 */
function normalizeConcurrency(concurrency: number | undefined): number | undefined {
	if (concurrency === undefined) return undefined

	if (Number.isNaN(concurrency)) {
		throw new RangeError(`concurrency must be a number, got ${concurrency}`)
	}

	return Math.max(1, Math.trunc(concurrency))
}

async function* mapValuesConcurrently<T, U>(
	source: AsyncIterable<T>,
	fn: (value: T, counter: number) => U | PromiseLike<U>,
	concurrency: number | undefined,
	signal?: AbortSignal
): AsyncGenerator<U> {
	const limit = concurrency ?? (await defaultConcurrency())
	const upstream = source[Symbol.asyncIterator]()
	// Slots identify callbacks rather than values. A source may repeat a value, and equal values would otherwise
	// collapse into one entry, losing a result and deleting the wrong dispatch.
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

				const pending = Promise.resolve(produced).then((value) => ({ slot: current, value }))

				// A callback can reject while this loop waits on a slow `upstream.next()`. Attach a rejection handler here.
				// The race below still rethrows the error.
				pending.then(undefined, noop)
				inflight.set(current, pending)
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

async function* filterValuesConcurrently<T>(
	source: AsyncIterable<T>,
	fn: (value: T, counter: number) => unknown,
	concurrency: number | undefined,
	signal?: AbortSignal
): AsyncGenerator<T> {
	const limit = concurrency ?? (await defaultConcurrency())
	const upstream = source[Symbol.asyncIterator]()
	// A window of dispatched predicates in input order. `head` advances instead of `shift()`, and consumed entries are
	// spliced off once `head` reaches `limit` — amortized O(1) per item, and the array never holds more than
	// `2 * limit` entries, so a long stream does not retain every value it has passed.
	const window: { value: T; verdict: unknown }[] = []
	let head = 0
	let counter = 0
	let exhausted = false

	try {
		for (;;) {
			if (signal?.aborted) break

			while (!exhausted && window.length - head < limit) {
				const result = await upstream.next()

				if (result.done) {
					exhausted = true

					break
				}

				const verdict = fn(result.value, counter++)

				// A predicate can reject before its turn. Attach a handler here. The window rethrows the error when it reaches it.
				if (isThenable(verdict)) {
					Promise.resolve(verdict).then(undefined, noop)
				}

				window.push({ value: result.value, verdict })
			}

			if (head === window.length) break

			const { value, verdict } = window[head++]!

			if (head >= limit) {
				window.splice(0, head)
				head = 0
			}

			if (isThenable(verdict) ? await verdict : verdict) {
				yield value
			}
		}
	} finally {
		await upstream.return?.()
		await Promise.allSettled(window.slice(head).map((entry) => entry.verdict))
	}
}

function noop(): void {}

/**
 * Options for {@linkcode AsyncSequence.parallelMap} and {@linkcode AsyncSequence.parallelFilter}.
 */
export interface ParallelMapSequenceOptions {
	/**
	 * Maximum callbacks in flight at once. Defaults to the filesystem fan-out the runtime can actually service: libuv's
	 * threadpool size in Node ({@linkcode fsConcurrency} from `spliterator/node/fs`, 4 unless `UV_THREADPOOL_SIZE` says
	 * otherwise), and 4 elsewhere.
	 *
	 * For I/O-bound work this peaks **low**, often at ~2–3, and then _degrades_ as callers contend for the same disk or
	 * socket. Sweep it rather than reaching for `availableParallelism()`, which counts CPUs and does not measure I/O.
	 */
	concurrency?: number

	/**
	 * Abort signal. When aborted, iteration stops after the currently-yielded value. In-flight callbacks are allowed to
	 * settle so every rejection is observed.
	 */
	signal?: AbortSignal
}

/**
 * A lazy, chainable async iterator.
 *
 * The core methods (`map`, `filter`, `take`, `drop`, `flatMap`, `reduce`, `toArray`, `forEach`, `some`, `every`,
 * `find`) match the [async iterator helpers proposal][proposal] in name, arity, and semantics. This includes the
 * `counter` second argument handed to every callback. Callbacks may return promises. Code written against this keeps
 * working verbatim if the proposal ever ships natively.
 *
 * [proposal]: https://github.com/tc39/proposal-async-iterator-helpers
 *
 * **Chain depth is nearly free.** A chain is an op list plus a source rather than nested generators. It pays one async
 * boundary per item regardless of operator count. Only the op loop grows. Measured on Node 26 over 2M items: ~5.4M
 * items/s at three operators and ~4.9M/s at six, against ~2.3M/s for the equivalent nested-generator implementation,
 * where each operator adds a microtask hop. Doubling the operator count costs ~10% here and would cost ~2× there. Only
 * {@linkcode flatMap}, {@linkcode chunks}, {@linkcode parallelMap}, and {@linkcode parallelFilter} break fusion,
 * because they need inner-iterator state.
 *
 * Callback results are awaited **only when thenable**, so synchronous callbacks — the common case — cost no microtask
 * hop.
 *
 * **When not to reach for this.** Wrapping costs ~1.9× a bare async generator (~10.3M/s), one extra async frame per
 * item. On parsed rows (`JSON.parse` at ~1–3µs) that is 3–8%, which is small beside parsing. On raw
 * {@linkcode Uint8Array} ranges with no per-row parse it is most of the cost — iterate the {@linkcode AsyncSpliterator}
 * directly there.
 *
 * Single-shot, like the iterators the proposal specifies: iterating consumes the source.
 *
 * Calls to `next()` are not queued. Await each before the next, as `for await` and the stream adapters do; two pulls in
 * flight at once would race on the operator state.
 */
export class AsyncSequence<T> implements AsyncIterableIterator<T>, AsyncDisposable {
	readonly #source: SequenceSource<unknown>
	readonly #ops: readonly Op[]

	/**
	 * Indices of `take` ops, precomputed so the exhaustion pre-check does no scan when the chain has none.
	 */
	readonly #takeIndices: readonly number[]

	#upstream: AsyncIterator<unknown> | null = null
	#syncUpstream: Iterator<unknown> | null = null
	#counters: number[] | null = null
	#budgets: number[] | null = null
	#done = false

	/**
	 * Wrap a source as a sequence of its element type. Prefer {@link AsyncSequence.from}, which also passes an existing
	 * sequence through unchanged.
	 */
	constructor(source: SequenceSource<T>)
	/**
	 * Internal: an op list transforms the source's element type, so the source is untyped here.
	 *
	 * @internal
	 */
	constructor(source: SequenceSource<unknown>, ops: readonly Op[])
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
	public static from<T>(source: SequenceSource<T>): AsyncSequence<T> {
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
	public map<U>(fn: (value: T, counter: number) => U | PromiseLike<U>): AsyncSequence<U> {
		return this.#derive<U>({ kind: OP_MAP, fn: fn as OpFn })
	}

	/**
	 * Keep values for which the callback is truthy. The callback receives `(value, counter)` and may return a promise.
	 */
	public filter<S extends T>(predicate: (value: T, counter: number) => value is S): AsyncSequence<S>

	public filter(predicate: (value: T, counter: number) => unknown): AsyncSequence<T>

	public filter(fn: (value: T, counter: number) => unknown): AsyncSequence<T> {
		return this.#derive<T>({ kind: OP_FILTER, fn: fn as OpFn })
	}

	/**
	 * Yield at most `limit` values, then close the underlying iterator. `Infinity` leaves the sequence unbounded.
	 *
	 * The close is what makes this safe on a file-backed source — `take(5)` over a 40GB file releases the handle rather
	 * than leaving it open until GC.
	 */
	public take(limit: number): AsyncSequence<T> {
		const normalized = Math.trunc(limit)

		if (Number.isNaN(normalized) || normalized < 0) {
			throw new RangeError(`take(${limit}): limit must be a non-negative number`)
		}

		return this.#derive<T>({ kind: OP_TAKE, limit: normalized })
	}

	/**
	 * Skip the first `limit` values.
	 */
	public drop(limit: number): AsyncSequence<T> {
		const normalized = Math.trunc(limit)

		// `Infinity` is allowed, as the proposal allows it: it drops everything.
		if (Number.isNaN(normalized) || normalized < 0) {
			throw new RangeError(`drop(${limit}): limit must be a non-negative number`)
		}

		return this.#derive<T>({ kind: OP_DROP, limit: normalized })
	}

	/**
	 * Map each value to an iterable and flatten one level.
	 *
	 * **Fusion barrier.** Unlike the other operators this needs inner-iterator state, so it starts a fresh fused segment
	 * rather than joining the current op list. Stacking `flatMap` costs one async boundary each. Stacking
	 * `map`/`filter`/`take`/`drop` adds no boundary.
	 */
	public flatMap<U>(
		fn: (value: T, counter: number) => AsyncIterable<U> | Iterable<U> | PromiseLike<AsyncIterable<U> | Iterable<U>>
	): AsyncSequence<U> {
		return new AsyncSequence<U>(closingWith(flattenValues(this, fn), this))
	}

	//#endregion

	//#region Spec-compatible core — terminal

	/**
	 * Collect every remaining value into an array.
	 *
	 * **Reads the whole source into memory.** On a sequence backed by a file this defeats the point of streaming — filter
	 * and map first so only what you keep is materialized.
	 */
	public async toArray(): Promise<T[]> {
		const values: T[] = []

		for await (const value of this) {
			values.push(value)
		}

		return values
	}

	/**
	 * Collect every remaining value into a `Map`. The callback receives `(value, counter)` and may return a promise.
	 *
	 * ```ts
	 * const map = await AsyncSequence.from(["a", "b", "c"]).toMap((value) => {
	 * 	return [value, value.charCodeAt(0)]
	 * })
	 *
	 * for (const [key, value] of map) {
	 * 	console.log(key, value) // "a" 97, "b" 98, "c" 99
	 * }
	 * ```
	 */
	public async toMap<K, V>(
		fn: (value: T, counter: number) => readonly [K, V] | PromiseLike<readonly [K, V]>
	): Promise<Map<K, V>> {
		const map = new Map<K, V>()

		let counter = 0

		for await (const value of this) {
			const entry = await fn(value, counter++)
			map.set(entry[0], entry[1])
		}

		return map
	}

	/**
	 * Collect every remaining value into a `Set`, de-duplicated. With a callback, its results are collected instead; it
	 * receives `(value, counter)` and may return a promise.
	 *
	 * ```ts
	 * const letters = await AsyncSequence.from(["a", "b", "a"]).toSet() // Set { "a", "b" }
	 *
	 * const codes = await AsyncSequence.from(["a", "b", "c"]).toSet((value) => {
	 * 	return value.charCodeAt(0)
	 * })
	 *
	 * for (const value of codes) {
	 * 	console.log(value) // 97, 98, 99
	 * }
	 * ```
	 */
	public toSet(): Promise<Set<T>>
	public toSet<U>(fn: (value: T, counter: number) => U | PromiseLike<U>): Promise<Set<U>>
	public async toSet<U>(fn?: (value: T, counter: number) => U | PromiseLike<U>): Promise<Set<T | U>> {
		const set = new Set<T | U>()

		if (!fn) {
			for await (const value of this) {
				set.add(value)
			}

			return set
		}

		let counter = 0

		for await (const value of this) {
			const entry = await fn(value, counter++)
			set.add(entry)
		}

		return set
	}

	/**
	 * Returns a copy of the sequence's values, sorted.
	 *
	 * @param compareFn A function that defines the sort order. If omitted, the elements are sorted in ascending, ASCII
	 *   character order.
	 */
	public toSorted(compareFn?: (a: T, b: T) => number): Promise<T[]> {
		return this.toArray().then((array) => array.toSorted(compareFn))
	}

	/**
	 * Invoke the callback for each value, for side effects.
	 */
	public async forEach(fn: (value: T, counter: number) => unknown): Promise<void> {
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
	public reduce(fn: (accumulator: T, value: T, counter: number) => T | PromiseLike<T>): Promise<T>
	public reduce<U>(fn: (accumulator: U, value: T, counter: number) => U | PromiseLike<U>, initialValue: U): Promise<U>
	public async reduce<U>(
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
	public async some(fn: (value: T, counter: number) => unknown): Promise<boolean> {
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
	public async every(fn: (value: T, counter: number) => unknown): Promise<boolean> {
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
	public async find(fn: (value: T, counter: number) => unknown): Promise<T | undefined> {
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
	 * This operation is a **fusion barrier**, like {@linkcode flatMap}.
	 */
	public chunks(size: number): AsyncSequence<T[]> {
		const normalized = Math.trunc(size)

		if (!Number.isFinite(normalized) || normalized < 1) {
			throw new RangeError(`chunks(${size}): size must be a positive finite number`)
		}

		return new AsyncSequence<T[]>(closingWith(batchValues(this, normalized), this))
	}

	/**
	 * Map values through a callback with up to `concurrency` calls in flight, yielding in **completion order** — not
	 * input order. When only membership changes and order must survive, use {@linkcode parallelFilter}.
	 *
	 * The callback is a closure, so it runs on the caller's thread. This overlaps _latency_ (file reads, network) and
	 * does not improve CPU-bound work. Use `parallelMapWorkers` or `AsyncSpliterator.asManyWorkers`, which take a module
	 * path precisely because a closure cannot.
	 *
	 * **Fusion barrier**, like {@linkcode flatMap}.
	 */
	public parallelMap<U>(
		fn: (value: T, counter: number) => U | PromiseLike<U>,
		{ concurrency, signal }: ParallelMapSequenceOptions = {}
	): AsyncSequence<U> {
		return new AsyncSequence<U>(
			closingWith(mapValuesConcurrently(this, fn, normalizeConcurrency(concurrency), signal), this)
		)
	}

	/**
	 * Keep values the predicate accepts, with up to `concurrency` predicate calls in flight. The predicate's result is
	 * truthiness-tested, like {@linkcode filter}.
	 *
	 * Unlike {@linkcode parallelMap}, this yields in **input order**. A filter emits the input itself, so no value is
	 * gained by emitting early, and a stable order keeps results reproducible (a list of existing paths, for one). The
	 * price is head-of-line blocking: dispatch runs at most `concurrency` predicates ahead of the oldest unsettled one,
	 * so a slow predicate stalls the window behind it. That keeps memory bounded. Use `parallelMap` when throughput under
	 * uneven latency matters more than order.
	 *
	 * Same caveats as {@linkcode parallelMap}: the predicate is a closure on the caller's thread, so this overlaps I/O
	 * latency rather than CPU work. Use `parallelMapWorkers` for CPU work. This operation is a **fusion barrier**, like
	 * {@linkcode flatMap}.
	 */
	public parallelFilter<S extends T>(
		predicate: (value: T, counter: number) => value is S,
		options?: ParallelMapSequenceOptions
	): AsyncSequence<S>
	public parallelFilter(
		fn: (value: T, counter: number) => unknown,
		options?: ParallelMapSequenceOptions
	): AsyncSequence<T>
	public parallelFilter(
		fn: (value: T, counter: number) => unknown,
		{ concurrency, signal }: ParallelMapSequenceOptions = {}
	): AsyncSequence<T> {
		return new AsyncSequence<T>(
			closingWith(filterValuesConcurrently(this, fn, normalizeConcurrency(concurrency), signal), this)
		)
	}

	/**
	 * Expose the sequence as a web stream, for interop with `pipeThrough`/`pipeTo` consumers.
	 */
	public toReadableStream(): ReadableStream<T> {
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
	public pipeThrough<U>(transform: ReadableWritablePair<U, T>, options?: StreamPipeOptions): ReadableStream<U> {
		return this.toReadableStream().pipeThrough(transform, options)
	}

	//#endregion

	//#region Iteration

	public async next(): Promise<IteratorResult<T>> {
		if (this.#done) return { value: undefined, done: true }

		const ops = this.#ops
		const length = ops.length

		this.#counters ??= Array.from<number>({ length }).fill(0)

		this.#budgets ??= ops.map((op) => (op.kind === OP_TAKE || op.kind === OP_DROP ? op.limit : 0))

		const counters = this.#counters
		const budgets = this.#budgets

		// A satisfied `take` closes the source before pulling again. `take(5)` must not read the sixth row of a huge file.
		for (const index of this.#takeIndices) {
			if (budgets[index]! <= 0) return this.#finish()
		}

		let upstream: AsyncIterator<unknown> | Iterator<unknown>

		try {
			upstream = await this.#openUpstream()
		} catch (error) {
			// A source that cannot open is not retried: the next pull reports done rather than invoking the thunk again.
			this.#done = true

			throw error
		}

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
							if (budgets[i]! <= 0) {
								const finalResult = await this.#finish()

								return finalResult
							}

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
	public async return(): Promise<IteratorResult<T>> {
		return this.#finish()
	}

	async #finish(): Promise<IteratorResult<T>> {
		if (this.#done) return { value: undefined, done: true }

		this.#done = true

		// An eager source may hold a resource before the first pull, so closing reaches it even for `take(0)`. A thunk that
		// was never invoked has no resource to release. Invoking it here would open a file only to close it.
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

	/**
	 * Close the sequence, so `await using rows = CSVSpliterator.fromAsync(...)` releases the source on scope exit.
	 */
	public async [Symbol.asyncDispose](): Promise<void> {
		await this.#finish()
	}

	//#endregion
}
