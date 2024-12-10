/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { smartSnakeCase } from "./casing.js"
import { Delimiter } from "./common.js"

/**
 * Given a delimited line, split it into fields using the specified separator.
 *
 * Unlike `String.prototype.split`, this function correctly handles fields that contain the
 * separator character within double quotes.
 *
 * @param delimitedLine The line to split.
 * @param separatorCharacter The character that separates fields.
 * @yields Each field in the line.
 */
export function* takeDelimited(
	delimitedLine: Buffer | string,
	separatorCharacter: number = Delimiter.Comma
): Iterable<Buffer> {
	if (typeof delimitedLine === "string") {
		delimitedLine = Buffer.from(delimitedLine)
	}

	const contentDelimiters: number[] = []
	let doubleQuoteCount = 0

	// First, we traverse the line to find the field delimiters...
	for (let byteIndex = 0; byteIndex < delimitedLine.byteLength; byteIndex++) {
		const byte = delimitedLine[byteIndex]

		if (byte === Delimiter.DoubleQuote) {
			doubleQuoteCount++
		}

		if (byte === separatorCharacter && doubleQuoteCount % 2 === 0) {
			contentDelimiters.push(byteIndex)
		}
	}

	// Now, we slice the line into fields.
	let sliceStart = 0

	for (let delimiterIndex = 0; delimiterIndex < contentDelimiters.length; delimiterIndex++) {
		const sliceEnd = contentDelimiters[delimiterIndex]!

		yield delimitedLine.subarray(sliceStart, sliceEnd)

		sliceStart = sliceEnd + 1
	}

	// Finally, our last slice is the remainder of the line.
	yield delimitedLine.subarray(sliceStart)
}

/**
 * Options for the `DelimiterTransformer` class.
 */
export interface DelimiterTransformerOptions {
	delimiter?: Delimiter
}

/**
 * A transform stream that splits incoming text into fields using a delimiter.
 *
 * This is useful for parsing CSV files, for example.
 */
export class DelimiterTransformer<
	I extends Buffer | string = Buffer | string,
	O extends Iterable<string> = Array<string>,
> extends TransformStream<I, O> {
	constructor({ delimiter = Delimiter.Comma }: DelimiterTransformerOptions = {}) {
		super({
			transform: (line, controller) => {
				if (line.length === 0) {
					return
				}

				const columns = Array.from(takeDelimited(line, delimiter), (column) => column.toString())

				controller.enqueue(columns as unknown as O)
			},
		})
	}
}

/**
 * Given an array of column names, normalize them to ensure they are unique and usable as object
 * keys.
 */
export function normalizeColumnNames(columnHeaders: Iterable<string>): string[] {
	const columnInputCountMap = new Map<string, number>()
	const distinctColumns = new Set<string>()
	const keyableColumnNames = Iterator.from(columnHeaders).map(smartSnakeCase)

	for (const columnHeader of keyableColumnNames) {
		if (distinctColumns.has(columnHeader)) {
			const headerCount = (columnInputCountMap.get(columnHeader) ?? 1) + 1
			columnInputCountMap.set(columnHeader, headerCount)

			const uniqueColumnName = `${columnHeader}_${headerCount}`
			distinctColumns.add(uniqueColumnName)
		} else {
			distinctColumns.add(columnHeader)
		}
	}

	return Array.from(distinctColumns)
}
