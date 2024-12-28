/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { TypedArray } from "./shared.js"

/**
 * A generic mutable typed array.
 */
export interface MutableTypedArray<T extends number | bigint = number | bigint> {
	readonly length: number
	readonly [n: number]: T
	set(array: ArrayLike<T>, offset?: number): void
}

/**
 * A constructor for a mutable typed array.
 */
export type MutableTypedArrayConstructor<T extends number | bigint = number | bigint> = new (
	length: number
) => MutableTypedArray<T>

/**
 * A generic typed array.
 */
interface ChunkInfo {
	offset: number
	length: number
}

/**
 * Given several contiguous byte arrays, wraps them as if they were flattened into a single buffer.
 */
export class CompositeDataView<Chunk extends TypedArray = TypedArray>
	implements Iterable<Chunk[0]>, RelativeIndexable<Chunk[0]>
{
	/**
	 * The chunks that make up the composite buffer.
	 */
	#chunks: Chunk[] = []

	/**
	 * Cached length of the composite buffer.
	 */
	#memoizedByteLength = 0

	/**
	 * Cached chunk offset information for binary search.
	 */
	#chunkOffsets: ChunkInfo[] = []

	/**
	 * Helper method to infer the constructor of the chunks.
	 */
	#inferChunkConstructor(): MutableTypedArrayConstructor<Chunk[0]> {
		const first = this.#chunks[0]
		if (!first) {
			throw new TypeError("No chunks in composite buffer, cannot infer constructor")
		}
		return first.constructor as MutableTypedArrayConstructor<Chunk[0]>
	}

	/**
	 * Binary search to find the chunk containing the given index.
	 */
	#findChunkForIndex(index: number): { chunk: Chunk; chunkInfo: ChunkInfo } | null {
		let left = 0
		let right = this.#chunkOffsets.length - 1

		while (left <= right) {
			const mid = Math.floor((left + right) / 2)
			const chunkInfo = this.#chunkOffsets[mid]!

			if (index >= chunkInfo.offset && index < chunkInfo.offset + chunkInfo.length) {
				return { chunk: this.#chunks[mid]!, chunkInfo }
			}

			if (index < chunkInfo.offset) {
				right = mid - 1
			} else {
				left = mid + 1
			}
		}

		return null
	}

	/**
	 * Update chunk offset information after modification.
	 */
	#updateChunkOffsets(): void {
		let currentOffset = 0

		this.#chunkOffsets = this.#chunks.map((chunk) => {
			const info = { offset: currentOffset, length: chunk.length }

			currentOffset += chunk.length

			return info
		})
	}

	constructor(chunks?: Chunk[]) {
		if (chunks) {
			this.#chunks = chunks
			this.#memoizedByteLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
			this.#updateChunkOffsets()
		}
	}

	/**
	 * The combined length of all chunks.
	 *
	 * @see {@linkcode size} for the number of chunks in the composite buffer.
	 */
	public get byteLength(): number {
		return this.#memoizedByteLength
	}

	/**
	 * The number of chunks in the composite buffer.
	 *
	 * @see {@linkcode byteLength} for the total length of the composite buffer.
	 */
	public get size(): number {
		return this.#chunks.length
	}

	public get chunks(): readonly Chunk[] {
		return this.#chunks
	}

	/**
	 * The underlying buffer of the composite buffer.
	 *
	 * Note that this is not memoized and will create a new buffer each time it is accessed.
	 */
	public get buffer(): Chunk {
		return this.flat()
	}

	public get [Symbol.toStringTag](): string {
		return "CompositeDataView"
	}

	public *[Symbol.iterator](): Iterator<Chunk[0]> {
		for (const chunk of this.#chunks) {
			yield* chunk
		}
	}

	/**
	 * Returns the value at the given index, as if the chunks were flattened into a single buffer.
	 */
	public at(index: number): Chunk[0] {
		const result = this.#findChunkForIndex(index)
		if (!result) {
			throw new RangeError("Index out of range")
		}

		const { chunk, chunkInfo } = result
		return chunk[index - chunkInfo.offset]!
	}

	/**
	 * Push a chunk onto the composite buffer.
	 */
	public append(chunk: Chunk): number {
		this.#chunks.push(chunk)

		this.#memoizedByteLength += chunk.length

		this.#updateChunkOffsets()

		return this.#memoizedByteLength
	}

	/**
	 * Prepend a chunk before the first chunk in the composite buffer.
	 *
	 * @returns The new length of the composite buffer.
	 */
	public prepend(chunk: Chunk): number {
		this.#chunks.unshift(chunk)
		this.#memoizedByteLength += chunk.length
		this.#updateChunkOffsets()
		return this.#memoizedByteLength
	}

	/**
	 * Remove the most recent chunk from the composite buffer.
	 */
	public removeLast(): Chunk | undefined {
		const chunk = this.#chunks.pop()

		if (chunk) {
			this.#memoizedByteLength -= chunk.length

			this.#updateChunkOffsets()
		}
		return chunk
	}

	/**
	 * Remove the first chunk from the composite buffer.
	 */
	public removeFirst(): Chunk | undefined {
		const chunk = this.#chunks.shift()

		if (chunk) {
			this.#memoizedByteLength -= chunk.length
			this.#updateChunkOffsets()
		}

		return chunk
	}

	/**
	 * Returns a view into the underlying chunks without copying data.
	 */
	public subarray(
		/**
		 * Element to begin at. The offset is inclusive.
		 */
		begin: number = 0,
		/**
		 * Element to end at. The offset is exclusive. If not provided, the view extends to the end of
		 * the buffer.
		 */
		end: number = this.#memoizedByteLength
	): Chunk {
		if (begin < 0) {
			throw new RangeError("Invalid subarray range: begin is negative")
		}

		if (end < 0) {
			throw new RangeError("Invalid subarray range: end is negative")
		}

		// const actualEnd = end === undefined ? this.#memoizedByteLength : end
		const startChunk = this.#findChunkForIndex(begin)
		const endChunk = this.#findChunkForIndex(end - 1)

		if (!startChunk || !endChunk) {
			throw new RangeError("Invalid subarray range: Start: " + begin + ", End: " + end)
		}

		// If the range is within a single chunk, return a view into that chunk
		if (startChunk.chunk === endChunk.chunk) {
			const relativeStart = begin - startChunk.chunkInfo.offset
			const relativeEnd = end - startChunk.chunkInfo.offset
			return startChunk.chunk.subarray(relativeStart, relativeEnd) as Chunk
		}

		// Otherwise, we need to create a new buffer and copy the data
		const Constructor = this.#inferChunkConstructor()
		const length = end - begin
		const result = new Constructor(length)

		let writeOffset = 0
		let currentChunkIndex = this.#chunks.indexOf(startChunk.chunk)

		while (currentChunkIndex < this.#chunks.length) {
			const currentChunk = this.#chunks[currentChunkIndex]!
			const chunkInfo = this.#chunkOffsets[currentChunkIndex]!

			const readStart = currentChunk === startChunk.chunk ? begin - chunkInfo.offset : 0
			const readEnd = currentChunk === endChunk.chunk ? end - chunkInfo.offset : currentChunk.length

			result.set(currentChunk.subarray(readStart, readEnd), writeOffset)
			writeOffset += readEnd - readStart

			if (currentChunk === endChunk.chunk) break
			currentChunkIndex++
		}

		return result as Chunk
	}

	/**
	 * Flattens the composite buffer into a single buffer.
	 */
	public flat(): Chunk {
		return this.subarray()
	}

	/**
	 * Returns a shallow copy of the composite buffer.
	 *
	 * @see {@linkcode subarray} for a view into the underlying chunks.
	 */
	public slice(
		/**
		 * Zero-based index at which to begin extraction.
		 *
		 * If this value is negative, it is treated as `byteLength + begin`.
		 */
		start: number = 0,
		/**
		 * Zero-based index before which to end extraction.
		 *
		 * If this value is negative, it is treated as `byteLength + end`.
		 */
		end: number = this.#memoizedByteLength
	): Chunk {
		if (start < 0) {
			start = Math.max(0, this.#memoizedByteLength + start)
		}

		if (end < 0) {
			end = Math.max(0, this.#memoizedByteLength + end)
		}

		return this.subarray(start, end)
	}
}
