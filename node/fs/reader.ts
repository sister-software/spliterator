/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { open, stat } from "node:fs/promises"

import { PathBuilder } from "path-ts"

import { type AsyncChunkIterator, type AsyncDataResource, isFileHandleLike } from "../../lib/internal/shared.js"

/**
 * Create a readable stream from a file system source.
 *
 * If the source is not a string or URL, this function will return `process.stdin`.
 */
export async function createReadStream(source: unknown, highWaterMark: number): Promise<AsyncChunkIterator> {
	if (typeof source !== "string" || !source) {
		if (process.stdin.isTTY) {
			throw new TypeError("No source file provided. provide a source argument or pipe data to STDIN.")
		}

		return process.stdin
	}

	const handle = await open(source, "r")

	return handle.createReadStream({ autoClose: true, highWaterMark })
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
 * @internal
 */
export async function readFileSize(source: AsyncDataResource): Promise<number> {
	if (source instanceof PathBuilder) {
		source = source.toString()
	}

	if (typeof source === "string" || source instanceof URL) return stat(source).then(({ size }) => size)

	if (isFileHandleLike(source)) {
		return source.stat().then(({ size }) => size)
	}

	throw new TypeError("The provided source does not support file size retrieval.")
}

/**
 * Read an EOF-clamped window of bytes from `start`.
 *
 * @internal
 */
export async function readBytes(source: AsyncDataResource, start: number, length: number): Promise<Uint8Array> {
	if (source instanceof PathBuilder) {
		source = source.toString()
	}

	if (typeof source !== "string" && !(source instanceof URL) && !isFileHandleLike(source)) {
		throw new TypeError("readBytes requires a file path, URL, or file handle.")
	}

	const handle = isFileHandleLike(source) ? source : await open(source, "r")

	try {
		const buffer = new Uint8Array(length)
		const { bytesRead } = await handle.read(buffer, 0, length, start)

		return buffer.subarray(0, bytesRead)
	} finally {
		if (!isFileHandleLike(source)) {
			await handle.close()
		}
	}
}

/**
 * Create an async chunk iterator from a source.
 *
 * @internal
 */
export async function createChunkIterator(
	source: AsyncDataResource | AsyncChunkIterator,
	{ highWaterMark = 4096 * 16, start = 0, end }: CreateChunkIteratorOptions = {}
): Promise<AsyncChunkIterator> {
	if (!source) {
		throw new TypeError("Cannot create a chunk iterator from an undefined or null source.")
	}

	if (source instanceof PathBuilder) {
		source = source.toString()
	}

	if (typeof source === "string" || source instanceof URL) {
		const statable = await stat(source)
			.then(() => true)
			.catch(() => false)

		if (!statable) {
			throw new TypeError(
				"Cannot read from the provided source. See caller of `createChunkIterator` for more information."
			)
		}

		const handle = await open(source, "r")

		return handle.createReadStream({ start, end, highWaterMark, autoClose: true })
	}

	if (Symbol.asyncIterator in source) {
		return source
	}

	if (isFileHandleLike(source)) {
		if (source.createReadStream) {
			return source.createReadStream({ start, end, highWaterMark })
		}

		if (source.readableWebStream) {
			return source.readableWebStream()
		}

		throw new TypeError("The provided file handle does not support readable web streams.")
	}

	throw new TypeError("The provided source does not support async iteration.")
}

export default createChunkIterator
