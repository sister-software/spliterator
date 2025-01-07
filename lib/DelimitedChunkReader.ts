/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { CharacterSequence, CharacterSequenceInput } from "./CharacterSequence.js"
import { AsyncDataResource, ByteRange, FileResourceLike, isFileResourceLike } from "./shared.js"
import { AsyncSlidingWindow } from "./SlidingWindow.js"

/**
 * Options for the delimited chunk reader.
 */
export interface DeliminatedChunkReaderInit {
	/**
	 * The desired number of chunks. This is a target, not a guarantee.
	 *
	 * This will never be less than 1, nor greater than the number of delimiters in the file, nor
	 * greater than the byte length of the file.
	 */
	chunks?: number

	/**
	 * The character to delimit by. Typically a newline or comma.
	 */
	delimiter?: CharacterSequenceInput

	/**
	 * Whether to close the file handle after reading.
	 */
	autoClose?: boolean

	/**
	 * The limit of bytes to read from the file.
	 */
	limit?: number
}

/**
 * Given a file handle containing delimited data and a desired slice count, returns an array of
 * slices of the buffer between delimiters.
 *
 * This is an advanced function so an analogy is provided:
 *
 * Suppose you had to manually search through a very large book page by page to find where each
 * chapter begins and ends. For a book with 1,000,000 pages, a single person would take a long time
 * to go through it all.
 *
 * You could add more people to the task by laying out all the pages, measuring the length and
 * assigning each person a length of pages to traverse.
 *
 * There's a few ways to go about this:
 *
 * We could approach this in serial -- having the first worker start from page 1 and scanning until
 * they find the beginning of the next chapter, handing off the range to the next worker. This is
 * how `AsyncSlidingWindow` approaches the problem.
 *
 * However this is inefficient because no matter how many workers we have, they must wait for the
 * previous worker to finish before they can start. Ideally, a desired number of workers would be
 * able to scan their own _length_ of pages simultaneously, and settle up on the boundaries of the
 * chapters they find.
 *
 * `DeliminatedChunkReader` is like the second approach. Given a desired number of chunks
 *
 * @returns A contiguous array of slices of the buffer separated by a delimiter.
 */
export class DelimitedChunkReader {
	static async fromAsync(
		/**
		 * The buffer containing newline-delimited data.
		 */
		source: AsyncDataResource,
		init: DeliminatedChunkReaderInit = {}
	): Promise<ByteRange[]> {
		let file: FileResourceLike

		if (isFileResourceLike(source)) {
			file = source
		} else {
			const { NodeFileResource } = await import("spliterator/node/fs")
			file = await NodeFileResource.open(source)
		}

		const byteLimit = init.limit ?? file.size
		// const byteLimit = init.limit ?? (await fileHandle.stat()).size

		const delimiter = new CharacterSequence(init.delimiter)
		const delimiterLength = delimiter.length

		const desiredSlices = Math.min(Math.max(1, init.chunks ?? 2), byteLimit / delimiterLength, byteLimit)
		const fallback: ByteRange[] = [[0, byteLimit]]

		if (desiredSlices === 1) {
			return fallback
		}

		const ranges: ByteRange[] = []
		const chunkSize = Math.floor(byteLimit / desiredSlices)

		for (let i = 0; i < desiredSlices; i++) {
			const previousSlice = ranges[i - 1] ?? [0, 0]

			const chunkEnd = Math.min(i * chunkSize, byteLimit)
			const searchStart = Math.max(chunkEnd - delimiterLength * 2, previousSlice[1])
			const searchEnd = Math.min(chunkEnd + delimiterLength * 2, byteLimit)

			const reverse = new AsyncSlidingWindow(file, {
				delimiter,
				position: searchStart,
				byteLength: searchEnd,
			})
			const forward = new AsyncSlidingWindow(file, {
				delimiter,
				position: searchStart,
				byteLength: searchEnd,
			})

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

			if (i === desiredSlices - 1) {
				const range: ByteRange = [previousRange.value[0] + delimiterLength, byteLimit]
				// We need to fix the previous slice to end at the previous delimiter.
				previousSlice[1] = previousRange.value[0] - delimiterLength

				// The last slice is always from the last delimiter to the end of the file.
				ranges.push(range)

				break
			}

			// We need to fix the previous slice to end at the previous delimiter.
			previousSlice[1] = previousRange.value[0] - delimiterLength

			// And we need to fix the current slice to start at the previous delimiter.
			nextRange.value[0] = previousRange.value[0] + delimiterLength

			// We can now add the current slice to the list.
			ranges.push(nextRange.value)
		}

		if (!ranges.length) return fallback

		if (init.autoClose) {
			await file[Symbol.asyncDispose]?.()
		}

		return ranges
	}
}
