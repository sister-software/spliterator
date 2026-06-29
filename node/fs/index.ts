/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { type CreateWriteStreamOptions, open, stat } from "node:fs/promises"
import { Writable } from "node:stream"
import { WritableStream } from "node:stream/web"

import { type AsyncChunkIterator, type AsyncDataResource, isFileHandleLike } from "../../lib/shared.js"

/**
 * Create a readable stream from a file system source.
 *
 * If the source is not a string or URL, this function will return `process.stdin`.
 *
 * @param source The source to read from.
 * @param highWaterMark The buffer chunk size to read from the file.
 *
 * @returns The readable stream.
 */
export async function createReadStream(source: unknown, highWaterMark: number): Promise<AsyncChunkIterator> {
	if (typeof source !== "string" || !source) {
		// We check if STDIN is a TTY to prevent blocking the terminal.
		if (process.stdin.isTTY) {
			throw new TypeError("No source file provided. provide a source argument or pipe data to STDIN.")
		}

		return process.stdin
	}

	const handle = await open(source, "r")

	return handle.createReadStream({
		autoClose: true,
		highWaterMark,
	})
}

/**
 * Create a writable stream from a file system destination.
 *
 * Unlike Node's native `fs.createWriteStream`, this function will return `process.stdout` if the destination is not a
 * string or URL.
 *
 * @param destination The destination to write to.
 *
 * @returns The writable stream.
 */
export async function createFileWritableStream(
	destination: unknown,
	options: CreateWriteStreamOptions = {}
): Promise<WritableStream> {
	let nodeWriteStream: Writable

	if (typeof destination !== "string" || !destination) {
		nodeWriteStream = process.stdout
	} else {
		const handle = await open(destination, "w")

		nodeWriteStream = handle.createWriteStream({
			autoClose: true,
			...options,
		})
	}

	nodeWriteStream.once("error", (error) => {
		console.error("Failed to write to the destination stream:", error)

		process.exit(1)
	})

	return new WritableStream({
		async write(chunk) {
			const canWrite = nodeWriteStream.write(chunk)

			if (canWrite) return Promise.resolve()

			return new Promise((resolve) => {
				nodeWriteStream.once("drain", resolve)
			})
		},

		async abort(reason) {
			return new Promise((resolve, reject) => {
				if ("destroy" in nodeWriteStream) {
					nodeWriteStream.destroy(reason)
				}

				nodeWriteStream.once("error", reject)
				nodeWriteStream.once("close", resolve)
			})
		},

		async close() {
			return new Promise((resolve, reject) => {
				nodeWriteStream.end()
				nodeWriteStream.once("error", reject)
				nodeWriteStream.once("finish", resolve)
			})
		},
	})
}

export interface CreateChunkIteratorOptions {
	/**
	 * The buffer chunk size to read from the file, i.e. the high-water mark for the file read.
	 */
	highWaterMark?: number

	/**
	 * The byte position to start reading from.
	 */
	start?: number

	/**
	 * The byte position to stop reading at, **inclusive** (matches Node `createReadStream({ end })`). To read the
	 * half-open range `[start, end)`, pass `{ start, end: end - 1 }`.
	 */
	end?: number
}

/**
 * Read the size of a file from a source.
 *
 * @param source The source to read the file size from.
 *
 * @returns The file size in bytes.
 * @internal
 */
export async function readFileSize(source: AsyncDataResource): Promise<number> {
	if (typeof source === "string" || source instanceof URL) {
		return stat(source).then(({ size }) => size)
	}

	if (isFileHandleLike(source)) {
		return source.stat().then(({ size }) => size)
	}

	throw new TypeError("The provided source does not support file size retrieval.")
}

/**
 * Read a fixed-length window of bytes from `start`. The result is EOF-clamped, so it may be shorter than `length`. Used
 * for delimiter-boundary probing.
 *
 * @internal
 */
export async function readBytes(source: AsyncDataResource, start: number, length: number): Promise<Uint8Array> {
	if (typeof source !== "string" && !(source instanceof URL) && !isFileHandleLike(source)) {
		throw new TypeError("readBytes requires a file path, URL, or file handle.")
	}

	const handle = isFileHandleLike(source) ? source : await open(source, "r")

	try {
		const buffer = new Uint8Array(length)
		const { bytesRead } = await handle.read(buffer, 0, length, start)

		return buffer.subarray(0, bytesRead)
	} finally {
		// Only close handles we opened.
		if (!isFileHandleLike(source)) await handle.close()
	}
}

/**
 * Create an async chunk iterator from a source.
 *
 * @param source The source to create the chunk iterator from.
 * @internal
 */
export async function createChunkIterator(
	source: AsyncDataResource | AsyncChunkIterator,
	{ highWaterMark = 4096 * 16, start = 0, end }: CreateChunkIteratorOptions = {}
): Promise<AsyncChunkIterator> {
	if (!source) {
		throw new TypeError("Cannot create a chunk iterator from an undefined or null source.")
	}

	if (typeof source === "string" || source instanceof URL) {
		const statable = await stat(source)
			.then(() => true)
			.catch(() => false)

		if (!statable) {
			// Note that we don't log the source here, as it may contain sensitive information,
			// and may possibly not be encoded for display.
			throw new TypeError(
				"Cannot read from the provided source. See caller of `createChunkIterator` for more information."
			)
		}

		const handle = await open(source, "r")

		const readStream = handle.createReadStream({
			start,
			end,
			highWaterMark,
			autoClose: true,
		})

		return readStream
	}

	if (Symbol.asyncIterator in source) {
		return source
	}

	if (isFileHandleLike(source)) {
		if (source.createReadStream) {
			return source.createReadStream({
				start,
				end,
				highWaterMark,
			})
		}

		if (source.readableWebStream) {
			return source.readableWebStream()
		}

		throw new TypeError("The provided file handle does not support readable web streams.")
	}

	throw new TypeError("The provided source does not support async iteration.")
}

export default createChunkIterator
