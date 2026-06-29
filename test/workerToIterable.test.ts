/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { workerToIterable } from "spliterator/segment-workers"
import { describe, expect, test } from "vitest"

/** A fake worker we can drive by emitting messages. */
function fakeWorker() {
	const handlers: Record<string, ((arg: never) => void)[]> = { message: [], error: [] }

	return {
		on(event: "message" | "error", cb: (arg: never) => void) {
			handlers[event]!.push(cb)
		},
		emit(event: "message" | "error", arg: unknown) {
			for (const cb of handlers[event]!) cb(arg as never)
		},
	}
}

describe("workerToIterable", () => {
	test("yields batched records in order then completes on done", async () => {
		const w = fakeWorker()
		const acks: number[] = []
		const it = workerToIterable<string>(w, () => acks.push(1))

		// Emit before iteration starts — eager listeners must not drop these.
		w.emit("message", { type: "batch", records: ["a", "b"] })
		w.emit("message", { type: "batch", records: ["c"] })
		w.emit("message", { type: "done" })

		const got: string[] = []

		for await (const r of it) got.push(r)

		expect(got).toEqual(["a", "b", "c"])
		expect(acks.length).toBe(2) // one ack per consumed batch
	})

	test("rejects on an error message", async () => {
		const w = fakeWorker()
		const it = workerToIterable<string>(w, () => {})
		w.emit("message", { type: "error", message: "boom" })

		await expect(
			(async () => {
				for await (const _ of it) void _
			})()
		).rejects.toThrow("boom")
	})
})
