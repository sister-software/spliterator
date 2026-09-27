/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { ReadableStream, type ReadableWritablePair, type StreamPipeOptions } from "node:stream/web"

import { AsyncSequence } from "./AsyncSequence.js"

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

/**
 * What a synchronous sequence can be built over.
 *
 * The thunk form defers construction until the first pull, which is what lets a `from` that would otherwise open a file
 * return a sequence immediately — the caller chains, and nothing is read until something iterates.
 */
export type SyncSequenceSource<T> = Iterable<T> | (() => Iterable<T>)

/**
 * Wrap a fusion-barrier generator so closing it also closes the sequence it reads from. `return()` on a generator that
 * was never started skips its body — and its `finally` — so without this, `barrier.take(0)` would leave an eager
 * upstream (an already-open resource) unreleased. Once started, the generator's own `finally` closes `inner`; closing
 * it again is a no-op.
 */
function closingWith<U>(generator: Generator<U>, inner: Sequence<unknown>): Iterable<U> {
	return {
		[Symbol.iterator]: () => ({
			next: () => generator.next(),
			return: () => {
				generator.return(undefined)
				inner.return()

				return { value: undefined, done: true }
			},
		}),
	}
}

function* flattenValues<T, U>(source: Iterable<T>, fn: (value: T, counter: number) => Iterable<U>): Generator<U> {
	let counter = 0

	for (const value of source) {
		const inner = fn(value, counter++)

		if (inner === null || typeof inner !== "object") {
			throw new TypeError(`flatMap callback must return an iterable, received ${typeof inner}`)
		}

		yield* inner
	}
}

