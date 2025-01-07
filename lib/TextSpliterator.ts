/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { CharacterSequenceInput } from "./CharacterSequence.js"
import { AsyncDataResource } from "./shared.js"
import { AsyncSpliteratorInit, Spliterator, SpliteratorInit } from "./Spliterator.js"

export interface TextSpliteratorInit {
	/**
	 * The encoding to use when decoding the data.
	 *
	 * @default "utf-8"
	 * @see https://developer.mozilla.org/en-US/docs/Web/API/TextDecoder/TextDecoder
	 */
	encoding?: string

	/**
	 * Whether to throw an error when encountering invalid data, or to swap it with a replacement
	 * character.
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
	 * @yields Each row as a string.
	 */
	static *from(
		source: CharacterSequenceInput,
		{ encoding, fatal, ignoreBOM, ...options }: TextSpliteratorInit & SpliteratorInit = {}
	): Generator<string> {
		const decoder = new TextDecoder(encoding, { fatal, ignoreBOM })
		let rowCursor = 0

		const spliterator = Spliterator.from(source, options)

		for (const row of spliterator) {
			let decoded: string

			try {
				decoded = decoder.decode(row)
			} catch (parsedError) {
				const error = SyntaxError(`Failed to decode data at row ${rowCursor}`)
				error.cause = parsedError

				throw error
			}

			yield decoded

			rowCursor++
		}
	}

	/**
	 * Given a byte array or string, yield each row as an array of columns.
	 *
	 * @yields Each row as an array of columns.
	 */
	static async *fromAsync(
		source: AsyncDataResource,
		{ encoding, fatal, ignoreBOM, ...options }: TextSpliteratorInit & AsyncSpliteratorInit = {}
	): AsyncGenerator<string> {
		const decoder = new TextDecoder(encoding, { fatal, ignoreBOM })
		let rowCursor = 0
		const spliterator = await Spliterator.fromAsync(source, options)

		for await (const row of spliterator) {
			let decoded: string

			try {
				decoded = decoder.decode(row)
			} catch (parsedError) {
				const error = SyntaxError(`Failed to decode data at row ${rowCursor}`)
				error.cause = parsedError

				throw error
			}

			yield decoded

			rowCursor++
		}
	}
}
