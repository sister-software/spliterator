/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { AsyncDelimitedGeneratorOptions, DelimitedGenerator, DelimitedGeneratorOptions } from "./DelimitedGenerator.js"
import { AsyncDataResource, TypedArray } from "./shared.js"

export abstract class DelimitedJSONGenerator {
	constructor() {
		throw new TypeError("Static class cannot be instantiated. Did you mean `DelimitedJSONGenerator.from`?")
	}

	static *from<T = unknown>(source: TypedArray | string, options: DelimitedGeneratorOptions = {}): Generator<T> {
		const decoder = new TextDecoder()
		let rowCursor = 0

		for (const row of DelimitedGenerator.from(source, options)) {
			let parsed: T

			try {
				const content = decoder.decode(row)

				parsed = JSON.parse(content) as T
			} catch (parsedError) {
				const error = SyntaxError(`Failed to parse JSON at row ${rowCursor}`)
				error.cause = parsedError

				throw error
			}

			yield parsed

			rowCursor++
		}
	}

	/**
	 * Given a byte array or string, yield each row as an array of columns.
	 *
	 * @yields Each row as an array of columns.
	 */
	static async *fromAsync<T = unknown>(source: AsyncDataResource, options: AsyncDelimitedGeneratorOptions = {}) {
		const decoder = new TextDecoder()
		let rowCursor = 0

		for await (const row of DelimitedGenerator.fromAsync(source, options)) {
			let parsed: T

			try {
				const content = decoder.decode(row)

				parsed = JSON.parse(content) as T
			} catch (parsedError) {
				const error = SyntaxError(`Failed to parse JSON at row ${rowCursor}`)
				error.cause = parsedError

				throw error
			}

			yield parsed

			rowCursor++
		}
	}
}
