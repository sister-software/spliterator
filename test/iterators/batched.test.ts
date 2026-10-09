/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

import { AsyncSequence } from "spliterator"
import { beforeAll, describe, expect, test } from "vitest"

// `batched` is internal, so its type is stripped from the published surface; load it like the other internals.
let batched: <T>(source: AsyncIterable<readonly T[]>) => AsyncIterable<readonly T[]>

beforeAll(async () => {
	const modulePath = "../../out/lib/iterators/AsyncSequence"

	;({ batched } = await import(modulePath))
})

describe("batched sources", () => {
	test("elements come out one at a time, in order, across batches", async () => {
		const source = batched(
			(async function* () {
				yield [1, 2]
				yield [3]
				yield [4, 5, 6]
			})()
		)

		expect(await AsyncSequence.from(source).toArray()).toEqual([1, 2, 3, 4, 5, 6])
	})

	test("empty batches are skipped, including a leading one", async () => {
		const source = batched(
			(async function* () {
				yield []
				yield [1]
				yield []
				yield []
				yield [2]
				yield []
			})()
		)

		expect(await AsyncSequence.from(source).toArray()).toEqual([1, 2])
	})

	test("ops see the elements, not the batches", async () => {
		const source = batched<number>(
			(async function* () {
				yield [1, 2, 3]
				yield [4, 5, 6]
			})()
		)

		const out = await AsyncSequence.from(source as AsyncIterable<number>)
			.filter((n) => n % 2 === 0)
			.map((n, i) => `${i}:${n}`)
			.toArray()

		expect(out).toEqual(["0:2", "1:4", "2:6"])
	})

	test("an early exit closes the source mid-batch and pulls no further batch", async () => {
		let pulled = 0
		let closed = false

		const source = batched(
			(async function* () {
				try {
					pulled++
					yield [1, 2, 3]

					pulled++

					yield [4, 5, 6]
				} finally {
					closed = true
				}
			})()
		)

		expect(await AsyncSequence.from(source).take(2).toArray()).toEqual([1, 2])

		expect(pulled).toBe(1)
		expect(closed).toBe(true)
	})

	test("a thunk may resolve to a batched source", async () => {
		const source = () =>
			Promise.resolve(
				batched(
					(async function* () {
						yield ["a", "b"]
					})()
				)
			)

		expect(await AsyncSequence.from(source).toArray()).toEqual(["a", "b"])
	})
})
