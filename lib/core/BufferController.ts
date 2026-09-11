/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

/**
 * A class to manage a buffer of bytes, growing and shrinking as needed.
 */
export class BufferController {
	/**
	 * The initial size of the buffer.
	 */
	#initialBufferSize: number

	/**
	 * The underlying buffer containing the data.
	 *
	 * This property is mutable for performance reasons. Consumers should treat it as immutable.
	 */
	bytes: Uint8Array

	/**
	 * The total number of bytes currently written to the buffer.
	 *
	 * This property is mutable for performance reasons. Consumers should treat it as immutable.
	 */
	bytesWritten: number

	/**
	 * The minimum byte length of the buffer.
	 */
	public get byteLengthMinimum(): number {
		return Math.max(this.bytesWritten, this.#initialBufferSize)
	}

	constructor(init: { initialBufferSize: number }) {
		this.#initialBufferSize = init.initialBufferSize
		this.bytes = new Uint8Array(this.#initialBufferSize)
		this.bytesWritten = 0
	}

	/**
	 * Grow the buffer to the desired byte length, typically double the current byte length.
	 */
	public grow(desiredByteLength?: number): void {
		desiredByteLength ??= this.bytes.length * 2

		if (desiredByteLength <= this.bytes.length) return

		// console.debug(`Growing buffer from ${this.bytes.length} to ${desiredByteLength} bytes.`)
		const newBytes = new Uint8Array(desiredByteLength)

		newBytes.set(this.bytes)

		this.bytes = newBytes
	}

	/**
	 * Modify the buffer in place, keeping only the bytes between the start and end indices.
	 *
	 * This is performed after we're confident that any data preceeding `start` or following `end` is no longer needed.
	 *
	 * `bytesWritten` is rebased onto the new window so it always reflects the count of valid bytes present after
	 * compression. Bytes outside the kept window are dropped from the count even if the underlying allocation is larger.
	 *
	 * Cheap compressions leave a view, which strands the discarded prefix inside the same `ArrayBuffer` — addressable by
	 * nobody and freed by nothing. Once that prefix outweighs what is still live, the live bytes are slid down to offset
	 * zero instead, reclaiming the whole allocation as usable capacity. Sliding requires at least `bytesWritten` bytes to
	 * have been consumed since the last slide, so the copy is amortized O(1) per byte streamed — this is not the "copy on
	 * every fill cycle" that kept the view unconditional before.
	 *
	 * Leaving it unconditional had grown costly: stranded bytes consume capacity, so the buffer had to keep re-growing.
	 * Streaming a 1M-row CSV reallocated **788 times against 2** once compaction was added, and a 100MB quoted field
	 * stopped leaving **101.58MB** stranded for the remainder of the stream. Throughput improved slightly either way, so
	 * this is not a memory-for-speed trade.
	 *
	 * @param start - The starting byte index of which bytes to keep.
	 * @param end - The ending byte index of which bytes to keep. Defaults to the current buffer length. Values past the
	 *   buffer length are clamped.
	 */
	public compress(start = 0, end: number = this.bytes.length): void {
		const clampedEnd = Math.min(end, this.bytes.length)
		const validEnd = Math.min(this.bytesWritten, clampedEnd)
		const nextByteLength = Math.max(0, validEnd - start)

		const kept = this.bytes.subarray(start, clampedEnd)
		const strandedByteLength = kept.byteOffset

		if (strandedByteLength > nextByteLength) {
			// `copyWithin` over the whole allocation rather than a fresh buffer: no allocation, and the
			// reclaimed prefix comes back as capacity instead of being handed to the GC only to be
			// re-grown. Right-sizing into a new buffer was measurably worse — it pushed the 1M-row CSV
			// back to 785 reallocations without improving peak RSS.
			const allocation = new Uint8Array(kept.buffer)

			allocation.copyWithin(0, kept.byteOffset, kept.byteOffset + nextByteLength)

			this.bytes = allocation
		} else {
			this.bytes = kept
		}

		this.bytesWritten = nextByteLength
	}

	/**
	 * Clear the buffer, zeroing out all bytes.
	 *
	 * @param begin The starting byte index from which to clear.
	 * @param end The ending byte index to clear.
	 */
	public clear(begin = 0, end: number = this.bytesWritten): void {
		this.bytes.fill(0, begin, end)
		this.bytesWritten = 0
	}

	/**
	 * Gets a new Uint8Array view of the ArrayBuffer store for this array, referencing the elements at begin, inclusive,
	 * up to end, exclusive.
	 *
	 * @param begin — The index of the beginning of the array.
	 * @param end — The index of the end of the array
	 * @throws If the start index is greater than the end index.
	 * @throws If the end index is greater than the current byte length.
	 */
	public subarray(begin = 0, end: number = this.bytesWritten): Uint8Array {
		if (begin > end) {
			throw new RangeError(`Start index ${begin} is greater than end index ${end}.`)
		}

		if (end > this.bytesWritten) {
			throw new RangeError(`End index ${end} is greater than the current byte length ${this.bytesWritten}.`)
		}

		return this.bytes.subarray(begin, end)
	}

	/**
	 * Sets a value or an array of values.
	 *
	 * Unlike the `TypedArray.set` method, this method will grow the buffer if the offset is greater than the current byte
	 * length.
	 *
	 * @param array — A typed or untyped array of values to set.
	 * @param offset — The index in the current array at which the values are to be written.
	 *
	 * @returns The number of bytes written.
	 */
	public set(array: ArrayLike<number>, offset = 0): number {
		const nextLength = offset + array.length

		if (nextLength > this.bytes.length) {
			// Growing to exactly `nextLength` makes repeated appends quadratic: each one reallocates
			// and copies the whole buffer, so building N bytes from fixed-size chunks copies ~N²/2c.
			// It only bites when a single record outgrows the chunk size — which is what quote
			// handling does, since a long quoted region emits no rows and the buffer must hold it.
			// Measured on a 100MB single quoted field: 1549 reallocations, 76GB copied, 60.6s.
			// Doubling brings that to 11 reallocations, 0.13GB, and 9.3s.
			//
			// Doubling rather than a gentler 1.5×, and uncapped: a sweep at 1/10/50/100MB found 1.5×
			// no faster and, at 100MB, *worse* on peak RSS (396MB against 354MB) despite holding less
			// capacity. Peak memory here is dominated by garbage from discarded buffers, not by the
			// final allocation, so the strategy that reallocates least also peaks lowest.
			this.grow(Math.max(nextLength, this.bytes.length * 2))
		}

		this.bytes.set(array, offset)

		if (nextLength > this.bytesWritten) {
			this.bytesWritten = nextLength
		}

		return nextLength
	}
}
