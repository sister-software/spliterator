/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { runSegment } from "spliterator/segment-runtime"
import { describe, expect, test } from "vitest"

const enc = new TextEncoder()
async function* records(n: number): AsyncIterable<Uint8Array> {
	for (let i = 0; i < n; i++) yield enc.encode(`r${i}`)
}

describe("runSegment", () => {
	test("batches results and skips undefined", async () => {
		const posted: unknown[][] = []

		await runSegment({
			records: records(5),
			handleRecord: (bytes, ctx) => (ctx.index % 2 === 0 ? new TextDecoder().decode(bytes) : undefined),
			segmentIndex: 0,
			batchSize: 2,
			maxInFlight: 99,
			post: (batch) => posted.push(batch),
			waitForAck: async () => {},
			inFlight: () => 0,
		})

		// indices 0,2,4 kept => ["r0","r2","r4"] in batches of 2 then 1
		expect(posted).toEqual([["r0", "r2"], ["r4"]])
	})

	test("adds Uint8Array result buffers to the transfer list", async () => {
		const transfers: ArrayBuffer[][] = []

		await runSegment({
			records: records(1),
			handleRecord: () => enc.encode("out"),
			segmentIndex: 0,
			batchSize: 10,
			maxInFlight: 99,
			post: (_batch, transfer) => transfers.push(transfer),
			waitForAck: async () => {},
			inFlight: () => 0,
		})

		expect(transfers[0]).toHaveLength(1)
		expect(transfers[0]![0]).toBeInstanceOf(ArrayBuffer)
	})

	test("waits for an ack when the in-flight window is full", async () => {
		const order: string[] = []
		let flight = 0

		await runSegment({
			records: records(4),
			handleRecord: (b) => new TextDecoder().decode(b),
			segmentIndex: 0,
			batchSize: 1,
			maxInFlight: 1,
			post: () => {
				flight++
				order.push("post")
			},
			waitForAck: async () => {
				flight--
				order.push("ack")
			},
			inFlight: () => flight,
		})

		// With window 1, every post after the first must be preceded by an ack.
		expect(order).toEqual(["post", "ack", "post", "ack", "post", "ack", "post"])
	})
})
