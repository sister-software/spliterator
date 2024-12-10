/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Utilities for working with newline-delimited files.
 */

import { PathLike, read } from "node:fs"
import { open } from "node:fs/promises"
import { ReadableStream, ReadableStreamController } from "node:stream/web"
import { Delimiter, FileHandleLike, isFileHandleLike } from "./common.js"

/**
 * Given a buffer containing newline-delimited data, yield each line.
 *
 * @param input The buffer containing newline-delimited data.
 * @yields Each line in the buffer.
 */
export function* takeBufferLines(input: Buffer, delimiterCharacterCode: number = Delimiter.LineFeed): Iterable<string> {
	let currentByteIndex = 0
	let lastNewlineIndex = 0

	while (currentByteIndex < input.length) {
		const byte = input[currentByteIndex]

		if (byte === delimiterCharacterCode) {
			const line = input.subarray(lastNewlineIndex, currentByteIndex).toString()
			yield line

			lastNewlineIndex = currentByteIndex + 1
		}

		currentByteIndex++
	}

	if (lastNewlineIndex < currentByteIndex) {
		const line = input.subarray(lastNewlineIndex, currentByteIndex).toString()
		yield line
	}
}

/**
 * Given a file handle and a range of bytes, read the range into a buffer.
 *
 * @param fileHandle The file handle to read from.
 * @param start The starting byte index.
 * @param end The ending byte index.
 * @param buffer A buffer to write the data to. If not provided, a new buffer will be created.
 */
export function readRange(fileHandle: FileHandleLike, start: number, end: number, buffer?: Buffer): Promise<Buffer> {
	const size = end - start

	if (size <= 0) {
		throw new Error(`Invalid range. Start: ${start}, End: ${end}`)
	}

	buffer ||= Buffer.alloc(end - start)

	return new Promise((resolve, reject) => {
		read(fileHandle.fd, buffer, 0, end - start, start, (error) => {
			if (error) {
				reject(error)
			} else {
				resolve(buffer)
			}
		})
	})
}

/**
 * An input for reading newline-delimited files, which can be a file handle or a path to a file.
 */
export type LineReaderInput = FileHandleLike | PathLike

/**
 * Options for reading newline-delimited files.
 */
export interface LineReaderOptions {
	/**
	 * The character to use for newlines. Defaults to the system's newline character.
	 */
	delimiter?: number

	/**
	 * Whether to close the file handle after completion.
	 *
	 * @default true
	 */
	closeFileHandle?: boolean

	/**
	 * Whether to skip empty lines, i.e., lines that contain only a newline character.
	 */
	skipEmptyLines?: boolean

	/**
	 * The maximum number of lines to yield. Useful for limiting the number of lines read from a file.
	 *
	 * Note that skipped lines are not counted towards the limit.
	 *
	 * @default Infinity
	 */
	lineLimit?: number

	/**
	 * An `AbortSignal` to cancel the read operation.
	 */
	signal?: AbortSignal
}

const codeToPrintable = (charCode: number | undefined) => {
	if (typeof charCode === "undefined") return "␀"
	if (charCode === Delimiter.LineFeed) return "␤"
	if (charCode === Delimiter.CarriageReturn) return "␍"
	if (charCode === 0) return "␀"

	return String.fromCharCode(charCode)
}

/**
 * A reader for newline-delimited files.
 *
 * ```js
 * const reader = new LineReader("example.csv")
 *
 * for await (const line of reader) {
 *   console.log(line.toString())
 * }
 * ```
 */
export class LineReader<T = Buffer> extends ReadableStream<T> implements AsyncDisposable {
	constructor(
		/**
		 * The path to the CSV, NDJSON, or other newline-delimited file.
		 */
		input: LineReaderInput,
		{
			delimiter = Delimiter.LineFeed,
			lineLimit = Infinity,
			closeFileHandle = true,
			skipEmptyLines = true,
			signal,
		}: LineReaderOptions = {}
	) {
		let fileHandle: FileHandleLike | null = null

		const release = async () => {
			if (fileHandle && closeFileHandle) {
				await fileHandle[Symbol.asyncDispose]?.()
				fileHandle = null
			}
		}

		if (signal) {
			signal.addEventListener("abort", release)
		}

		const start = async (controller: ReadableStreamController<T>) => {
			fileHandle = isFileHandleLike(input) ? input : await open(input, "r")
			const stats = await fileHandle.stat()
			inputSize = stats.size

			if (inputSize === 0) {
				controller.close()
				return
			}
		}

		let inputSize = 0
		let offset = 0
		let cursor = 0
		let lineCount = 0

		const characterBuffer = Buffer.alloc(4)

		const pull = async (controller: ReadableStreamController<T>) => {
			// If we don't have a file handle, we close the controller...
			if (!fileHandle) {
				controller.close()
				return
			}

			if (lineCount === lineLimit) {
				controller.close()
				return
			}

			let currentCharacter: number | undefined
			let nextCharacter: number | undefined

			while (cursor < inputSize) {
				const clampedStart = Math.max(cursor - 1, 0)
				const clampedEnd = Math.min(cursor + 3, inputSize)

				await readRange(fileHandle, clampedStart, clampedEnd, characterBuffer)

				if (clampedStart === 0) {
					currentCharacter = characterBuffer[0]
					nextCharacter = characterBuffer[1]
				} else {
					currentCharacter = characterBuffer[1]
					nextCharacter = characterBuffer[2]
				}

				if (currentCharacter === Delimiter.CarriageReturn) {
					if (nextCharacter !== Delimiter.LineFeed) {
						throw new Error(`Expected carriage return character at ${cursor}: ${currentCharacter}`)
					}
				} else if (currentCharacter === delimiter) {
					break
				}

				cursor++
			}

			// Looks like we're at the end of a line, so we can read the contents.
			let line = await readRange(fileHandle, offset, cursor)

			let empty = false

			switch (line.length) {
				case 0:
					empty = true
					break
				case 1:
					empty = line[0] === delimiter || line[0] === Delimiter.CarriageReturn
					break
				case 2:
					empty = line[0] === Delimiter.CarriageReturn && line[1] === delimiter
					break
				default:
					empty = /^\s*$/.test(line.toString())
			}

			if (nextCharacter === Delimiter.CarriageReturn || nextCharacter === delimiter) {
				offset = cursor
			} else {
				offset = cursor + 1
			}

			// console.log(
			// 	`>> #${lineCount} (${line.length} bytes) (start: ${offset}, end: ${cursor}):`,
			// 	"^" + Array.from(line, codeToPrintable).join("·") + "$"
			// )

			if (empty) {
				// If we're not skipping empty lines, we need to emit an empty buffer,
				// This matches the behavior of splitting a string with extra newlines.
				line = Buffer.alloc(0)
			}

			if (!empty || !skipEmptyLines) {
				// We enqueue the line, emitting it to the consumer.
				controller.enqueue(line as T)
			}

			// If we've reached the end of the file...
			if (cursor === inputSize) {
				// console.log(">> EOF")
				controller.close()
			}

			// Finally, we update our indexes.
			cursor++
			lineCount++
		}

		super({
			start,
			pull,
			cancel: release,
		})
	}

	public async [Symbol.asyncDispose](): Promise<void> {
		await this.cancel()
	}
}
