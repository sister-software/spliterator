/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { AsyncSequence } from "spliterator"
import { describe, expect, test } from "vitest"

async function* range(count: number, start = 0): AsyncGenerator<number> {
	for (let i = 0; i < count; i++) {
		yield start + i
	}
}

/**
 * A source that records how many values were pulled and whether it was closed, so laziness and closure can be asserted
 * rather than inferred.
 */
function spySource(count: number) {
	const state = { pulled: 0, closed: false }

	const iterable: AsyncIterable<number> = {
		[Symbol.asyncIterator]() {
			let i = 0

			return {
				next: async () => {
					if (i >= count) return { value: undefined, done: true }

					state.pulled++

					return { value: i++, done: false }
				},
				return: async () => {
					state.closed = true

					return { value: undefined, done: true }
				},
			} as AsyncIterator<number>
		},
	}

	return { iterable, state }
}

describe("core semantics", () => {
	test("map, filter, take, drop compose", async () => {
		const result = await AsyncSequence.from(range(10))
			.map((value) => value * 2)
			.filter((value) => value % 3 === 0)
			.drop(1)
			.take(2)
			.toArray()

		expect(result).toEqual([6, 12])
	})

	test("callbacks receive a per-operator counter", async () => {
		const mapCounters: number[] = []
		const filterCounters: number[] = []

		await AsyncSequence.from(range(4))
			.filter((_, counter) => {
				filterCounters.push(counter)

				return true
			})
			.map((value, counter) => {
				mapCounters.push(counter)

				return value
			})
			.toArray()

		expect(filterCounters).toEqual([0, 1, 2, 3])
		expect(mapCounters).toEqual([0, 1, 2, 3])
	})

	test("a filter's counter counts what it receives, not what it passes", async () => {
		const seen: number[] = []

		await AsyncSequence.from(range(6))
			.filter((value) => value % 2 === 0)
			.filter((_, counter) => {
				seen.push(counter)

				return true
			})
			.toArray()

		expect(seen).toEqual([0, 1, 2])
	})

	test("promise-returning callbacks are awaited", async () => {
		const result = await AsyncSequence.from(range(4))
			.map(async (value) => value * 10)
			.filter(async (value) => value > 5)
			.toArray()

		expect(result).toEqual([10, 20, 30])
	})

	test("wraps a synchronous iterable", async () => {
		expect(
			await AsyncSequence.from([1, 2, 3])
				.map((value) => value + 1)
				.toArray()
		).toEqual([2, 3, 4])
	})

	test("from() passes an existing sequence through unchanged", () => {
		const sequence = AsyncSequence.from(range(1))

		expect(AsyncSequence.from(sequence)).toBe(sequence)
	})
})

describe("deferred sources", () => {
	test("wraps a thunk returning an async iterable", async () => {
		expect(await AsyncSequence.from(() => range(3)).toArray()).toEqual([0, 1, 2])
	})

	test("wraps a thunk returning a promise", async () => {
		expect(await AsyncSequence.from(async () => range(3)).toArray()).toEqual([0, 1, 2])
	})

	test("wraps a thunk returning a sync iterable", async () => {
		expect(await AsyncSequence.from(() => [1, 2, 3]).toArray()).toEqual([1, 2, 3])
	})

	test("the thunk is not invoked until the first pull", async () => {
		let opened = 0

		const sequence = AsyncSequence.from(() => {
			opened++

			return range(3)
		})
			.map((value) => value * 2)
			.filter(Boolean)

		expect(opened).toBe(0)

		await sequence.toArray()

		expect(opened).toBe(1)
	})

	test("take(0) never invokes the thunk", async () => {
		let opened = 0

		const result = await AsyncSequence.from(() => {
			opened++

			return range(1000)
		})
			.take(0)
			.toArray()

		expect(result).toEqual([])
		expect(opened).toBe(0)
	})

	test("the thunk is invoked once across a whole iteration", async () => {
		let opened = 0

		await AsyncSequence.from(() => {
			opened++

			return range(50)
		}).toArray()

		expect(opened).toBe(1)
	})

	test("a rejecting thunk rejects the sequence", async () => {
		await expect(AsyncSequence.from(() => Promise.reject(new Error("cannot open"))).toArray()).rejects.toThrow(
			"cannot open"
		)
	})

	test("early exit closes an opened deferred source", async () => {
		const { iterable, state } = spySource(1000)

		const result = await AsyncSequence.from(() => iterable)
			.take(2)
			.toArray()

		expect(result).toEqual([0, 1])
		expect(state.closed).toBe(true)
	})
})

