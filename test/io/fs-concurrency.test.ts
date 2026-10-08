/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { fsConcurrency } from "spliterator/node/fs"
import { afterEach, describe, expect, test } from "vitest"

describe("fsConcurrency", () => {
	const original = process.env.UV_THREADPOOL_SIZE

	afterEach(() => {
		if (original === undefined) {
			delete process.env.UV_THREADPOOL_SIZE
		} else {
			process.env.UV_THREADPOOL_SIZE = original
		}
	})

	test("defaults to libuv's four-thread pool", () => {
		delete process.env.UV_THREADPOOL_SIZE

		expect(fsConcurrency()).toBe(4)
	})

	test("reads UV_THREADPOOL_SIZE", () => {
		process.env.UV_THREADPOOL_SIZE = "16"

		expect(fsConcurrency()).toBe(16)
	})

	test("parses like libuv's atoi", () => {
		const cases: [string, number][] = [
			["0", 1],
			["abc", 1],
			["", 1],
			["  8", 8],
			["+8", 8],
			["8abc", 8],
			["2.5", 2],
			["-3", 1024],
		]

		for (const [raw, expected] of cases) {
			process.env.UV_THREADPOOL_SIZE = raw

			expect(fsConcurrency(), JSON.stringify(raw)).toBe(expected)
		}
	})

	test("caps at libuv's maximum", () => {
		process.env.UV_THREADPOOL_SIZE = "99999"

		expect(fsConcurrency()).toBe(1024)
	})
})
