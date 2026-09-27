/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { AsyncSequence, Sequence } from "spliterator"
import { describe, expect, test } from "vitest"

function* range(count: number, start = 0): Generator<number> {
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

	const iterable: Iterable<number> = {
		[Symbol.iterator]() {
			let i = 0

			return {
				next: () => {
					if (i >= count) return { value: undefined, done: true }

					state.pulled++

					return { value: i++, done: false }
				},
				return: () => {
					state.closed = true

					return { value: undefined, done: true }
				},
			} as Iterator<number>
		},
	}

	return { iterable, state }
}

describe("core semantics", () => {
	test("map, filter, take, drop compose", () => {
		const result = Sequence.from(range(10))
			.map((value) => value * 2)
			.filter((value) => value % 3 === 0)
			.drop(1)
			.take(2)
			.toArray()

		expect(result).toEqual([6, 12])
	})

	test("callbacks receive a per-operator counter", () => {
		const mapCounters: number[] = []
		const filterCounters: number[] = []

		Sequence.from(range(4))
			.filter((_value, counter) => {
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

	test("a filtered value does not advance downstream counters", () => {
		const counters: number[] = []

		Sequence.from(range(4))
			.filter((value) => value % 2 === 0)
			.map((value, counter) => {
				counters.push(counter)

				return value
			})
			.toArray()

		expect(counters).toEqual([0, 1])
	})

	test("chain depth does not nest iterators", () => {
		const result = Sequence.from(range(6))
			.map((value) => value + 1)
			.map((value) => value * 2)
			.filter((value) => value > 4)
			.drop(1)
			.map((value) => `${value}`)
			.toArray()

		expect(result).toEqual(["8", "10", "12"])
	})

	test("is single-shot", () => {
		const sequence = Sequence.from(range(3))

		expect(sequence.toArray()).toEqual([0, 1, 2])
		expect(sequence.toArray()).toEqual([])
	})

	test("from passes an existing sequence through unchanged", () => {
		const sequence = Sequence.from(range(3))

		expect(Sequence.from(sequence)).toBe(sequence)
	})

	test("accepts a thunk source and does not invoke it until pulled", () => {
		let invoked = 0

		const sequence = Sequence.from(() => {
			invoked++

			return range(3)
		}).map((value) => value)

		expect(invoked).toBe(0)

		expect(sequence.toArray()).toEqual([0, 1, 2])
		expect(invoked).toBe(1)
	})

	test("is iterable with for..of", () => {
		const seen: number[] = []

		for (const value of Sequence.from(range(3))) {
			seen.push(value)
		}

		expect(seen).toEqual([0, 1, 2])
	})
})

describe("laziness and closure", () => {
	test("nothing is pulled until the first next()", () => {
		const { iterable, state } = spySource(10)

		const sequence = Sequence.from(iterable)
			.map((value) => value)
			.filter(() => true)

		expect(state.pulled).toBe(0)

		sequence.next()

		expect(state.pulled).toBe(1)
	})

	test("take pulls no more than it needs and closes the source", () => {
		const { iterable, state } = spySource(1000)

		const result = Sequence.from(iterable).take(3).toArray()

		expect(result).toEqual([0, 1, 2])
		expect(state.pulled).toBe(3)
		expect(state.closed).toBe(true)
	})

	test("take(0) closes the source without pulling", () => {
		const { iterable, state } = spySource(10)

		expect(Sequence.from(iterable).take(0).toArray()).toEqual([])
		expect(state.pulled).toBe(0)
		expect(state.closed).toBe(true)
	})

	test("take(0) on a fusion barrier still closes the source", () => {
		const { iterable, state } = spySource(10)

		expect(Sequence.from(iterable).chunks(2).take(0).toArray()).toEqual([])

		expect(state.closed).toBe(true)
	})

	test("a never-invoked thunk source is not opened just to close it", () => {
		let invoked = 0

		const sequence = Sequence.from(() => {
			invoked++

			return range(3)
		})

		sequence.return()

		expect(invoked).toBe(0)
	})

	test("find closes the source once satisfied", () => {
		const { iterable, state } = spySource(100)

		expect(Sequence.from(iterable).find((value) => value === 2)).toBe(2)
		expect(state.pulled).toBe(3)
		expect(state.closed).toBe(true)
	})

	test("some closes the source once satisfied", () => {
		const { iterable, state } = spySource(100)

		expect(Sequence.from(iterable).some((value) => value === 1)).toBe(true)
		expect(state.closed).toBe(true)
	})

	test("every closes the source once falsified", () => {
		const { iterable, state } = spySource(100)

		expect(Sequence.from(iterable).every((value) => value < 2)).toBe(false)
		expect(state.closed).toBe(true)
	})

	test("breaking out of for..of closes the source", () => {
		const { iterable, state } = spySource(100)

		for (const value of Sequence.from(iterable)) {
			if (value === 1) break
		}

		expect(state.closed).toBe(true)
	})

	test("a throwing callback closes the source", () => {
		const { iterable, state } = spySource(100)

		expect(() =>
			Sequence.from(iterable)
				.map((value) => {
					if (value === 2) throw new Error("boom")

					return value
				})
				.toArray()
		).toThrow("boom")

		expect(state.closed).toBe(true)
	})

	test("Symbol.dispose closes the source", () => {
		const { iterable, state } = spySource(10)

		{
			using sequence = Sequence.from(iterable)

			expect(sequence.next().value).toBe(0)
		}

		expect(state.closed).toBe(true)
	})
})

describe("terminal collectors", () => {
	test("toArray collects every remaining value", () => {
		expect(Sequence.from(range(3)).toArray()).toEqual([0, 1, 2])
	})

	test("toMap collects entries from the callback", () => {
		const map = Sequence.from(["a", "b", "c"]).toMap((value) => [value, value.charCodeAt(0)])

		expect(map).toBeInstanceOf(Map)

		expect([...map]).toEqual([
			["a", 97],
			["b", 98],
			["c", 99],
		])
	})

	test("toMap passes a counter", () => {
		const map = Sequence.from(["a", "b"]).toMap((value, counter) => [counter, value])

		expect([...map]).toEqual([
			[0, "a"],
			[1, "b"],
		])
	})

	test("toSet without a callback collects the values themselves", () => {
		const set: Set<string> = Sequence.from(["a", "b", "a"]).toSet()

		expect([...set]).toEqual(["a", "b"])
	})

	test("toSet collects the callback's results", () => {
		const set = Sequence.from(["a", "b", "a"]).toSet((value) => value.charCodeAt(0))

		expect(set).toBeInstanceOf(Set)
		expect([...set]).toEqual([97, 98])
	})

	test("toSorted sorts the collected values", () => {
		expect(Sequence.from([3, 1, 2]).toSorted((a, b) => a - b)).toEqual([1, 2, 3])
	})

	test("forEach visits every value with a counter", () => {
		const seen: Array<[number, number]> = []

		Sequence.from(range(3)).forEach((value, counter) => {
			seen.push([value, counter])
		})

		expect(seen).toEqual([
			[0, 0],
			[1, 1],
			[2, 2],
		])
	})

	test("reduce with an initial value", () => {
		expect(Sequence.from(range(4)).reduce((total, value) => total + value, 100)).toBe(106)
	})

	test("reduce without an initial value seeds from the first value", () => {
		expect(Sequence.from(range(4)).reduce((total, value) => total + value)).toBe(6)
	})

	test("reduce over an empty sequence without an initial value throws", () => {
		expect(() => Sequence.from<number>([]).reduce((total, value) => total + value)).toThrow(TypeError)
	})

	test("find returns undefined when nothing matches", () => {
		expect(Sequence.from(range(3)).find((value) => value > 10)).toBeUndefined()
	})

	test("every over an empty sequence is true", () => {
		expect(Sequence.from<number>([]).every(() => false)).toBe(true)
	})

	test("some over an empty sequence is false", () => {
		expect(Sequence.from<number>([]).some(() => true)).toBe(false)
	})
})

describe("fusion barriers", () => {
	test("flatMap flattens one level", () => {
		const result = Sequence.from(range(3))
			.flatMap((value) => [value, value * 10])
			.toArray()

		expect(result).toEqual([0, 0, 1, 10, 2, 20])
	})

	test("flatMap passes a counter and accepts any iterable", () => {
		const result = Sequence.from(["ab", "cd"])
			.flatMap((value, counter) => (counter === 0 ? [...value] : new Set(value)))
			.toArray()

		expect(result).toEqual(["a", "b", "c", "d"])
	})

	test("flatMap rejects a non-iterable result", () => {
		expect(() =>
			Sequence.from(range(1))
				.flatMap(() => 5 as unknown as number[])
				.toArray()
		).toThrow(TypeError)
	})

	// Matches `GetIteratorFlattenable(obj, reject-strings)` in the iterator helpers proposal, and `AsyncSequence`.
	test("flatMap rejects a string result, iterable though it is", () => {
		expect(() =>
			Sequence.from(range(1))
				.flatMap(() => "ab" as unknown as string[])
				.toArray()
		).toThrow(TypeError)
	})

	test("chunks groups values, with a shorter final batch", () => {
		expect(Sequence.from(range(5)).chunks(2).toArray()).toEqual([[0, 1], [2, 3], [4]])
	})

	test("chunks composes with the fused operators on both sides", () => {
		const result = Sequence.from(range(10))
			.filter((value) => value % 2 === 0)
			.chunks(2)
			.map((batch) => batch.reduce((total, value) => total + value, 0))
			.toArray()

		expect(result).toEqual([2, 10, 8])
	})

	test("chunks rejects a non-positive size", () => {
		expect(() => Sequence.from(range(3)).chunks(0)).toThrow(RangeError)
	})
})

describe("validation", () => {
	test("take rejects a negative limit", () => {
		expect(() => Sequence.from(range(3)).take(-1)).toThrow(RangeError)
	})

	test("drop rejects a non-finite limit", () => {
		expect(() => Sequence.from(range(3)).drop(Infinity)).toThrow(RangeError)
	})

	test("take(Infinity) leaves the sequence unbounded", () => {
		expect(Sequence.from(range(3)).take(Infinity).toArray()).toEqual([0, 1, 2])
	})
})

describe("interop", () => {
	test("toAsync bridges into an AsyncSequence", async () => {
		const sequence = Sequence.from(range(4)).toAsync()

		expect(sequence).toBeInstanceOf(AsyncSequence)

		await expect(
			sequence
				.parallelMap(async (value) => value * 2, { concurrency: 2 })
				.toArray()
				.then((values) => values.toSorted((a, b) => a - b))
		).resolves.toEqual([0, 2, 4, 6])
	})

	test("toReadableStream exposes the sequence as a web stream", async () => {
		const stream = Sequence.from(range(3)).toReadableStream()
		const seen: number[] = []

		for await (const value of stream) {
			seen.push(value)
		}

		expect(seen).toEqual([0, 1, 2])
	})

	test("cancelling the stream closes the source", async () => {
		const { iterable, state } = spySource(100)

		const stream = Sequence.from(iterable).toReadableStream()
		const reader = stream.getReader()

		await reader.read()
		await reader.cancel()

		expect(state.closed).toBe(true)
	})
})
