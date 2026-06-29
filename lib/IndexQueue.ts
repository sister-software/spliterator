/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import type { ByteRange } from "./shared.js"

/**
 * Number of consumed slots (`start`/`end` values, i.e. 2 per dequeued tuple) the head pointer may advance before the
 * backing array is compacted. Bounds wasted space under partial draining while keeping compaction rare enough that
 * `dequeue` stays amortized O(1).
 */
const COMPACT_THRESHOLD = 1024

/**
 * A first-in, first-out queue for marking and dequeuing index tuples.
 */
export class IndexQueue implements IterableIterator<ByteRange> {
	/**
	 * Flat backing store of `[start, end]` pairs. Consumed entries before `#head` are kept until the queue drains or
	 * `#head` crosses {@link COMPACT_THRESHOLD}, so `dequeue` stays O(1) instead of shifting the whole array on every
	 * yield.
	 */
	#tuples: number[] = []

	/** Index of the next tuple's `start` in {@link #tuples}; advances by 2 per dequeue. */
	#head = 0

	/**
	 * The number of tuples in the queue.
	 */
	public get size(): number {
		return (this.#tuples.length - this.#head) / 2
	}

	#byteLength = 0

	/**
	 * The total byte length spanned by the tuples in the queue.
	 *
	 * This is a cached value and may not be accurate if the queue is modified externally.
	 */
	public get byteLength(): number {
		return this.#byteLength
	}

	/**
	 * Append a new tuple to the queue.
	 */
	public enqueue(tuple: ByteRange): void {
		this.#tuples.push(tuple[0])
		this.#tuples.push(tuple[1])

		this.#byteLength += tuple[1] - tuple[0]
	}

	/**
	 * Get the next tuple in the queue, removing it.
	 */
	public dequeue(): ByteRange | undefined {
		if (this.#head >= this.#tuples.length) return

		const start = this.#tuples[this.#head]!
		const end = this.#tuples[this.#head + 1]!

		this.#head += 2
		this.#byteLength -= end - start

		// Reclaim consumed space: reset outright once fully drained (the common per-fill pattern
		// in both engines), otherwise compact periodically so the backing array can't grow
		// unbounded when the queue is only partially drained between enqueues.
		if (this.#head >= this.#tuples.length) {
			this.#tuples.length = 0
			this.#head = 0
		} else if (this.#head >= COMPACT_THRESHOLD) {
			this.#tuples.splice(0, this.#head)
			this.#head = 0
		}

		return [start, end]
	}

	/**
	 * Peek at the next tuple in the queue without removing it.
	 */
	public peek(): ByteRange | undefined {
		if (this.#head >= this.#tuples.length) return

		return [this.#tuples[this.#head]!, this.#tuples[this.#head + 1]!]
	}

	/**
	 * Peek at the last tuple in the queue without removing it.
	 */
	public peekLast(): ByteRange | undefined {
		if (this.#tuples.length - this.#head < 2) return

		const end = this.#tuples.length

		return [this.#tuples[end - 2]!, this.#tuples[end - 1]!]
	}

	/**
	 * Clear the queue.
	 */
	public clear(): void {
		this.#tuples.length = 0
		this.#head = 0
		this.#byteLength = 0
	}

	/**
	 * Alias for `dequeue`, conforming to the iterator protocol.
	 */
	public next(): IteratorResult<ByteRange> {
		const tuple = this.dequeue()

		if (tuple) {
			return { done: false, value: tuple }
		}

		return { done: true, value: undefined }
	}

	public [Symbol.iterator](): IndexQueue {
		return this
	}
}
