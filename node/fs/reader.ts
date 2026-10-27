/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

import { open, stat } from "node:fs/promises"

import {
	type AsyncChunkIterator,
	type AsyncDataResource,
	isFileHandleLike,
	isPathBuilderLike,
	toPathString,
} from "#internal/shared"
import { COMPRESSED_EXTENSIONS } from "#io/compression"

/**
 * The path a delimited file is read from: `path.zst` when it exists, else `path.gz` when it exists, else `path`.
 *
 * A corpus converted one part file at a time then reads the same whether a part has been compressed yet or not: a
 * reader asks for `part-0000.jsonl` and gets `part-0000.jsonl.zst` once the conversion has reached it. A path that
 * already names a compressed file, and any source that is not a path, is returned unchanged.
 */
export async function resolveCompressedSibling<T>(source: T): Promise<T | string> {
	if (!isPathBuilderLike(source)) return source

	const path = toPathString(source)

	if (COMPRESSED_EXTENSIONS.some((extension) => path.endsWith(extension))) return source

	for (const extension of COMPRESSED_EXTENSIONS) {
		const candidate = `${path}${extension}`

		const found = await stat(candidate)
			.then((stats) => stats.isFile())
			.catch(() => false)

		if (found) return candidate
	}

	return source
}

/**
 * Create a readable stream from a file system source.
 *
 * Anything but a non-empty string path reads `process.stdin`, which must not be a TTY.
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
	if (isPathBuilderLike(source)) {
		source = toPathString(source)
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
	if (isPathBuilderLike(source)) {
		source = toPathString(source)
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

	if (isPathBuilderLike(source)) {
		source = toPathString(source)
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
