/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

/**
 * Input ended inside a double-quoted region.
 *
 * A quote-aware reader that reaches the end of its input with a quote still open would otherwise return the rest of the
 * input as one record. The caller then sees a shorter file and cannot tell it from a smaller one, so the reader throws
 * instead. Records before the open quote have already been yielded. `allowUnterminatedQuote: true` restores the
 * permissive reading.
 */
export class UnterminatedQuoteError extends SyntaxError {
	/**
	 * The byte offset, in the decompressed input, of the start of the record holding the open quote.
	 */
	public readonly byteOffset: number

	constructor(byteOffset: number) {
		super(
			`Input ended inside a quoted region opened in the record at byte ${byteOffset}. ` +
				"A quote that never closes swallows every later record; pass `allowUnterminatedQuote: true` to read it anyway."
		)

		this.name = "UnterminatedQuoteError"
		this.byteOffset = byteOffset
	}
}

/**
 * A header row named the same column twice, in a mode that keys rows by column name.
 *
 * Object rows would keep only the last of the repeated columns, which loses data without a trace. Normalize keys
 * (`normalizeKeys: true` suffixes repeats `_2`, `_3`, …) or read the rows as arrays or entries instead.
 */
export class DuplicateHeaderError extends Error {
	/**
	 * The repeated column name.
	 */
	public readonly column: string

	constructor(column: string) {
		super(
			`The header repeats the column "${column}", so object rows would lose one of its values. ` +
				'Pass `normalizeKeys: true` to suffix repeats, or read rows with `mode: "array"` or `mode: "entries"`.'
		)

		this.name = "DuplicateHeaderError"
		this.column = column
	}
}

/**
 * A JSONL row failed to parse. Still a `SyntaxError`, as it was before 10.0.0, with the parser's error as its `cause`.
 */
export class JSONRowError extends SyntaxError {
	/**
	 * The zero-based index of the failing row among the rows that reached the parser: after empty, blank and comment rows
	 * were skipped and after `drop`.
	 */
	public readonly row: number

	constructor(row: number, cause: unknown) {
		super(`Failed to parse JSON at row ${row}`, { cause })

		this.name = "JSONRowError"
		this.row = row
	}
}

/**
 * Throw a {@linkcode DuplicateHeaderError} for the first repeated name in `headers`.
 */
export function assertUniqueHeaders(headers: readonly string[]): void {
	const seen = new Set<string>()

	for (const header of headers) {
		if (seen.has(header)) throw new DuplicateHeaderError(header)

		seen.add(header)
	}
}
