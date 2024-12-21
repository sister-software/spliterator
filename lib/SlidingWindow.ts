/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Delimiter, DelimiterArray, DelimiterInput } from "./delmiter.js"
import { AsyncDataResource, FileHandleLike, FileSystemProvider, TypedArray } from "./shared.js"

/**
 * A tuple representing a window of bytes in a buffer.
 */
export type ByteRange = [
	/**
	 * The starting byte index of the window.
	 */
	start: number,
	/**
	 * The ending byte index of the window.
	 */
	end: number,
]

/**
 * A sliding window that iterates over an in-memory buffer, yielding byte ranges.
 *
 * @see {@link AsyncSlidingWindow} for an asynchronous version.
 */
export class SlidingWindow<T extends TypedArray> implements IterableIterator<ByteRange> {
	#haystack: T
	#delimiter: DelimiterArray
	#byteLimit: number
	#cursor: number
	#done = false

	/**
	 * The current byte index of the sliding window.
	 */
	public get cursor(): number {
		return this.#cursor
	}

	public set cursor(value: number) {
		this.#cursor = value
	}

	/**
	 * Given a byte array containing delimited data, yield a sliding window of indexes.
	 *
	 * This a low-level utility function that can be used to implement more complex parsing logic.
	 *
	 * @param haystack The buffer containing newline-delimited data.
	 * @param needle The delimiter to use. Defaults to a line feed.
	 * @param offset The byte index to start searching from.
	 * @param byteLimit The byte index to stop searching at.
	 */
	constructor(haystack: T, needle?: DelimiterInput, offset?: number, byteLimit?: number) {
		this.#haystack = haystack
		this.#delimiter = Delimiter.from(needle ?? Delimiter.LineFeed)
		this.#cursor = offset ?? 0
		this.#byteLimit = byteLimit ?? haystack.length
	}

