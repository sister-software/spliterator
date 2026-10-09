/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

import type { AsyncSpliterator } from "#core/AsyncSpliterator"
import { type CharacterSequence, Delimiters } from "#core/CharacterSequence"
import { Spliterator } from "#core/Spliterator"
import { batched, type BatchedAsyncIterable } from "#iterators/AsyncSequence"

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
	const delimiterText = decoder.decode(init.delimiter)
	const delimiterLength = delimiterText.length
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
			let position = 0

			// The window holds whole records with the delimiters between them and none after the last, exactly as the
			// engine cut them: the piece after the last delimiter is the last record, not a partial one.
			while (true) {
				const found = text.indexOf(delimiterText, position)
				let end = found === -1 ? text.length : found

				// A carriage return before a delimiter is part of the delimiter; one at the end of the input is data, and the
				// engine already trimmed the one before the last delimiter it cut.
				if (crlf && found !== -1 && end > position && text.charCodeAt(end - 1) === Delimiters.CarriageReturn) {
					end--
				}

				if (!(skipEmpty && end === position)) {
					rows.push(text.slice(position, end))
				}

				if (found === -1) break

				position = found + delimiterLength
			}

			rowIndex += rows.length

			if (rows.length) {
				yield rows
			}
		}
	} finally {
		await engine.return()
	}
}
