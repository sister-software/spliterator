/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import type { CharacterSequenceInput } from "../core/CharacterSequence.js"
import { Spliterator, type SpliteratorInit } from "../core/Spliterator.js"
import type { AsyncDataResource } from "../internal/shared.js"
import { type AdaptiveSourceInit, openDelimitedRows } from "../io/adaptive-source.js"
import { AsyncSequence } from "../iterators/AsyncSequence.js"
import { Sequence } from "../iterators/Sequence.js"

export interface TextSpliteratorInit {
	/**
	 * The encoding to use when decoding the data.
	 *
	 * @default "utf-8"
	 * @see https://developer.mozilla.org/en-US/docs/Web/API/TextDecoder/TextDecoder
	 */
	encoding?: string

	/**
	 * Whether to throw an error when encountering invalid data, or to swap it with a replacement character.
	 */
	fatal?: boolean

	/**
	 * Whether to ignore BOM characters.
	 */
	ignoreBOM?: boolean

	/**
	 * Trim leading and trailing whitespace from each decoded row. With `skipEmpty` (on by default) a row that is
	 * whitespace-only is then dropped too, so a CRLF file read on `\n` yields clean lines and a padded list yields clean
	 * entries. Pass `false` to keep every row byte-for-byte as decoded.
	 *
	 * @default true
	 */
	trim?: boolean
}

const ASCII_WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0b, 0x0c, 0x0d])

/**
 * Whether a raw row would trim to nothing: what `count` tests so it agrees with `from` without decoding. It checks
 * ASCII whitespace, which is what a delimited text file contains; `String.prototype.trim` also strips the rarer Unicode
 * spaces, so a row made only of those is counted here and dropped there.
 */
function isBlank(row: Uint8Array): boolean {
	for (const byte of row) {
		if (!ASCII_WHITESPACE.has(byte)) return false
	}

	return true
}

/**
 * The row generator behind {@linkcode TextSpliterator.from}, kept at module scope so `from` can hand it to a
 * {@linkcode Sequence} while staying lazy — calling a generator function runs none of its body.
 */
function* decodeRows(
	source: CharacterSequenceInput,
	{ encoding, fatal, ignoreBOM, trim = true, ...options }: TextSpliteratorInit & SpliteratorInit = {}
): Generator<string> {
	const decoder = new TextDecoder(encoding, { fatal, ignoreBOM })
	const dropBlank = trim && (options.skipEmpty ?? true)
	let rowCursor = 0

	const spliterator = Spliterator.fromSync(source, options)

	for (const row of spliterator) {
		let decoded: string

		try {
			decoded = decoder.decode(row)
		} catch (parsedError) {
			const error = new SyntaxError(`Failed to decode data at row ${rowCursor}`)
			error.cause = parsedError

			throw error
		}

		rowCursor++

		if (trim) {
			decoded = decoded.trim()

			if (dropBlank && !decoded) continue
		}

		yield decoded
	}
}

export abstract class TextSpliterator {
	constructor() {
		throw new TypeError("Static class cannot be instantiated. Did you mean `TextSpliterator.from`?")
	}

	/**
	 * Synchronously yield delimited text from a byte array or string.
	 *
	 * @param source The source content to split.
	 * @param options The options to use when splitting the content.
	 *
	 * @yields Each slice of the source content.
	 * @see {@linkcode TextSpliterator.fromAsync} for asynchronous iteration with decoding.
	 * @see {@linkcode Spliterator.fromSync} for synchronous iteration without decoding.
	 */
	public static from(
		source: CharacterSequenceInput,
		init: TextSpliteratorInit & SpliteratorInit = {}
	): Sequence<string> {
		return new Sequence(decodeRows(source, init))
	}

	/**
	 * Count logical text rows without decoding them.
	 *
	 * This counts the slices {@linkcode from} would yield, including a final unterminated row and its `skipEmpty`, `drop`,
	 * and `take` behavior. The blank test is ASCII whitespace, so a row of only Unicode spaces is counted here and
	 * dropped by `from` after decoding.
	 *
	 * @see {@linkcode countAsync} for files and other asynchronous sources.
	 */
	public static count(source: CharacterSequenceInput, init: TextSpliteratorInit & SpliteratorInit = {}): number {
		const { encoding: _encoding, fatal: _fatal, ignoreBOM: _ignoreBOM, trim = true, ...options } = init
		const dropBlank = trim && (options.skipEmpty ?? true)
		let count = 0

		for (const row of Spliterator.fromSync(source, options)) {
			if (dropBlank && isBlank(row)) continue

			count++
		}

		return count
	}

	/**
	 * Count logical text rows without decoding them.
	 *
	 * This counts the slices {@linkcode fromAsync} would yield, including a final unterminated row and its `skipEmpty`,
	 * `drop`, and `take` behavior, with the same ASCII-only blank test as {@linkcode count}. A path, URL, or file handle
	 * is opened independently and can then be passed to {@linkcode fromAsync}; an async chunk source is inherently
	 * consumed.
	 */
	public static async countAsync(
		source: AsyncDataResource,
		{
			encoding: _encoding,
			fatal: _fatal,
			ignoreBOM: _ignoreBOM,
			trim = true,
			...options
		}: TextSpliteratorInit & AdaptiveSourceInit = {}
	): Promise<number> {
		const rows = await openDelimitedRows(source, options)
		const dropBlank = trim && (options.skipEmpty ?? true)
		let count = 0

		for await (const row of rows) {
			if (dropBlank && isBlank(row)) continue

			count++
		}

		return count
	}

	/**
	 * Asynchronously yield delimited text from a byte array or string.
	 *
	 * @param source The async data resource to split.
	 * @param options The options to use when splitting the content.
	 *
	 * @yields Each slice of the source content.
	 * @see {@linkcode TextSpliterator.from} for synchronous iteration with decoding.
	 * @see {@linkcode Spliterator.fromAsync} for asynchronous iteration without decoding.
	 */
	public static fromAsync(
		source: AsyncDataResource,
		{ encoding, fatal, ignoreBOM, trim = true, ...options }: TextSpliteratorInit & AdaptiveSourceInit = {}
	): AsyncSequence<string> {
		const decoder = new TextDecoder(encoding, { fatal, ignoreBOM })
		const dropBlank = trim && (options.skipEmpty ?? true)

		// Decoding is an op on the sequence rather than a generator wrapped inside one. A wrapping generator adds an async frame
		// per row on top of the sequence's own, which measured 297ms against 279ms over 500k rows.
		const decoded = AsyncSequence.from<Uint8Array>(() => openDelimitedRows(source, options)).map((row, rowCursor) => {
			try {
				const text = decoder.decode(row)

				return trim ? text.trim() : text
			} catch (parsedError) {
				const error = new SyntaxError(`Failed to decode data at row ${rowCursor}`)
				error.cause = parsedError

				throw error
			}
		})

		return dropBlank ? decoded.filter((line) => line.length > 0) : decoded
	}
}