	public next(): IteratorResult<ByteRange> {
		for (let end = this.#cursor; end < this.#byteLimit; end++) {
			// We walk through as many bytes as the delimiter has...
			const match = this.#delimiter.every((byte, i) => byte === this.#haystack[end + i])

			// We didn't find a match, so we continue.
			if (!match) continue

			const range: ByteRange = [this.#cursor, end]

			this.#cursor = end + this.#delimiter.length

			return { value: range, done: false }
		}

		if (this.#cursor <= this.#byteLimit && !this.#done) {
			const range: ByteRange = [this.#cursor, this.#byteLimit]

			this.#cursor = this.#byteLimit
			this.#done = true

			return { value: range, done: false }
		}

		return {
			value: undefined,
			done: true,
		}
	}

	public [Symbol.iterator](): IterableIterator<ByteRange> {
		return this
	}
}

/**
 * An asynchronous sliding window that iterates over a file handle, yielding byte ranges.
 *
 * @see {@link SlidingWindow} for a synchronous version.
 */
export class AsyncSlidingWindow implements AsyncIterableIterator<ByteRange> {
	#fileHandle: FileHandleLike
	#fs: FileSystemProvider
	#delimiter: DelimiterArray
	#byteLimit: number
	#cursor: number
	#done = false

	/**
	 * The current byte index of the sliding window.
	 */
	public get cursor(): number {
		return this.#cursor
	}

	public set cursor(value: number) {
		this.#cursor = value
	}

	/**
	 * Given a byte array containing delimited data, yield a sliding window of indexes.
	 *
	 * This a low-level utility function that can be used to implement more complex parsing logic.
	 *
	 * @param fileHandle The file handle to read from.
	 * @param fs A file system provider for reading data.
	 * @param needle The delimiter to use. Defaults to a line feed.
	 * @param offset The byte index to start searching from.
	 * @param byteLimit The byte index to stop searching at.
	 */
	constructor(
		fileHandle: FileHandleLike,
		fs: FileSystemProvider,
		needle?: DelimiterInput,
		offset?: number,
		byteLimit?: number
	) {
		this.#fileHandle = fileHandle
		this.#fs = fs
		this.#delimiter = Delimiter.from(needle ?? Delimiter.LineFeed)
		this.#cursor = offset ?? 0
		this.#byteLimit = byteLimit ?? Infinity
	}

	/**
	 * Read the next byte range from the file handle.
	 */
	public async next(): Promise<IteratorResult<ByteRange>> {
		const lookahead = this.#delimiter.length

		for (let end = this.#cursor; end < this.#byteLimit; end++) {
			const byteSlice = await this.#fs.read(this.#fileHandle, end, end + lookahead)

			const match = byteSlice.every((byte, i) => byte === this.#delimiter[i])

			if (!match) continue

			const range: ByteRange = [this.#cursor, end]

			this.#cursor = end + lookahead

			return { value: range, done: false }
		}

		// Handle the final window if we haven't reached the byte limit
		// and there's remaining content after the last delimiter
		if (this.#cursor <= this.#byteLimit && !this.#done) {
			const range: ByteRange = [this.#cursor, this.#byteLimit]

			this.#cursor = this.#byteLimit
			this.#done = true

			return { value: range, done: false }
		}

		return {
			value: undefined,
			done: true,
		}
	}

	/**
	 * Read the previous byte range from the file handle.
	 *
	 * This is useul for backtracking in the event that a delimiter is split across two windows.
	 */
	public async previous(): Promise<IteratorResult<ByteRange>> {
		const lookahead = this.#delimiter.length

		for (let start = this.#cursor; start > 0; start--) {
			const byteSlice = await this.#fs.read(this.#fileHandle, start - lookahead, start)

			const match = byteSlice.every((byte, i) => byte === this.#delimiter[i])

			if (!match) continue

			const range: ByteRange = [start - lookahead, this.#cursor]

			this.#cursor = start - lookahead

			return { value: range, done: false }
		}

		return {
			value: undefined,
			done: true,
		}
	}

	public async [Symbol.asyncDispose](): Promise<void> {}

	public [Symbol.asyncIterator](): AsyncIterableIterator<ByteRange> {
		return this
	}

	/**
	 * Given a file handle containing delimited data and a desired slice count, returns an array of
	 * slices of the buffer between delimiters.
	 *
	 * This is an advanced function so an analogy is provided:
	 *
	 * Suppose you had to manually go through a film reel frame by frame correct various issues. For a
	 * film of 1,000,000 frames, a single person would take a long time to go through it all.
	 *
	 * You could add more people to the task by laying out the entire film reel and cutting it into
	 * mostly even length sections. Each person would then take a section and work on it. However, we
	 * don't want to make a cut in the middle of a frame.
	 *
	 * This is similar to dealing with a large byte stream with delimiters. We want to iterate over
	 * the data in chunks, but we don't want to split a delimiter in half. Basically, we want
	 * something like a binary search for delimiters.
	 *
	 * @returns A contiguous array of slices of the buffer separated by a delimiter.
	 */
	static async slice(
		/**
		 * The buffer containing newline-delimited data.
		 */
		source: AsyncDataResource,
		/**
		 * The desired number of slices to return. This is a target, not a guarantee.
		 *
		 * This will never be less than 1, nor greater than the number of delimiters in the file, nor
		 * greater than the byte length of the file.
		 */
		desiredSlices: number = 2,
		/**
		 * The character to delimit by. Typically a newline or comma.
		 */
		delimiter?: DelimiterInput,
		fs?: FileSystemProvider
	): Promise<ByteRange[]> {
		fs ||= await import("@sister.software/ribbon/node/fs")

		const fileHandle = await fs.open(source)
		const stats = await fileHandle.stat()
		const byteLimit = stats.size

		const delimiterArray = Delimiter.from(delimiter ?? Delimiter.LineFeed)
		const delimiterLength = delimiterArray.length

		desiredSlices = Math.min(Math.max(1, desiredSlices), byteLimit / delimiterLength, byteLimit)
		const fallback: ByteRange[] = [[0, byteLimit]]

		if (desiredSlices === 1) {
			return fallback
		}

		const ranges: ByteRange[] = []
		const chunkSize = Math.floor(byteLimit / desiredSlices)

		for (let i = 0; i < desiredSlices; i++) {
			const previousSlice = ranges[i - 1] ?? [0, 0]

			const targetPoint = Math.min(i * chunkSize, byteLimit)
			const searchStart = Math.max(targetPoint - delimiterLength * 2, previousSlice[1])
			const searchEnd = Math.min(targetPoint + delimiterLength * 2, byteLimit)

			const reverse = new AsyncSlidingWindow(fileHandle, fs, delimiterArray, searchStart, searchEnd)
			const forward = new AsyncSlidingWindow(fileHandle, fs, delimiterArray, searchStart, searchEnd)

			const [previousRange, nextRange] = await Promise.all([
				// We look backward to find the previous delimiter at a midpoint in the chunk...
				reverse.previous(),
				// And forward to find the next delimiter.
				forward.next(),
			])

			if (i === 0) {
				// The first slice is always from the beginning of the file to the first delimiter.
				ranges.push(nextRange.value)

				continue
			}

			if (previousRange.done || nextRange.done) break

			// We need to fix the previous slice to end at the previous delimiter.
			previousSlice[1] = previousRange.value[0] - delimiterLength

			// And we need to fix the current slice to start at the previous delimiter.
			nextRange.value[0] = previousRange.value[0] + delimiterLength

			// We can now add the current slice to the list.
			ranges.push(nextRange.value)
		}

		if (!ranges.length) return fallback

		return ranges
	}
}
