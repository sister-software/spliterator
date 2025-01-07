/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { ByteRange } from "./shared.js"

/**
 * A first-in, first-out queue for marking and dequeuing index tuples.
 */
export class IndexQueue implements IterableIterator<ByteRange> {
	#tuples: number[] = []

	/**
	 * The number of tuples in the queue.
	 */
	public get size(): number {
		return this.#tuples.length / 2
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
		this.#tuples.push(...tuple)

		this.#byteLength += tuple[1] - tuple[0]
	}

	/**
	 * Get the next tuple in the queue, removing it.
	 */
	public dequeue(): ByteRange | undefined {
		if (this.#tuples.length < 2) return

		const tuple = this.#tuples.splice(0, 2) as ByteRange

		this.#byteLength -= tuple[1] - tuple[0]

		return tuple as ByteRange
	}

	/**
	 * Peek at the next tuple in the queue without removing it.
	 */
	public peek(): ByteRange | undefined {
		if (this.#tuples.length < 2) return

		return this.#tuples.slice(0, 2) as ByteRange
	}

	/**
	 * Peek at the last tuple in the queue without removing it.
	 */
	public peekLast(): ByteRange | undefined {
		if (this.#tuples.length < 2) return

		return this.#tuples.slice(-2) as ByteRange
	}

	/**
	 * Clear the queue.
	 */
	public clear(): void {
		this.#tuples.length = 0
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
