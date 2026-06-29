/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { BufferController } from "spliterator"
import { test } from "vitest"

test("compress rebases bytesWritten onto the kept window", ({ expect }) => {
	const controller = new BufferController({ initialBufferSize: 100 })

	controller.set(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 0)
	expect(controller.bytesWritten, "All ten bytes were written").toBe(10)
	expect(controller.bytes.length, "Allocation still 100 bytes").toBe(100)

	controller.compress(3)

	expect(
		controller.bytesWritten,
		"bytesWritten reflects the seven valid bytes still in view, not the underlying allocation"
	).toBe(7)
	expect(Array.from(controller.bytes.subarray(0, controller.bytesWritten))).toEqual([4, 5, 6, 7, 8, 9, 10])
})

test("compress with start past bytesWritten yields zero valid bytes", ({ expect }) => {
	const controller = new BufferController({ initialBufferSize: 64 })
	controller.set(new Uint8Array([10, 20, 30]), 0)

	controller.compress(10)

	expect(controller.bytesWritten).toBe(0)
})

test("subarray rejects out-of-range ends rather than reading garbage", ({ expect }) => {
	const controller = new BufferController({ initialBufferSize: 16 })
	controller.set(new Uint8Array([1, 2, 3]), 0)

	expect(() => controller.subarray(0, 5)).toThrow(RangeError)
})