function* batchValues<T>(source: Iterable<T>, size: number): Generator<T[]> {
	let batch: T[] = []

	for (const value of source) {
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
 * A lazy, chainable synchronous iterator — the sibling of {@linkcode AsyncSequence}, and what every synchronous `from`
 * returns.
 *
 * The core methods (`map`, `filter`, `take`, `drop`, `flatMap`, `reduce`, `toArray`, `forEach`, `some`, `every`,
 * `find`) match the [iterator helpers][helpers] Node ships natively, in name, arity, and semantics — including the
 * `counter` second argument handed to every callback. What the native helpers do not have is the rest of this class:
 * {@linkcode toMap}, {@linkcode toSet}, {@linkcode toSorted}, {@linkcode chunks}, {@linkcode toReadableStream}, and
 * {@linkcode toAsync}. Those are the reason to wrap rather than return a bare generator — and because the core methods
 * return a `Sequence` rather than a native `Iterator Helper`, they survive anywhere in the chain instead of only at its
 * head.
 *
 * [helpers]: https://github.com/tc39/proposal-iterator-helpers
 *
 * **Chain depth is nearly free.** A chain is an op list plus a source, not nested generators, so only the op loop grows
 * as operators stack. Only {@linkcode flatMap} and {@linkcode chunks} break fusion, because they need inner-iterator
 * state.
 *
 * **Nothing is materialized implicitly.** Every operator stays lazy; only the `to*` collectors and `toSorted` read the
 * sequence into memory, and they say so.
 *
 * Single-shot, like the iterators the proposal specifies: iterating consumes the source.
 */
export class Sequence<T> implements IterableIterator<T>, Disposable {
	readonly #source: SyncSequenceSource<unknown>
	readonly #ops: readonly Op[]

	/**
	 * Indices of `take` ops, precomputed so the exhaustion pre-check costs nothing when there are none.
	 */
	readonly #takeIndices: readonly number[]

	#upstream: Iterator<unknown> | null = null
	#counters: number[] | null = null
	#budgets: number[] | null = null
	#done = false

	/**
	 * Wrap a source as a sequence of its element type. Prefer {@link Sequence.from}, which also passes an existing
	 * sequence through unchanged.
	 */
	constructor(source: SyncSequenceSource<T>)
	/**
	 * Internal: an op list transforms the source's element type, so the source is untyped here.
	 *
	 * @internal
	 */
	constructor(source: SyncSequenceSource<unknown>, ops: readonly Op[])
	constructor(source: SyncSequenceSource<unknown>, ops: readonly Op[] = []) {
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
	 * Wrap any iterable as a chainable sequence.
	 */
	public static from<T>(source: SyncSequenceSource<T>): Sequence<T> {
		return source instanceof Sequence ? source : new Sequence<T>(source)
	}

	#openUpstream(): Iterator<unknown> {
		if (this.#upstream) return this.#upstream

		const source = this.#source
		const resolved = typeof source === "function" ? source() : source

		this.#upstream = resolved[Symbol.iterator]()

		return this.#upstream
	}

	#derive<U>(op: Op): Sequence<U> {
		return new Sequence<U>(this.#source, [...this.#ops, op])
	}

	//#region Spec-compatible core — lazy

	/**
	 * Transform each value. The callback receives `(value, counter)`.
	 */
	public map<U>(fn: (value: T, counter: number) => U): Sequence<U> {
		return this.#derive<U>({ kind: OP_MAP, fn })
	}

	/**
	 * Keep values for which the callback is truthy. The callback receives `(value, counter)`.
	 */
	public filter<S extends T>(predicate: (value: T, counter: number) => value is S): Sequence<S>

	public filter(predicate: (value: T, counter: number) => unknown): Sequence<T>

	public filter(fn: (value: T, counter: number) => unknown): Sequence<T> {
		return this.#derive<T>({ kind: OP_FILTER, fn })
	}

	/**
	 * Yield at most `limit` values, then close the underlying iterator. `Infinity` leaves the sequence unbounded.
	 *
	 * The close is what lets a source holding a resource — a file-backed {@linkcode Spliterator}, say — release it on
	 * `take(5)` rather than waiting for GC.
	 */
	public take(limit: number): Sequence<T> {
		const normalized = Math.trunc(limit)

		if (Number.isNaN(normalized) || normalized < 0) {
			throw new RangeError(`take(${limit}): limit must be a non-negative number`)
		}

		return this.#derive<T>({ kind: OP_TAKE, limit: normalized })
	}

	/**
	 * Skip the first `limit` values.
	 */
	public drop(limit: number): Sequence<T> {
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
	 * rather than joining the current op list.
	 */
	public flatMap<U>(fn: (value: T, counter: number) => Iterable<U>): Sequence<U> {
		return new Sequence<U>(closingWith(flattenValues(this, fn), this))
	}

	//#endregion

	//#region Spec-compatible core — terminal

	/**
	 * Collect every remaining value into an array.
	 *
	 * **Reads the whole source into memory.** On a sequence backed by a file this defeats the point of streaming — filter
	 * and map first so only what you keep is materialized.
	 */
	public toArray(): T[] {
		const values: T[] = []

		for (const value of this) {
			values.push(value)
		}

		return values
	}

	/**
	 * Collect every remaining value into a `Map`. The callback receives `(value, counter)`.
	 *
	 * ```ts
	 * const map = Sequence.from(["a", "b", "c"]).toMap((value) => {
	 * 	return [value, value.charCodeAt(0)]
	 * })
	 *
	 * for (const [key, value] of map) {
	 * 	console.log(key, value) // "a" 97, "b" 98, "c" 99
	 * }
	 * ```
	 */
	public toMap<K, V>(fn: (value: T, counter: number) => readonly [K, V]): Map<K, V> {
		const map = new Map<K, V>()

		let counter = 0

		for (const value of this) {
			const entry = fn(value, counter++)
			map.set(entry[0], entry[1])
		}

		return map
	}

	/**
	 * Collect every remaining value into a `Set`. The callback receives `(value, counter)`.
	 *
	 * ```ts
	 * const set = Sequence.from(["a", "b", "c"]).toSet((value) => {
	 * 	return value.charCodeAt(0)
	 * })
	 *
	 * for (const value of set) {
	 * 	console.log(value) // 97, 98, 99
	 * }
	 * ```
	 */
	public toSet<U>(fn: (value: T, counter: number) => U): Set<U> {
		const set = new Set<U>()

		let counter = 0

		for (const value of this) {
			set.add(fn(value, counter++))
		}

		return set
	}

	/**
	 * Returns a copy of the sequence's values, sorted.
	 *
	 * @param compareFn A function that defines the sort order. If omitted, the elements are sorted in ascending, ASCII
	 *   character order.
	 */
	public toSorted(compareFn?: (a: T, b: T) => number): T[] {
		return this.toArray().toSorted(compareFn)
	}

	/**
	 * Invoke the callback for each value, for side effects.
	 */
	public forEach(fn: (value: T, counter: number) => unknown): void {
		let counter = 0

		for (const value of this) {
			fn(value, counter++)
		}
	}

	/**
	 * Fold the sequence to a single value. Without `initialValue` the first value seeds the accumulator, and an empty
	 * sequence is a `TypeError` — matching `Array.prototype.reduce`.
	 */
	public reduce(fn: (accumulator: T, value: T, counter: number) => T): T
	public reduce<U>(fn: (accumulator: U, value: T, counter: number) => U, initialValue: U): U
	public reduce<U>(fn: (accumulator: U, value: T, counter: number) => U, ...rest: [initialValue?: U]): U {
		let accumulator = rest[0] as U
		let seeded = rest.length > 0
		let counter = 0

		for (const value of this) {
			if (!seeded) {
				accumulator = value as unknown as U
				seeded = true

				counter++

				continue
			}

			accumulator = fn(accumulator, value, counter++)
		}

		if (!seeded) throw new TypeError("reduce of empty sequence with no initial value")

		return accumulator
	}

	/**
	 * Whether any value satisfies the callback. Short-circuits and closes the underlying iterator.
	 */
	public some(fn: (value: T, counter: number) => unknown): boolean {
		let counter = 0

		for (const value of this) {
			if (fn(value, counter++)) return true
		}

		return false
	}

	/**
	 * Whether every value satisfies the callback. Short-circuits and closes the underlying iterator.
	 */
	public every(fn: (value: T, counter: number) => unknown): boolean {
		let counter = 0

		for (const value of this) {
			if (!fn(value, counter++)) return false
		}

		return true
	}

	/**
	 * The first value satisfying the callback, or `undefined`. Short-circuits and closes the underlying iterator.
	 */
	public find(fn: (value: T, counter: number) => unknown): T | undefined {
		let counter = 0

		for (const value of this) {
			if (fn(value, counter++)) return value
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
	public chunks(size: number): Sequence<T[]> {
		const normalized = Math.trunc(size)

		if (!Number.isFinite(normalized) || normalized < 1) {
			throw new RangeError(`chunks(${size}): size must be a positive finite number`)
		}

		return new Sequence<T[]>(closingWith(batchValues(this, normalized), this))
	}

	/**
	 * Continue the chain asynchronously — the bridge to {@linkcode AsyncSequence}'s own extras, `parallelMap` and
	 * `parallelFilter` above all, whose callbacks may return promises.
	 *
	 * The values still arrive synchronously; `AsyncSequence` keeps a synchronous upstream as such rather than allocating
	 * a promise per pull.
	 */
	public toAsync(): AsyncSequence<T> {
		return AsyncSequence.from<T>(this)
	}

	/**
	 * Expose the sequence as a web stream, for interop with `pipeThrough`/`pipeTo` consumers.
	 */
	public toReadableStream(): ReadableStream<T> {
		const iterator = this[Symbol.iterator]()

		return new ReadableStream<T>({
			pull: (controller) => {
				const { done, value } = iterator.next()

				if (done) {
					controller.close()
				} else {
					controller.enqueue(value)
				}
			},
			cancel: () => void iterator.return?.(),
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

	public next(): IteratorResult<T> {
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

		const upstream = this.#openUpstream()

		try {
			outer: for (;;) {
				const result = upstream.next()

				if (result.done) {
					this.#done = true

					return { value: undefined, done: true }
				}

				let value: unknown = result.value

				for (let i = 0; i < length; i++) {
					const op = ops[i]!

					switch (op.kind) {
						case OP_MAP: {
							value = op.fn(value, counters[i]!++)

							break
						}

						case OP_FILTER: {
							if (!op.fn(value, counters[i]!++)) continue outer

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
			// A throwing `next()` does not make `for..of` call `return()` — the iterator is presumed broken — so a throwing
			// callback would otherwise strand the source's resources.
			this.#finish()

			throw error
		}
	}

	/**
	 * Close the sequence and release the underlying source.
	 */
	public return(): IteratorResult<T> {
		return this.#finish()
	}

	#finish(): IteratorResult<T> {
		if (this.#done) return { value: undefined, done: true }

		this.#done = true

		// An eager source may already hold a resource that no pull ever touched, so closing has to reach it even along
		// paths like `take(0)`. A thunk source that was never invoked has nothing open to release, and invoking it here
		// would open a file purely to close it.
		const source = this.#source

		const upstream = this.#upstream ?? (typeof source === "function" ? null : source[Symbol.iterator]())

		this.#upstream = null

		upstream?.return?.()

		return { value: undefined, done: true }
	}

	public [Symbol.iterator](): IterableIterator<T> {
		return this
	}

	public [Symbol.dispose](): void {
		this.#finish()
	}

	//#endregion
}
