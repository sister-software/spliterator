/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { IndexQueue } from "spliterator"
import { describe, expect, test } from "vitest"

describe("IndexQueue", () => {
	test("dequeues tuples in FIFO order", () => {
		const q = new IndexQueue()
		q.enqueue([0, 5])
		q.enqueue([5, 9])
		q.enqueue([10, 12])

		expect(q.dequeue()).toEqual([0, 5])
		expect(q.dequeue()).toEqual([5, 9])
		expect(q.dequeue()).toEqual([10, 12])
		expect(q.dequeue()).toBeUndefined()
	})

	test("tracks size and byteLength as items move through", () => {
		const q = new IndexQueue()
		expect(q.size).toBe(0)
		expect(q.byteLength).toBe(0)

		q.enqueue([0, 5]) // 5 bytes
		q.enqueue([10, 13]) // 3 bytes
		expect(q.size).toBe(2)
		expect(q.byteLength).toBe(8)

		q.dequeue()
		expect(q.size).toBe(1)
		expect(q.byteLength).toBe(3)
	})

	test("peek and peekLast return ends without removing", () => {
		const q = new IndexQueue()
		expect(q.peek()).toBeUndefined()
		expect(q.peekLast()).toBeUndefined()

		q.enqueue([0, 5])
		q.enqueue([5, 9])
		q.enqueue([9, 20])

		expect(q.peek()).toEqual([0, 5])
		expect(q.peekLast()).toEqual([9, 20])
		expect(q.size).toBe(3) // unchanged
	})

	test("clear empties the queue", () => {
		const q = new IndexQueue()
		q.enqueue([0, 5])
		q.clear()

		expect(q.size).toBe(0)
		expect(q.byteLength).toBe(0)
		expect(q.dequeue()).toBeUndefined()
	})

	test("is iterable, draining in FIFO order", () => {
		const q = new IndexQueue()
		q.enqueue([0, 1])
		q.enqueue([1, 2])

		expect([...q]).toEqual([
			[0, 1],
			[1, 2],
		])
		expect(q.size).toBe(0)
	})

	// Interleaved enqueue/dequeue across many items exercises the head-pointer
	// advance and the periodic compaction path while preserving FIFO + accounting.
	test("stays correct under heavy interleaving past the compaction threshold", () => {
		const q = new IndexQueue()
		let nextToEnqueue = 0
		let nextExpected = 0

		// Prime a backlog so head can advance well past any compaction threshold.
		for (let i = 0; i < 4000; i++) q.enqueue([nextToEnqueue, nextToEnqueue++ + 1])

		for (let round = 0; round < 20000; round++) {
			const got = q.dequeue()
			expect(got).toEqual([nextExpected, nextExpected + 1])
			nextExpected++

			// Refill faster than draining for a while, then let it drain.
			if (round % 2 === 0) {
				q.enqueue([nextToEnqueue, nextToEnqueue++ + 1])
				q.enqueue([nextToEnqueue, nextToEnqueue++ + 1])
			}
		}

		// Drain the remainder and confirm contiguous ordering held throughout.
		let last = nextExpected

		for (const [start] of q) {
			expect(start).toBe(last)
			last++
		}
		expect(q.size).toBe(0)
		expect(q.byteLength).toBe(0)
	})
})
