/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { CompositeDataView } from "@sister.software/ribbon"
import { describe, expect, it } from "vitest"

describe("CompositeTypedArray", () => {
	const encoder = new TextEncoder()
	const decoder = new TextDecoder()

	const decodedAlphabet = "abcdefghijklmnopqrstuvwxyz"
	const encodedAlphabet = encoder.encode(decodedAlphabet)

	// Helper to create chunks from the alphabet
	function createAlphabetChunks(chunkSize: number): Uint8Array[] {
		const chunks: Uint8Array[] = []
		for (let i = 0; i < encodedAlphabet.length; i += chunkSize) {
			chunks.push(encodedAlphabet.slice(i, i + chunkSize))
		}

		return chunks
	}

	it("should correctly handle alphabet split into chunks", () => {
		const composite = new CompositeDataView(createAlphabetChunks(5))

		// Test length
		expect(composite.byteLength).toBe(26) // length of alphabet

		// Test iteration

		const iteratedText = decoder.decode(Uint8Array.from(composite))
		expect(iteratedText, "Iterated text matched decoded").toBe(decodedAlphabet)

		// Test random access
		expect(decoder.decode(Uint8Array.from([composite.at(0)]))).toBe("a")
		expect(decoder.decode(Uint8Array.from([composite.at(7)]))).toBe("h")
		expect(decoder.decode(Uint8Array.from([composite.at(25)]))).toBe("z")

		// Test out of bounds
		expect(() => composite.at(-1)).toThrow("Index out of range")
		expect(() => composite.at(26)).toThrow("Index out of range")
	})

	it("should correctly handle subarray operations", () => {
		const composite = new CompositeDataView(createAlphabetChunks(5))

		// Test within single chunk
		const firstChunk = composite.subarray(0, 5)
		expect(decoder.decode(firstChunk)).toBe("abcde")

		// Test across chunks
		const acrossChunks = composite.subarray(3, 8)
		expect(decoder.decode(acrossChunks)).toBe("defgh")

		// Test to end
		const toEnd = composite.subarray(20)
		expect(decoder.decode(toEnd)).toBe("uvwxyz")
	})

	it("should handle push and pop operations", () => {
		const chunks = createAlphabetChunks(5)
		const composite = new CompositeDataView()

		chunks.forEach((chunk) => {
			const newLength = composite.push(chunk)

			expect(newLength, "Pushing updates the byte length").toBe(composite.byteLength)
		})

		const lastChunk = composite.pop()
		expect(lastChunk, "Last chunk can be popped").toBeDefined()

		if (lastChunk) {
			expect(decoder.decode(lastChunk), "Last chunk can be smaller").toBe("z")
		}

		expect(composite.byteLength).toBe(25) // 26 - 1
	})

	it("should handle shift and unshift operations", () => {
		const chunks = createAlphabetChunks(5)
		const composite = new CompositeDataView()
		chunks.forEach((chunk) => composite.push(chunk))

		// Test shift
		const firstChunk = composite.shift()

		expect(firstChunk).toBeDefined()

		if (firstChunk) {
			expect(decoder.decode(firstChunk)).toBe("abcde")
		}

		// Test unshift
		const newChunk = new TextEncoder().encode("12345")
		composite.unshift(newChunk)
		expect(decoder.decode(composite.subarray(0, 5))).toBe("12345")
	})

	it("should correctly flatten the buffer", () => {
		const chunks = createAlphabetChunks(5)
		const composite = new CompositeDataView()
		chunks.forEach((chunk) => composite.push(chunk))

		const flattened = composite.flat()

		expect(decoder.decode(flattened)).toBe("abcdefghijklmnopqrstuvwxyz")
	})

	it("should maintain correct state after multiple operations", () => {
		const composite = new CompositeDataView()

		// Add some initial data
		composite.push(encoder.encode("hello"))
		composite.push(encoder.encode("world"))

		// Modify the buffer
		composite.pop()
		composite.push(encoder.encode("test"))
		composite.unshift(encoder.encode("start"))

		// Verify final state
		expect(decoder.decode(composite.flat())).toBe("starthellotest")

		// Verify length
		expect(composite.byteLength).toBe(14) // 5 + 5 + 4
	})
})
