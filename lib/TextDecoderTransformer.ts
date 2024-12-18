/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import type { TextDecoderOptions } from "node:stream/web"
import { TypedArray } from "./shared.js"

export interface TextDecoderTransformerOptions extends TextDecoderOptions {
	/**
	 * Whether to skip empty chunks of data.
	 *
	 * @default true
	 */
	skipEmpty?: boolean
}

/**
 * A transform stream that decodes incoming text using a `TextDecoder`.
 *
 * Note that unlike
 * {@linkcode https://developer.mozilla.org/en-US/docs/Web/API/TextDecoderStream/TextDecoderStream TextDecoderStream},
 * this class operates synchronously on each chunk of data.
 */
export class TextDecoderTransformer<DataSource extends TypedArray = TypedArray> extends TransformStream<
	DataSource,
	string
> {
	constructor(
		/**
		 * The label of the encoding to use when decoding the incoming text.
		 *
		 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/Encoding_API/Encodings | Encoding API}
		 */
		label = "utf-8",
		/**
		 * Options for the `TextDecoder` constructor.
		 */
		options: TextDecoderTransformerOptions = {}
	) {
		const decoder = new TextDecoder(label, options)

		super({
			transform: (line, controller) => {
				if (!line) {
					controller.enqueue("")
					return
				}

				const decoded = decoder.decode(line)

				controller.enqueue(decoded)
			},
		})
	}
}

/**
 * A transform stream that decodes incoming arrays of text using a `TextDecoder`.
 *
 * Note that unlike
 * {@linkcode https://developer.mozilla.org/en-US/docs/Web/API/TextDecoderStream/TextDecoderStream TextDecoderStream},
 * this class operates synchronously on each chunk of data.
 */
export class DelimitedTextDecoderTransformer<DataSource extends Uint8Array[] = Uint8Array[]> extends TransformStream<
	DataSource,
	string[]
> {
	constructor(
		/**
		 * The label of the encoding to use when decoding the incoming text.
		 *
		 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/Encoding_API/Encodings | Encoding API}
		 */
		label = "utf-8",
		/**
		 * Options for the `TextDecoder` constructor.
		 */
		options: TextDecoderTransformerOptions = {}
	) {
		const decoder = new TextDecoder(label, options)

		super({
			transform: (lines, controller) => {
				const decoded = Array.from(lines, (line) => decoder.decode(line))

				controller.enqueue(decoded)
			},
		})
	}
}
