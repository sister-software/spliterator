/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { CharacterSequenceInput } from "./CharacterSequence.js"
import { AsyncDataResource } from "./shared.js"
import { AsyncSpliteratorInit, Spliterator, SpliteratorInit } from "./Spliterator.js"

export abstract class JSONSpliterator {
	constructor() {
		throw new TypeError("Static class cannot be instantiated. Did you mean `JSONSpliterator.from`?")
	}

	static *from<T = unknown>(source: CharacterSequenceInput, options: SpliteratorInit = {}): Generator<T> {
		const decoder = new TextDecoder()
		let rowCursor = 0

		const spliterator = Spliterator.from(source, options)

		for (const row of spliterator) {
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
	static async *fromAsync<T = unknown>(source: AsyncDataResource, options: AsyncSpliteratorInit = {}) {
		const decoder = new TextDecoder()
		let rowCursor = 0
		const spliterator = await Spliterator.from(source, options)

		for await (const row of spliterator) {
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
