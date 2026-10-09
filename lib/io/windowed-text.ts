/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

import type { AsyncSpliterator } from "#core/AsyncSpliterator"
import { CharacterSequence, Delimiters } from "#core/CharacterSequence"
import { Spliterator, type SpliteratorInit } from "#core/Spliterator"
import { batched, type BatchedAsyncIterable } from "#iterators/AsyncSequence"

/**
 * Split `text` on `delimiter` into `rows`, the way the byte engine would have cut the encoded bytes: a carriage return
 * before a delimiter goes with the delimiter when `crlf` is on, one at the end of the text is data, and the piece after
 * the last delimiter is a row even when empty unless `skipEmpty` drops it, matching `String.prototype.split`.
 *
 * Returns the number of rows pushed. Shared by the streaming window path and the string fast path of the text and JSON
 * spliterators.
 */
export function splitTextRows(
	text: string,
	delimiter: string,
	crlf: boolean,
	skipEmpty: boolean,
	rows: string[],
	limit = Infinity
): number {
	const delimiterLength = delimiter.length
	const before = rows.length
	let position = 0

	while (rows.length - before < limit) {
		const found = text.indexOf(delimiter, position)
		let end = found === -1 ? text.length : found

		if (crlf && found !== -1 && end > position && text.charCodeAt(end - 1) === Delimiters.CarriageReturn) {
			end--
		}

		if (!(skipEmpty && end === position)) {
			rows.push(text.slice(position, end))
		}

		if (found === -1) break

		position = found + delimiterLength
	}

	return rows.length - before
}

/**
 * Whether a string source can be split as text rather than encoded, scanned as bytes and decoded per row: no byte
 * `position` to honour, no quote handling, and no encoding other than UTF-8 asked for (a string is already text).
 */
export function canSplitAsText(init: SpliteratorInit & { encoding?: string }): boolean {
	return !init.position && !init.enableQuoteHandling && (init.encoding === undefined || /^utf-?8$/i.test(init.encoding))
}

const sharedDecoder = new TextDecoder()

/**
 * The delimiter as text. `delimiter` is whatever the caller gave the engine: a string, bytes, or nothing for a newline.
 */
export function delimiterText(delimiter: SpliteratorInit["delimiter"]): string {
	if (delimiter === undefined) return "\n"

	return typeof delimiter === "string" ? delimiter : sharedDecoder.decode(new CharacterSequence(delimiter))
}

/**
 * Every row of a string source, split as text. Measured against the byte route (encode, scan, decode per row) on a
 * 40-line string: 7.8µs → see `TextSpliterator.from`. The whole string is split before the first row is yielded, which
 * for the in-memory strings this serves (a command's output, a file read whole) is the cheap part. `drop` and `take`
 * count after `skipEmpty`, as the engine's do.
 */
export function* textRows(text: string, init: SpliteratorInit): Generator<string> {
	const rows: string[] = []
	const drop = Math.max(0, init.drop ?? 0)
	const take = Math.max(0, init.take ?? Infinity)

	splitTextRows(text, delimiterText(init.delimiter), init.crlf ?? false, init.skipEmpty ?? true, rows, drop + take)

	for (let index = drop; index < rows.length; index++) {
		yield rows[index]!
	}
}

export interface WindowedTextInit {
	/**
	 * The delimiter as the engine was given it. Decoded once with `decoder` so the window's text splits on the same
	 * characters the engine split its bytes on.
	 */
	delimiter: CharacterSequence
	crlf: boolean
	skipEmpty: boolean
	decoder: TextDecoder
	/**
	 * Called with the row index of a window that failed to decode, after the rows before it were handed out. The row
	 * path's decode error names a row, so the window path finds which one by decoding that window row by row.
	 */
	decodeError: (rowIndex: number, cause: unknown) => Error
}

/**
 * Decode a streaming source one engine window at a time and split the text into rows, handed out as batches.
 *
 * The per-row path decodes each row's bytes on its own: a `TextDecoder.decode` call per row, which has a fixed cost of
 * a few hundred nanoseconds in Node, plus an `await` per row through the sequence. One decode per window (a high-water
 * mark of rows) and one `await` per window replaces both, and the rows come out as slices of the window's text.
 * Measured on a 120MB JSONL file of 600k rows: `JSONSpliterator.fromAsync` 1289ms per row against 584ms through a
 * window, with `readline` + `JSON.parse` at 783ms. The same split as the CSV cell scanner's streaming path, without the
 * kernel.
 *
 * The engine's `skipEmpty`, `drop` and `take` do not apply to windows, so `skipEmpty` is applied here and the caller
 * applies `drop` and `take` as sequence ops. A window that fails to decode (a `fatal` decoder) is decoded row by row so
 * the error can name the row, as the per-row path's would have.
 *
 * `return()` on the iterable closes the engine.
 */
export function windowedTextRows(engine: AsyncSpliterator, init: WindowedTextInit): BatchedAsyncIterable<string> {
	return batched(windows(engine, init))
}

async function* windows(engine: AsyncSpliterator, init: WindowedTextInit): AsyncGenerator<string[]> {
	const { crlf, skipEmpty, decoder } = init
	const delimiter = decoder.decode(init.delimiter)
	let rowIndex = 0

	try {
		while (true) {
			const result = await engine.nextWindow()

			if (result.done) return

			const window = result.value
			let text: string

			try {
				text = decoder.decode(window)
			} catch {
				// Find the row: decode the window the way the row path would have, so the error names the same row.
				const rows: string[] = []

				for (const row of Spliterator.fromSync(window, { delimiter: init.delimiter, crlf, skipEmpty })) {
					try {
						rows.push(decoder.decode(row))
					} catch (error) {
						throw init.decodeError(rowIndex + rows.length, error)
					}
				}

				rowIndex += rows.length

				yield rows

				continue
			}

			const rows: string[] = []

			// The window holds whole records with the delimiters between them and none after the last, exactly as the
			// engine cut them: the piece after the last delimiter is the last record, not a partial one, and the engine
			// already trimmed the carriage return before the last delimiter it cut.
			rowIndex += splitTextRows(text, delimiter, crlf, skipEmpty, rows)

			if (rows.length) {
				yield rows
			}
		}
	} finally {
		await engine.return()
	}
}