describe("fusion is observably equivalent to nesting", () => {
	async function* nestedMap<T, U>(source: AsyncIterable<T>, fn: (value: T, i: number) => U) {
		let i = 0

		for await (const value of source) {
			yield fn(value, i++)
		}
	}

	async function* nestedFilter<T>(source: AsyncIterable<T>, fn: (value: T, i: number) => unknown) {
		let i = 0

		for await (const value of source)
			if (fn(value, i++)) {
				yield value
			}
	}

	async function* nestedDrop<T>(source: AsyncIterable<T>, limit: number) {
		let remaining = limit

		for await (const value of source) {
			if (remaining > 0) {
				remaining--

				continue
			}

			yield value
		}
	}

	async function* nestedTake<T>(source: AsyncIterable<T>, limit: number) {
		let remaining = limit

		if (remaining <= 0) return

		for await (const value of source) {
			yield value

			if (--remaining <= 0) return
		}
	}

	const double = (value: number) => value * 2
	const odd = (value: number) => value % 2 === 1

	test.each([
		["map→filter", 0],
		["filter→map", 1],
		["drop→take", 2],
		["take→drop", 3],
		["map→drop→filter→take", 4],
	])("%s matches the nested implementation", async (_label, shape) => {
		const fused = AsyncSequence.from(range(20))
		const source = range(20)

		let fusedResult: number[]
		let nestedResult: number[]

		switch (shape) {
			case 0:
				fusedResult = await fused.map(double).filter(odd).toArray()
				nestedResult = await Array.fromAsync(nestedFilter(nestedMap(source, double), odd))
				break
			case 1:
				fusedResult = await fused.filter(odd).map(double).toArray()
				nestedResult = await Array.fromAsync(nestedMap(nestedFilter(source, odd), double))
				break
			case 2:
				fusedResult = await fused.drop(3).take(4).toArray()
				nestedResult = await Array.fromAsync(nestedTake(nestedDrop(source, 3), 4))
				break
			case 3:
				fusedResult = await fused.take(4).drop(3).toArray()
				nestedResult = await Array.fromAsync(nestedDrop(nestedTake(source, 4), 3))
				break
			default:
				fusedResult = await fused.map(double).drop(2).filter(odd).take(3).toArray()
				{
					const doubled = nestedMap(source, double)
					const dropped = nestedDrop(doubled, 2)
					const odds = nestedFilter(dropped, odd)

					nestedResult = await Array.fromAsync(nestedTake(odds, 3))
				}
		}

		expect(fusedResult).toEqual(nestedResult)
	})
})

describe("laziness and closure", () => {
	test("take stops pulling once satisfied and closes the source", async () => {
		const { iterable, state } = spySource(1000)

		const result = await AsyncSequence.from(iterable).take(3).toArray()

		expect(result).toEqual([0, 1, 2])
		expect(state.pulled).toBe(3)
		expect(state.closed).toBe(true)
	})

	test("take(0) closes without pulling at all", async () => {
		const { iterable, state } = spySource(1000)

		expect(await AsyncSequence.from(iterable).take(0).toArray()).toEqual([])
		expect(state.pulled).toBe(0)
		expect(state.closed).toBe(true)
	})

	test("find short-circuits and closes the source", async () => {
		const { iterable, state } = spySource(1000)

		expect(await AsyncSequence.from(iterable).find((value) => value === 4)).toBe(4)
		expect(state.pulled).toBe(5)
		expect(state.closed).toBe(true)
	})

	test("some short-circuits and closes the source", async () => {
		const { iterable, state } = spySource(1000)

		expect(await AsyncSequence.from(iterable).some((value) => value === 2)).toBe(true)
		expect(state.closed).toBe(true)
	})

	test("every short-circuits and closes the source", async () => {
		const { iterable, state } = spySource(1000)

		expect(await AsyncSequence.from(iterable).every((value) => value < 2)).toBe(false)
		expect(state.closed).toBe(true)
	})

	test("breaking out of for-await closes the source", async () => {
		const { iterable, state } = spySource(1000)

		for await (const value of AsyncSequence.from(iterable)) {
			if (value === 2) break
		}

		expect(state.closed).toBe(true)
	})

	test("a throwing callback closes the source", async () => {
		const { iterable, state } = spySource(1000)

		await expect(
			AsyncSequence.from(iterable)
				.map((value) => {
					if (value === 2) throw new Error("boom")

					return value
				})
				.toArray()
		).rejects.toThrow("boom")

		expect(state.closed).toBe(true)
	})

	test("nothing is pulled until the sequence is iterated", async () => {
		const { iterable, state } = spySource(10)

		AsyncSequence.from(iterable)
			.map((value) => value * 2)
			.filter(Boolean)

		expect(state.pulled).toBe(0)
	})
})

