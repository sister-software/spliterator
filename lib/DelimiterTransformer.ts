/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Delimiter, DelimiterInput, takeDelimited } from "./delmiter.js"
import { TypedArray } from "./shared.js"

/**
 * Options for the `DelimiterTransformer` class.
 */
export interface DelimiterTransformerOptions {
	/**
	 * The delimiter to use when splitting fields.
	 *
	 * @default `Delimiter.Comma`
	 */
	delimiter?: DelimiterInput
}

/**
 * A transform stream that splits incoming text into fields using a delimiter.
 *
 * This is useful for parsing CSV files, for example.
 */
export class DelimiterTransformer<T extends TypedArray = TypedArray> extends TransformStream<T, T[]> {
	constructor(options: DelimiterTransformerOptions = {}) {
		const delimiter = Delimiter.from(options.delimiter ?? Delimiter.Comma)

		super({
			transform: (line, controller) => {
				if (line.length === 0) {
					return
				}

				const columns = Array.from(takeDelimited(line, delimiter))

				controller.enqueue(columns as unknown as T[])
			},
		})
	}
}
