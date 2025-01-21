/**
 * @copyright Sister Software
 * @license AGPL-3.0
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
	 * This is performed after we're confident that any data preceeding `start` or following `end` is
	 * no longer needed.
	 *
	 * @param start - The starting byte index of which bytes to keep.
	 * @param end - The ending byte index of which bytes to keep.
	 */
	public compress(start: number = 0, end?: number): void {
		end ??= Math.max(this.byteLengthMinimum, this.bytes.length)
		const adjustedBytesWritten = Math.min(this.bytesWritten, end - start)

		this.bytes = this.bytes.subarray(start, end)

		this.bytesWritten = adjustedBytesWritten
	}

	/**
	 * Clear the buffer, zeroing out all bytes.
	 *
	 * @param begin The starting byte index from which to clear.
	 * @param end The ending byte index to clear.
	 */
	public clear(begin: number = 0, end: number = this.bytesWritten): void {
		this.bytes.fill(0, begin, end)
		this.bytesWritten = 0
	}

	/**
	 * Gets a new Uint8Array view of the ArrayBuffer store for this array, referencing the elements at
	 * begin, inclusive, up to end, exclusive.
	 *
	 * @param begin — The index of the beginning of the array.
	 * @param end — The index of the end of the array
	 * @throws If the start index is greater than the end index.
	 * @throws If the end index is greater than the current byte length.
	 */
	public subarray(begin: number = 0, end: number = this.bytesWritten): Uint8Array {
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
	 * Unlike the `TypedArray.set` method, this method will grow the buffer if the offset is greater
	 * than the current byte length.
	 *
	 * @param array — A typed or untyped array of values to set.
	 * @param offset — The index in the current array at which the values are to be written.
	 *
	 * @returns The number of bytes written.
	 */
	public set(array: ArrayLike<number>, offset: number = 0): number {
		const nextLength = offset + array.length

		if (nextLength > this.bytes.length) {
			this.grow(nextLength)
		}

		this.bytes.set(array, offset)

		if (nextLength > this.bytesWritten) {
			this.bytesWritten = nextLength
		}

		return nextLength
	}
}
