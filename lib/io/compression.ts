/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 *
 * Transparent decompression of delimited sources, detected by magic bytes rather than by file extension so a stream,
 * a buffer and a path all behave alike.
 *
 * Node's `node:zlib` handles both formats and is reached through `process.getBuiltinModule`, which keeps the root
 * entry free of a static `node:` import. Elsewhere gzip goes through the web `DecompressionStream`, and zstd, which no
 * browser decompresses natively, throws rather than handing compressed bytes to the parser.
 */

import type { ReadableWritablePair } from "node:stream/web"

import { joinPieces, splitZstdFrames, ZstdFrameScanner, type ZstdSegment } from "#io/zstd-frames"

/**
 * A compression format a source can arrive in.
 */
export type CompressionFormat = "zstd" | "gzip"

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const
const GZIP_MAGIC = [0x1f, 0x8b] as const

/**
 * Bytes needed to tell every supported format apart.
 */
export const COMPRESSION_SNIFF_LENGTH = ZSTD_MAGIC.length

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
	if (bytes.byteLength < magic.length) return false

	for (let i = 0; i < magic.length; i++) {
		if (bytes[i] !== magic[i]) return false
	}

	return true
}

/**
 * The compression format `bytes` begins with, or `null` for anything else. Delimited text cannot begin with either
 * magic: `0x8B` and `0xB5` are UTF-8 continuation bytes and cannot follow `0x1F` or `0x28` in valid text.
 */
export function sniffCompression(bytes: Uint8Array): CompressionFormat | null {
	if (startsWith(bytes, ZSTD_MAGIC)) return "zstd"

	if (startsWith(bytes, GZIP_MAGIC)) return "gzip"

	return null
}

type NodeZlib = typeof import("node:zlib")

type NodeStream = typeof import("node:stream")

function builtin<T>(specifier: string): T | undefined {
	const getBuiltinModule = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process
		?.getBuiltinModule

	return typeof getBuiltinModule === "function" ? (getBuiltinModule(specifier) as T | undefined) : undefined
}

function unavailable(format: CompressionFormat): TypeError {
	return new TypeError(
		`The source is ${format}-compressed and this runtime cannot decompress ${format}. ` +
			"Decompress it before reading, or pass `decompress: false` to read the compressed bytes."
	)
}

/**
 * Decompress a buffer held in memory, for the synchronous readers.
 */
export function decompressSync(bytes: Uint8Array, format: CompressionFormat): Uint8Array {
	const zlib = builtin<NodeZlib>("node:zlib")

	if (!zlib) throw unavailable(format)

	if (format === "gzip") {
		const output = zlib.gunzipSync(bytes)

		return new Uint8Array(output.buffer, output.byteOffset, output.byteLength)
	}

	// One call per frame: `zstdDecompressSync` stops after the first.
	return joinPieces(
		splitZstdFrames(bytes).map((frame) => {
			const output = zlib.zstdDecompressSync(frame)

			return new Uint8Array(output.buffer, output.byteOffset, output.byteLength)
		})
	)
}

/**
 * `bytes`, decompressed when they begin with a supported magic and `decompress` is on.
 */
export function maybeDecompressSync(bytes: Uint8Array, decompress = true): Uint8Array {
	if (!decompress) return bytes

	const format = sniffCompression(bytes)

	return format ? decompressSync(bytes, format) : bytes
}

function decompressionPair(format: CompressionFormat): ReadableWritablePair<Uint8Array, Uint8Array> {
	const zlib = builtin<NodeZlib>("node:zlib")
	const stream = builtin<NodeStream>("node:stream")

	if (zlib && stream) {
		const transform = format === "zstd" ? zlib.createZstdDecompress() : zlib.createGunzip()

		return stream.Duplex.toWeb(transform) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>
	}

	if (format === "gzip" && typeof DecompressionStream === "function") {
		return new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>
	}

	throw unavailable(format)
}

const encoder = new TextEncoder()

function toBytes(chunk: Uint8Array | string): Uint8Array {
	return typeof chunk === "string" ? encoder.encode(chunk) : chunk
}

/**
 * The chunks of `source`, decompressed when its first bytes are a supported magic, otherwise passed through unchanged.
 *
 * The head is pulled until it is long enough to sniff, then put back in front of the rest. Returning from the result
 * returns the source's iterator, so an early exit still releases it.
 */
export async function* decompressChunks(source: AsyncIterable<Uint8Array | string>): AsyncGenerator<Uint8Array> {
	const iterator = source[Symbol.asyncIterator]()
	let finished = false

	const pull = async (): Promise<Uint8Array | null> => {
		if (finished) return null

		const result = await iterator.next()

		if (result.done) {
			finished = true

			return null
		}

		return toBytes(result.value)
	}

	try {
		const head: Uint8Array[] = []
		let headLength = 0

		while (headLength < COMPRESSION_SNIFF_LENGTH) {
			const chunk = await pull()

			if (!chunk) break

			head.push(chunk)
			headLength += chunk.byteLength
		}

		const first = joinPieces(head)
		const format = sniffCompression(first)

		if (!format) {
			if (first.byteLength) {
				yield first
			}

			for (let chunk = await pull(); chunk; chunk = await pull()) {
				yield chunk
			}

			return
		}

		if (format === "gzip") {
			// A gzip decompressor reads concatenated members through on its own.
			const compressed = ReadableStream.from(
				(async function* () {
					yield first

					for (let chunk = await pull(); chunk; chunk = await pull()) {
						yield chunk
					}
				})()
			)

			for await (const chunk of compressed.pipeThrough(decompressionPair("gzip"))) {
				yield chunk
			}

			return
		}

		yield* zstdFrames(first, pull)
	} finally {
		// Always, as the engine always called `return()` on the source it read directly: a source may release its
		// resources there even after it has reported the end.
		try {
			await iterator.return?.()
		} catch {
			// Already closed. The error worth reporting, if any, is the one leaving the `try`.
		}
	}
}

/**
 * Decompress a zstd stream one frame at a time, each frame through a decompressor of its own (see `zstd-frames.ts`).
 */
async function* zstdFrames(first: Uint8Array, pull: () => Promise<Uint8Array | null>): AsyncGenerator<Uint8Array> {
	const scanner = new ZstdFrameScanner()
	const pending: ZstdSegment[] = scanner.scan(first)
	let head = 0

	const nextSegment = async (): Promise<ZstdSegment | null> => {
		while (head >= pending.length) {
			const chunk = await pull()

			if (!chunk) return null

			pending.length = 0
			head = 0
			pending.push(...scanner.scan(chunk))
		}

		return pending[head++]!
	}

	while (true) {
		const segment = await nextSegment()

		if (!segment) break

		const frameInput = ReadableStream.from(
			(async function* () {
				let current: ZstdSegment | null = segment

				while (current) {
					yield current.bytes

					if (current.final) return

					current = await nextSegment()
				}
			})()
		)

		for await (const chunk of frameInput.pipeThrough(decompressionPair("zstd"))) {
			yield chunk
		}
	}

	if (!scanner.atBoundary) {
		throw new TypeError("The source is not a valid zstd stream: the stream ends inside a frame.")
	}
}

/**
 * The extensions the sibling lookup tries, in order.
 */
export const COMPRESSED_EXTENSIONS = [".zst", ".gz"] as const
