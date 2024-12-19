/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { AsyncDelimitedGeneratorOptions, DelimitedGenerator, DelimitedGeneratorOptions } from "./DelimitedGenerator.js"
import { AsyncDataResource, TypedArray } from "./shared.js"

export interface DelimitedTextGeneratorOptions {
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

export abstract class DelimitedTextGenerator {
	constructor() {
		throw new TypeError("Static class cannot be instantiated. Did you mean `DelimitedTextGenerator.from`?")
	}

	/**
	 * @yields Each row as a string.
	 */
	static *from(
		source: TypedArray | string,
		{ encoding, fatal, ignoreBOM, ...options }: DelimitedTextGeneratorOptions & DelimitedGeneratorOptions = {}
	): Generator<string> {
		const decoder = new TextDecoder(encoding, { fatal, ignoreBOM })
		let rowCursor = 0

		for (const row of DelimitedGenerator.from(source, options)) {
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
		{ encoding, fatal, ignoreBOM, ...options }: DelimitedTextGeneratorOptions & AsyncDelimitedGeneratorOptions = {}
	): AsyncGenerator<string> {
		const decoder = new TextDecoder(encoding, { fatal, ignoreBOM })
		let rowCursor = 0

		for await (const row of DelimitedGenerator.fromAsync(source, options)) {
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
