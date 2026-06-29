/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { AsyncSpliterator } from "spliterator"
import { describe, expect, test } from "vitest"

/** A fake chunk source whose iterator records whether `return()` was called (cancellation). */
function spySource(chunks: Uint8Array[]) {
	const state = { returned: false }
	const source = {
		[Symbol.asyncIterator]() {
			let i = 0

			return {
				next: async () => (i < chunks.length ? { value: chunks[i++]!, done: false } : { value: undefined, done: true }),
				return: async () => {
					state.returned = true

					return { value: undefined, done: true as const }
				},
			}
		},
	}

	return { source, state }
}

describe("AsyncSpliterator early termination", () => {
	test("propagates cancellation to the chunk reader on early return", async () => {
		const enc = new TextEncoder()
		const { source, state } = spySource([enc.encode("a\nb\nc\nd\n")])
		const spliterator = new AsyncSpliterator(source as never, { delimiter: "\n" })

		for await (const _ of spliterator) break // consume one, then bail

		await spliterator.return()
		expect(state.returned).toBe(true)
	})
})