describe("terminals", () => {
	test("reduce with an initial value", async () => {
		expect(await AsyncSequence.from(range(5)).reduce((total, value) => total + value, 100)).toBe(110)
	})

	test("reduce without an initial value seeds from the first item", async () => {
		expect(await AsyncSequence.from(range(5, 1)).reduce((total, value) => total + value)).toBe(15)
	})

	test("reduce of an empty sequence with no initial value throws", async () => {
		await expect(AsyncSequence.from(range(0)).reduce((total, value) => total + value)).rejects.toThrow(TypeError)
	})

	test("reduce of an empty sequence returns the initial value", async () => {
		expect(await AsyncSequence.from(range(0)).reduce((total, value) => total + value, 42)).toBe(42)
	})

	test("forEach visits every value", async () => {
		const seen: number[] = []

		await AsyncSequence.from(range(4)).forEach((value) => void seen.push(value))

		expect(seen).toEqual([0, 1, 2, 3])
	})

	test("find returns undefined when nothing matches", async () => {
		expect(await AsyncSequence.from(range(4)).find((value) => value > 99)).toBeUndefined()
	})

	test("every is true for an empty sequence", async () => {
		expect(await AsyncSequence.from(range(0)).every(() => false)).toBe(true)
	})
})

describe("flatMap", () => {
	test("flattens sync iterables one level", async () => {
		expect(
			await AsyncSequence.from(range(3))
				.flatMap((value) => [value, value])
				.toArray()
		).toEqual([0, 0, 1, 1, 2, 2])
	})

	test("flattens async iterables", async () => {
		expect(
			await AsyncSequence.from(range(2))
				.flatMap((value) => range(2, value * 10))
				.toArray()
		).toEqual([0, 1, 10, 11])
	})

	test("awaits a promise-returning callback", async () => {
		expect(
			await AsyncSequence.from(range(2))
				.flatMap(async (value) => [value])
				.toArray()
		).toEqual([0, 1])
	})

	test("chains fuse on both sides of the barrier", async () => {
		const result = await AsyncSequence.from(range(4))
			.map((value) => value + 1)
			.flatMap((value) => [value, -value])
			.filter((value) => value > 0)
			.take(3)
			.toArray()

		expect(result).toEqual([1, 2, 3])
	})

	test("a non-iterable return is a TypeError", async () => {
		await expect(
			AsyncSequence.from(range(2))
				.flatMap(() => 5 as never)
				.toArray()
		).rejects.toThrow(TypeError)
	})
})

describe("chunks", () => {
	test("batches into arrays of the given size", async () => {
		expect(await AsyncSequence.from(range(5)).chunks(2).toArray()).toEqual([[0, 1], [2, 3], [4]])
	})

	test("an evenly-divisible sequence yields no trailing partial batch", async () => {
		expect(await AsyncSequence.from(range(4)).chunks(2).toArray()).toEqual([
			[0, 1],
			[2, 3],
		])
	})

	test("an empty sequence yields nothing", async () => {
		expect(await AsyncSequence.from(range(0)).chunks(3).toArray()).toEqual([])
	})

	test.each([0, -1, Number.NaN])("rejects a size of %s", async (size) => {
		expect(() => AsyncSequence.from(range(3)).chunks(size)).toThrow(RangeError)
	})
})

describe("parallelMap", () => {
	test("maps every value", async () => {
		const result = await AsyncSequence.from(range(10))
			.parallelMap(async (value) => value * 2, { concurrency: 3 })
			.toArray()

		expect(result.toSorted((a, b) => a - b)).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18])
	})

	test("duplicate items each produce their own result", async () => {
		const duplicated = ["a", "a", "a", "b", "b"]

		const result = await AsyncSequence.from(duplicated)
			.parallelMap(async (value) => value.toUpperCase(), { concurrency: 2 })
			.toArray()

		expect(result).toHaveLength(duplicated.length)
		expect(result.toSorted()).toEqual(["A", "A", "A", "B", "B"])
	})

	test("respects the concurrency ceiling", async () => {
		let inFlight = 0
		let peak = 0

		await AsyncSequence.from(range(20))
			.parallelMap(
				async (value) => {
					inFlight++
					peak = Math.max(peak, inFlight)

					await new Promise((resolve) => {
						setTimeout(resolve, 1)
					})

					inFlight--

					return value
				},
				{ concurrency: 4 }
			)
			.toArray()

		expect(peak).toBeLessThanOrEqual(4)
		expect(peak).toBeGreaterThan(1)
	})

	test("a rejecting callback rejects the sequence", async () => {
		await expect(
			AsyncSequence.from(range(10))
				.parallelMap(
					async (value) => {
						if (value === 5) throw new Error("boom")

						return value
					},
					{ concurrency: 3 }
				)
				.toArray()
		).rejects.toThrow("boom")
	})

	test("an aborted signal stops iteration", async () => {
		const controller = new AbortController()

		const result = await AsyncSequence.from(range(100))
			.parallelMap(
				async (value) => {
					if (value >= 3) {
						controller.abort()
					}

					return value
				},
				{ concurrency: 2, signal: controller.signal }
			)
			.toArray()

		expect(result.length).toBeLessThan(100)
	})
})

describe("stream interop", () => {
	test("toReadableStream yields every value", async () => {
		const stream = AsyncSequence.from(range(4)).toReadableStream()
		const collected: number[] = []

		for await (const value of stream as unknown as AsyncIterable<number>) {
			collected.push(value)
		}

		expect(collected).toEqual([0, 1, 2, 3])
	})
})
