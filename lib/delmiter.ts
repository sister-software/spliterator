/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { TypedArray } from "./shared.js"

/**
 * Type-predicate to determine if a value is an array-like object.
 */
export function isArrayLike<T>(input: unknown): input is ArrayLike<T> {
	return Boolean(input && typeof input === "object" && "length" in input)
}

/**
 * A delimiter used to separate fields in a record.
 */
export type DelimiterBytes = Uint8Array

/**
 * A possible input for a delimiter:
 *
 * - A single character code.
 * - A string of characters.
 * - An array of character codes.
 * - A buffer.
 * - An iterable of character codes.
 */
export type DelimiterInput = number | string | DelimiterBytes | Buffer | Iterable<number>

/**
 * A static class that provides common delimiter values, and methods for normalizing delimiter
 * input.
 */
export class Delimiter {
	/**
	 * Null (␀)
	 */
	static readonly Null = 0

	/**
	 * Newline (␊)
	 */
	static readonly LineFeed = 10

	/**
	 * Carriage return (␍)
	 */
	static readonly CarriageReturn = 13

	/**
	 * Comma (–)
	 */
	static readonly Comma = 44

	/**
	 * Tab (␉)
	 */
	static readonly Tab = 9

	/**
	 * Space (␠)
	 */
	static readonly Space = 32

	/**
	 * One (1)
	 */
	static readonly One = 49

	/**
	 * Zero (0)
	 */
	static readonly Zero = 48

	/**
	 * Double quote (")
	 */
	static readonly DoubleQuote = 34

	/**
	 * Record separator (␞)
	 */
	static readonly RecordSeparator = 30

	/**
	 * Normalize a delimiter input into an array of character codes.
	 */
	static from(input: DelimiterInput): DelimiterBytes {
		switch (typeof input) {
			case "number":
				if (!Number.isInteger(input)) {
					throw new TypeError(`Numeric delimiters must be integers. Received: ${input}`)
				}

				return Uint8Array.from([input])
			case "string":
				return new TextEncoder().encode(input)
			case "object":
				if (isArrayLike(input)) {
					return input
				}

				if (Symbol.iterator in input) {
					return Uint8Array.from(input)
				}

				throw new TypeError(`Invalid delimiter type. Received an object, but it is not an array or buffer.`)

			default:
				throw new TypeError(`Invalid delimiter type. Received: ${input}`)
		}
	}

	static printable(delimiter: DelimiterBytes): string {
		return Array.from(delimiter)
			.map((charCode) => {
				switch (charCode) {
					case Delimiter.LineFeed:
						return "␤"
					case Delimiter.CarriageReturn:
						return "␍"
					case Delimiter.Comma:
						return "-"
					case Delimiter.Tab:
						return "␉"
					case Delimiter.Space:
						return "␠"
					case Delimiter.One:
						return "1"
					case Delimiter.Zero:
						return "0"
					case Delimiter.DoubleQuote:
						return '"'
					case Delimiter.RecordSeparator:
						return "␞"
					case Delimiter.Null:
						return "␀"
					default:
						return String.fromCharCode(charCode)
				}
			})
			.join("")
	}
}

const encoder = new TextEncoder()

/**
 * Given a delimited line, split it into fields using the specified separator.
 *
 * Unlike `String.prototype.split`, this function correctly handles fields that contain the
 * separator character within double quotes.
 *
 * @param source The line to split.
 * @param needle The character that separates fields.
 * @yields Each field in the line.
 */
export function* takeDelimited<T extends TypedArray | string>(source: T, needle: DelimiterBytes = Delimiter.from(",")) {
	const haystack = (typeof source === "string" ? encoder.encode(source) : source) as Exclude<T, string>

	const contentDelimiters: number[] = []
	let doubleQuoteCount = 0

	// First, we traverse the line to find the field delimiters...
	for (let byteIndex = 0; byteIndex < haystack.byteLength; byteIndex++) {
		const byte = haystack[byteIndex]

		if (byte === Delimiter.DoubleQuote) {
			doubleQuoteCount++
		}

		// TODO: handle escaped double quotes
		// TODO: handle delimiters with a length greater than 1
		if (byte === needle[0] && doubleQuoteCount % 2 === 0) {
			contentDelimiters.push(byteIndex)
		}
	}

	// Now, we slice the line into fields.
	let sliceStart = 0

	for (let delimiterIndex = 0; delimiterIndex < contentDelimiters.length; delimiterIndex++) {
		const sliceEnd = contentDelimiters[delimiterIndex]!

		yield haystack.subarray(sliceStart, sliceEnd)
		sliceStart = sliceEnd + 1
	}

	// Finally, our last slice is the remainder of the line.
	yield haystack.subarray(sliceStart)
}
