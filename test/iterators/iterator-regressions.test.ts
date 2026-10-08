/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { AsyncSequence, Sequence, zipAsync, zipSync } from "spliterator"
import { describe, expect, test } from "vitest"

function* range(n: number): Generator<number> {
	for (let i = 0; i < n; i++) {
		yield i
	}
}

async function* rangeAsync(n: number): AsyncGenerator<number> {
	for (let i = 0; i < n; i++) {
		yield i
	}
}

describe("drop(Infinity)", () => {
	test("drops everything on both sequences, as the proposal specifies", async () => {
		expect(Sequence.from(range(3)).drop(Infinity).toArray()).toEqual([])
		expect(await AsyncSequence.from(rangeAsync(3)).drop(Infinity).toArray()).toEqual([])
	})

	test("still rejects NaN and negatives", () => {
		expect(() => Sequence.from(range(3)).drop(-1)).toThrow(RangeError)
		expect(() => AsyncSequence.from(rangeAsync(3)).drop(Number.NaN)).toThrow(RangeError)
	})
})

describe("AsyncSequence disposal", () => {
	test("await using closes the source", async () => {
		let closed = false

		async function* source() {
			try {
				yield 1
				yield 2
			} finally {
				closed = true
			}
		}

		{
			await using seq = AsyncSequence.from(source())

			expect((await seq.next()).value).toBe(1)
		}

		expect(closed).toBe(true)
	})
})

describe("zip closes both sides on early exit", () => {
	test("zipSync", () => {
		const closed = { a: false, b: false }

		function* a() {
			try {
				yield* range(10)
			} finally {
				closed.a = true
			}
		}

		function* b() {
			try {
				yield* range(2)
			} finally {
				closed.b = true
			}
		}

		// oxlint-disable-next-line no-unreachable-loop
		for (const _ of zipSync(a(), b())) {
			void _

			break
		}

		expect(closed).toEqual({ a: true, b: true })
	})

	test("zipAsync", async () => {
		const closed = { a: false, b: false }

		async function* a() {
			try {
				yield* rangeAsync(10)
			} finally {
				closed.a = true
			}
		}

		async function* b() {
			try {
				yield* rangeAsync(2)
			} finally {
				closed.b = true
			}
		}

		// oxlint-disable-next-line no-unreachable-loop
		for await (const _ of zipAsync(a(), b())) {
			void _

			break
		}

		expect(closed).toEqual({ a: true, b: true })
	})
})

describe("a source thunk that throws", () => {
	test("is invoked once and the async sequence is then done", async () => {
		let calls = 0

		const seq = AsyncSequence.from<number>(() => {
			calls++

			throw new Error("open failed")
		})

		await expect(seq.next()).rejects.toThrow("open failed")
		expect(await seq.next()).toEqual({ value: undefined, done: true })
		expect(calls).toBe(1)
	})

	test("is invoked once and the sync sequence is then done", () => {
		let calls = 0

		const seq = Sequence.from<number>(() => {
			calls++

			throw new Error("open failed")
		})

		expect(() => seq.next()).toThrow("open failed")
		expect(seq.next()).toEqual({ value: undefined, done: true })
		expect(calls).toBe(1)
	})
})
