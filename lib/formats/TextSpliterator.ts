/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import type { CharacterSequenceInput } from "../core/CharacterSequence.js"
import { type AsyncSpliteratorInit, Spliterator, type SpliteratorInit } from "../core/Spliterator.js"
import type { AsyncDataResource } from "../internal/shared.js"
import { type AdaptiveSourceInit, openDelimitedRows } from "../io/adaptive-source.js"
import { AsyncSequence } from "../iterators/AsyncSequence.js"

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
	public static *from(
		source: CharacterSequenceInput,
		{ encoding, fatal, ignoreBOM, ...options }: TextSpliteratorInit & SpliteratorInit = {}
	): Generator<string> {
		const decoder = new TextDecoder(encoding, { fatal, ignoreBOM })
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

			yield decoded

			rowCursor++
		}
	}

	/**
	 * Count logical text rows without decoding them.
	 *
	 * This counts exactly the slices {@linkcode from} would yield, including a final unterminated row and its `skipEmpty`,
	 * `drop`, and `take` behavior.
	 *
	 * @see {@linkcode countAsync} for files and other asynchronous sources.
	 */
	public static count(source: CharacterSequenceInput, init: TextSpliteratorInit & SpliteratorInit = {}): number {
		const { encoding: _encoding, fatal: _fatal, ignoreBOM: _ignoreBOM, ...options } = init
		let count = 0

		for (const _row of Spliterator.fromSync(source, options)) {
			count++
		}

		return count
	}

	/**
	 * Count logical text rows without decoding them.
	 *
	 * This counts exactly the slices {@linkcode fromAsync} would yield, including a final unterminated row and its
	 * `skipEmpty`, `drop`, and `take` behavior. A path, URL, or file handle is opened independently and can then be
	 * passed to {@linkcode fromAsync}; an async chunk source is inherently consumed.
	 */
	public static async countAsync(
		source: AsyncDataResource,
		{
			encoding: _encoding,
			fatal: _fatal,
			ignoreBOM: _ignoreBOM,
			...options
		}: TextSpliteratorInit & AdaptiveSourceInit = {}
	): Promise<number> {
		const rows = await openDelimitedRows(source, options)
		let count = 0

		for await (const _row of rows) {
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
		{ encoding, fatal, ignoreBOM, ...options }: TextSpliteratorInit & AdaptiveSourceInit = {}
	): AsyncSequence<string> {
		const decoder = new TextDecoder(encoding, { fatal, ignoreBOM })

		// Decoding is an op on the sequence, not a generator wrapped inside one. A wrapping generator adds an async frame
		// per row on top of the sequence's own, which measured 297ms against 279ms over 500k rows.
		return AsyncSequence.from<Uint8Array>(() => openDelimitedRows(source, options)).map((row, rowCursor) => {
			try {
				return decoder.decode(row)
			} catch (parsedError) {
				const error = new SyntaxError(`Failed to decode data at row ${rowCursor}`)
				error.cause = parsedError

				throw error
			}
		})
	}
}
