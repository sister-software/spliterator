/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { type AdaptiveSourceInit, openDelimitedRows } from "./adaptive-source.js"
import { AsyncSequence } from "./AsyncSequence.js"
import type { CharacterSequenceInput } from "./CharacterSequence.js"
import type { AsyncDataResource } from "./shared.js"
import { type AsyncSpliteratorInit, Spliterator, type SpliteratorInit } from "./Spliterator.js"

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
	static *from(
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
	 * Asynchronously yield delimited text from a byte array or string.
	 *
	 * @param source The async data resource to split.
	 * @param options The options to use when splitting the content.
	 *
	 * @yields Each slice of the source content.
	 * @see {@linkcode TextSpliterator.from} for synchronous iteration with decoding.
	 * @see {@linkcode Spliterator.fromAsync} for asynchronous iteration without decoding.
	 */
	static fromAsync(
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
