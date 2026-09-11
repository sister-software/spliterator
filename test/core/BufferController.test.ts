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

// Regression: `set` used to call `grow(nextLength)` — the exact length needed — which bypassed
// `grow`'s own doubling default and made repeated appends O(n²) in bytes copied. Building a 1MiB
// buffer from 1KiB appends reallocated 1023 times and copied ~512MiB. Measured end-to-end on a
// 100MB single quoted CSV field, that cost 1549 reallocations, 76GB of memcpy, and 60.6s against
// 9.3s once growth was geometric.
test("set grows the buffer geometrically, not by the exact amount needed", ({ expect }) => {
	const controller = new BufferController({ initialBufferSize: 1024 })
	const chunk = new Uint8Array(1024)

	let reallocations = 0
	let lastBuffer = controller.bytes.buffer

	for (let i = 0; i < 1024; i++) {
		controller.set(chunk, controller.bytesWritten)

		if (controller.bytes.buffer !== lastBuffer) {
			reallocations++
			lastBuffer = controller.bytes.buffer
		}
	}

	expect(controller.bytesWritten, "A full mebibyte was appended").toBe(1024 * 1024)

	// Doubling from 1KiB to 1MiB is ten reallocations. Exact growth is 1023.
	expect(reallocations, "Reallocation count is logarithmic in the final size").toBeLessThanOrEqual(16)
})

test("geometric growth still preserves appended contents exactly", ({ expect }) => {
	const controller = new BufferController({ initialBufferSize: 4 })

	for (let i = 0; i < 64; i++) {
		controller.set(new Uint8Array([i, i, i]), controller.bytesWritten)
	}

	expect(controller.bytesWritten, "Every append landed").toBe(192)

	const written = Array.from(controller.bytes.subarray(0, controller.bytesWritten))
	const expected = Array.from({ length: 64 }, (_, i) => [i, i, i]).flat()

	expect(written, "Contents survive reallocation").toEqual(expected)
})

// A single append larger than double the current capacity must still be satisfied.
test("set honors an append larger than twice the current capacity", ({ expect }) => {
	const controller = new BufferController({ initialBufferSize: 8 })

	controller.set(new Uint8Array(1000).fill(7), 0)

	expect(controller.bytesWritten).toBe(1000)
	expect(controller.bytes.length, "Allocation covers the oversized append").toBeGreaterThanOrEqual(1000)
	expect(controller.bytes[999], "Last byte of the oversized append is intact").toBe(7)
})

// Regression: `compress` reassigned `bytes` to a subarray, so the discarded prefix stayed inside the
// same `ArrayBuffer` — addressable by nobody, freed by nothing until a `grow` happened to replace the
// allocation. Geometric growth removed most of those grows, which turned an incidental reclamation
// into none at all: a 100MB quoted CSV field left 101.58MB stranded for the rest of the stream.
// Compacting only when the stranded prefix outweighs the live bytes keeps the copy amortized O(1).
test("compress reclaims the stranded prefix once it outweighs the live bytes", ({ expect }) => {
	const controller = new BufferController({ initialBufferSize: 1024 })

	// Distinctive contents so a misaligned slide is visible rather than silently plausible.
	controller.set(
		Uint8Array.from({ length: 1000 }, (_, i) => i % 251),
		0
	)

	controller.compress(900)

	expect(controller.bytesWritten, "One hundred bytes remain live").toBe(100)
	expect(controller.bytes.byteOffset, "The prefix was reclaimed, not merely hidden behind a view").toBe(0)

	const kept = Array.from(controller.bytes.subarray(0, controller.bytesWritten))
	const expected = Array.from({ length: 100 }, (_, i) => (900 + i) % 251)

	expect(kept, "The live bytes survived the slide intact").toEqual(expected)
})

test("compaction hands the whole allocation back as addressable capacity", ({ expect }) => {
	const controller = new BufferController({ initialBufferSize: 1024 })
	controller.set(new Uint8Array(1000).fill(9), 0)

	controller.compress(900)

	expect(controller.bytes.length, "Capacity behind the old view is usable again").toBe(
		controller.bytes.buffer.byteLength
	)
})

// The other half of the amortization: compacting on every cycle would be the throughput cost the
// old comment feared, so a prefix smaller than the live bytes is still left as a cheap view.
test("compress leaves a view while the stranded prefix is smaller than the live bytes", ({ expect }) => {
	const controller = new BufferController({ initialBufferSize: 1024 })
	controller.set(new Uint8Array(1000).fill(4), 0)

	controller.compress(100)

	expect(controller.bytesWritten, "Nine hundred bytes remain live").toBe(900)
	expect(controller.bytes.byteOffset, "A small prefix is not worth a copy").toBe(100)
})

// The streaming steady state: append a chunk, consume it, repeat. Stranding made the view shrink
// every cycle until it forced another allocation — 788 reallocations over a 1M-row CSV.
test("repeated append-and-consume cycles neither strand memory nor force regrowth", ({ expect }) => {
	const controller = new BufferController({ initialBufferSize: 256 })
	const chunk = new Uint8Array(64).fill(3)

	let reallocations = 0
	let lastBuffer = controller.bytes.buffer

	for (let i = 0; i < 1000; i++) {
		controller.set(chunk, controller.bytesWritten)

		if (controller.bytes.buffer !== lastBuffer) {
			reallocations++
			lastBuffer = controller.bytes.buffer
		}

		controller.compress(controller.bytesWritten)
	}

	expect(controller.bytes.byteOffset, "Nothing is stranded in the steady state").toBe(0)
	expect(reallocations, "The steady state stops reallocating entirely").toBeLessThan(10)
})
