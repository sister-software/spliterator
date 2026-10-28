/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

import { AsyncSpliterator } from "#core/AsyncSpliterator"
import { CharacterSequence, type CharacterSequenceInput, normalizeCharacterInput } from "#core/CharacterSequence"
import { Spliterator, type SpliteratorInit } from "#core/Spliterator"
import type { AsyncDataResource } from "#internal/shared"
import { type AdaptiveSourceInit, openDelimitedRows } from "#io/adaptive-source"
import { maybeDecompressSync } from "#io/compression"
import { canSplitAsText, textRows, windowedTextRows } from "#io/windowed-text"
import { AsyncSequence } from "#iterators/AsyncSequence"
import { Sequence } from "#iterators/Sequence"

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

const blankDecoder = new TextDecoder()

/**
 * Whether a raw row would trim to nothing, so `count` agrees exactly with what `from` yields. An ASCII row is judged on
 * its bytes; only a row whose first non-whitespace byte is non-ASCII is decoded, since `String.prototype.trim` also
 * strips Unicode spaces (U+00A0, U+3000, a BOM).
 */
function isBlank(row: Uint8Array): boolean {
	for (const byte of row) {
		if (byte >= 0x80) return blankDecoder.decode(row).trim().length === 0

		if (!ASCII_WHITESPACE.has(byte)) return false
	}

	return true
}

/**
 * The row generator behind {@linkcode TextSpliterator.from}, kept at module scope so `from` can hand it to a
 * {@linkcode Sequence} while staying lazy — calling a generator function runs none of its body.
 *
 * `drop` and `take` count the rows the caller receives, so they apply here, after blank rows are dropped, rather than
 * in the engine. Before 10.0.0 they counted engine rows, and a whitespace-only row used up a `take`.
 */
function* decodeRows(
	source: CharacterSequenceInput,
	{
		encoding,
		fatal,
		ignoreBOM,
		trim = true,
		drop: dropInput = 0,
		take: takeInput = Infinity,
		decompress = true,
		...options
	}: TextSpliteratorInit & SpliteratorInit = {}
): Generator<string> {
	const dropBlank = trim && (options.skipEmpty ?? true)
	const drop = Math.max(0, dropInput)
	const take = Math.max(0, takeInput)
	let skipped = 0
	let yielded = 0

	if (take <= 0) return

	// A string is already text: split it as text instead of encoding it, scanning the bytes and decoding each row back.
	// The byte route cost 7.8µs for a 40-line string against 1µs for `split`; this is what the stdout-splitting callers
	// pay per call.
	if (typeof source === "string" && canSplitAsText({ ...options, encoding })) {
		for (let row of textRows(source, options, !ignoreBOM)) {
			if (trim) {
				row = row.trim()

				if (dropBlank && !row) continue
			}

			if (skipped < drop) {
				skipped++

				continue
			}

			yield row

			if (++yielded >= take) return
		}

		return
	}

	const decoder = new TextDecoder(encoding, { fatal, ignoreBOM })
	const bytes = typeof source === "string" ? source : maybeDecompressSync(normalizeCharacterInput(source), decompress)
	let rowCursor = 0

	for (const row of Spliterator.fromSync(bytes, options)) {
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

		if (skipped < drop) {
			skipped++

			continue
		}

		yield decoded

		if (++yielded >= take) return
	}
}

/**
 * Apply `drop` and `take` to a count of rows, the way the readers apply them to the rows they yield.
 */
function dropTakeCount(rows: number, drop: number, take: number): number {
	return Math.min(Math.max(0, rows - Math.max(0, drop)), Math.max(0, take))
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
	 * This counts the rows {@linkcode from} would yield, including a final unterminated row and its `skipEmpty`, `drop`,
	 * and `take` behavior.
	 *
	 * @see {@linkcode countAsync} for files and other asynchronous sources.
	 */
	public static count(source: CharacterSequenceInput, init: TextSpliteratorInit & SpliteratorInit = {}): number {
		const {
			encoding: _encoding,
			fatal: _fatal,
			ignoreBOM: _ignoreBOM,
			trim = true,
			drop = 0,
			take = Infinity,
			decompress = true,
			...options
		} = init

		const dropBlank = trim && (options.skipEmpty ?? true)
		const bytes = typeof source === "string" ? source : maybeDecompressSync(normalizeCharacterInput(source), decompress)
		let count = 0

		for (const row of Spliterator.fromSync(bytes, options)) {
			if (dropBlank && isBlank(row)) continue

			count++
		}

		return dropTakeCount(count, drop, take)
	}

	/**
	 * Count logical text rows without decoding them.
	 *
	 * This counts the slices {@linkcode fromAsync} would yield, including a final unterminated row and its `skipEmpty`,
	 * `drop`, and `take` behavior, with the same blank test as {@linkcode count}. A path, URL, or file handle is opened
	 * independently and can then be passed to {@linkcode fromAsync}; an async chunk source is inherently consumed.
	 */
	public static async countAsync(
		source: AsyncDataResource,
		{
			encoding: _encoding,
			fatal: _fatal,
			ignoreBOM: _ignoreBOM,
			trim = true,
			drop = 0,
			take = Infinity,
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

		return dropTakeCount(count, drop, take)
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
		{
			encoding,
			fatal,
			ignoreBOM,
			trim = true,
			drop = 0,
			take = Infinity,
			...options
		}: TextSpliteratorInit & AdaptiveSourceInit = {}
	): AsyncSequence<string> {
		const decoder = new TextDecoder(encoding, { fatal, ignoreBOM })
		// A window decoder keeps every BOM; `stripBOM` then drops one per row, as `decoder` does for a row decoded alone.
		const windowDecoder = new TextDecoder(encoding, { fatal, ignoreBOM: true })
		const skipEmpty = options.skipEmpty ?? true
		const dropBlank = trim && skipEmpty

		const decodeError = (rowIndex: number, cause: unknown) => {
			const error = new SyntaxError(`Failed to decode data at row ${rowIndex}`)
			error.cause = cause

			return error
		}

		// A streamed source is decoded per engine window and split as text (see `windowedTextRows`); the bulk branch's
		// rows are bytes decoded per row below. `drop` and `take` are sequence ops rather than engine options because a
		// window cannot have rows removed from it, and they count the rows the caller receives, after blank rows go.
		const rows = AsyncSequence.from<Uint8Array | string>(async () => {
			const opened = await openDelimitedRows(source, options)

			// The window split is a plain text split, so a quote-aware read keeps the engine's own records.
			return opened instanceof AsyncSpliterator && !options.enableQuoteHandling
				? windowedTextRows(opened, {
						delimiter: new CharacterSequence(options.delimiter),
						crlf: options.crlf ?? false,
						skipEmpty,
						decoder: windowDecoder,
						stripBOM: !ignoreBOM,
						decodeError,
					})
				: opened
		})

		// Decoding is an op on the sequence rather than a generator wrapped inside one. A wrapping generator adds an async frame
		// per row on top of the sequence's own, which measured 297ms against 279ms over 500k rows.
		let decoded = rows.map((row, rowCursor) => {
			if (typeof row === "string") return trim ? row.trim() : row

			try {
				const text = decoder.decode(row)

				return trim ? text.trim() : text
			} catch (parsedError) {
				throw decodeError(rowCursor, parsedError)
			}
		})

		if (dropBlank) {
			decoded = decoded.filter((line) => line.length > 0)
		}

		if (drop > 0) {
			decoded = decoded.drop(drop)
		}

		if (Number.isFinite(take)) {
			decoded = decoded.take(take)
		}

		return decoded
	}
}
