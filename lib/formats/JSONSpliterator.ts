/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

import { AsyncSpliterator } from "#core/AsyncSpliterator"
import { CharacterSequence, type CharacterSequenceInput, normalizeCharacterInput } from "#core/CharacterSequence"
import { JSONRowError } from "#core/errors"
import { Spliterator, type SpliteratorInit } from "#core/Spliterator"
import { type CommentInput, createCommentFilter, createTextCommentFilter } from "#formats/comment-filter"
import type { AsyncDataResource } from "#internal/shared"
import { type AdaptiveSourceInit, openDelimitedRows } from "#io/adaptive-source"
import { maybeDecompressSync } from "#io/compression"
import { canSplitAsText, isBlankText, textRows, windowedTextRows } from "#io/windowed-text"
import { AsyncSequence } from "#iterators/AsyncSequence"
import { Sequence } from "#iterators/Sequence"

export interface JSONSpliteratorInit {
	/**
	 * Line-comment prefixes to skip, e.g. `"//"` or `["//", "#"]`. Rows whose first non-whitespace bytes match a prefix
	 * are dropped before decoding, as are rows that are entirely whitespace.
	 *
	 * Off by default. A comment row then reaches `JSON.parse` and throws, which is the right outcome for a plain JSONL
	 * stream. Setting it is how you opt into the fixture-header convention.
	 *
	 * The prefix describes the **start** of a row rather than a substring of it. A row carrying `//` inside a string
	 * value is still parsed. Block-comment syntax is unsupported. See {@linkcode createCommentFilter} for the reason.
	 */
	comment?: CommentInput
}

function parseError(rowCursor: number, cause: unknown): JSONRowError {
	return new JSONRowError(rowCursor, cause)
}

/**
 * The row generator behind {@linkcode JSONSpliterator.from}, kept at module scope so `from` can hand it to a
 * {@linkcode Sequence} while staying lazy — calling a generator function runs none of its body.
 *
 * A row is skipped, in order, for being a comment, then for being blank (with `skipEmpty`), and `drop` and `take` count
 * what is left. The error's row index counts the rows that reached `JSON.parse`.
 */
function* parseRows<T>(
	source: CharacterSequenceInput,
	{
		comment,
		drop: dropInput = 0,
		take: takeInput = Infinity,
		decompress = true,
		...options
	}: SpliteratorInit & JSONSpliteratorInit = {}
): Generator<T> {
	const skipBlank = options.skipEmpty ?? true
	const drop = Math.max(0, dropInput)
	const take = Math.max(0, takeInput)
	let skipped = 0
	let rowCursor = 0

	if (take <= 0) return

	// A string is already text: split it as text rather than encoding, scanning and decoding each row back.
	if (typeof source === "string" && canSplitAsText(options)) {
		const parseableText = createTextCommentFilter(comment)

		for (const row of textRows(source, options, true)) {
			if (parseableText && !parseableText(row)) continue

			if (skipBlank && isBlankText(row)) continue

			if (skipped < drop) {
				skipped++

				continue
			}

			let parsed: T

			try {
				parsed = JSON.parse(row) as T
			} catch (parsedError) {
				throw parseError(rowCursor, parsedError)
			}

			yield parsed

			if (++rowCursor >= take) return
		}

		return
	}

	const decoder = new TextDecoder()
	const parseable = createCommentFilter(comment)
	const bytes = typeof source === "string" ? source : maybeDecompressSync(normalizeCharacterInput(source), decompress)

	for (const row of Spliterator.fromSync(bytes, options)) {
		if (parseable && !parseable(row)) continue

		const content = decoder.decode(row)

		if (skipBlank && isBlankText(content)) continue

		if (skipped < drop) {
			skipped++

			continue
		}

		let parsed: T

		try {
			parsed = JSON.parse(content) as T
		} catch (parsedError) {
			throw parseError(rowCursor, parsedError)
		}

		yield parsed

		if (++rowCursor >= take) return
	}
}

/**
 * Stream a delimited byte source and apply `JSON.parse` to each row. This produces one parsed value per line for JSONL
 * and NDJSON. The row delimiter defaults to a line feed. Override it via `options.delimiter`. `skipEmpty` (on by
 * default) drops blank rows.
 *
 * Sources carrying a comment header — fixture suites, hand-maintained JSONL — can name their prefix with `comment:
 * "//"`, which skips those rows (and whitespace-only ones) on the raw bytes, before any decode or parse. A malformed
 * row still throws. The check is a prefix test rather than a recovery from `JSON.parse`, so corrupt data cannot be
 * mistaken for a header.
 *
 * **Performance.** This path is `JSON.parse`-bound rather than scan-bound, so it runs about even with Node's `readline`
 * plus `JSON.parse` rather than ahead of it. A streamed source is decoded per engine window and split as text
 * (`windowedTextRows`), one decode and one `await` per high-water mark of rows instead of one of each per row: measured
 * on 600k rows of 120MB (Node 26), 1289ms per row against 707ms windowed, with `readline` + `JSON.parse` at 702ms; on a
 * 500MB corpus file of 1.27M rows, 1948ms against `readline`'s 2092ms. Reach for it for the API and the bounded
 * footprint, not for a speedup on parse-heavy JSONL.
 *
 * The scan advantage only shows when you _don't_ fully parse every row. Filtering on the raw text and parsing only what
 * survives is the shape that wins — parsing 20% of rows measured ~2.5× faster than parsing all of them:
 *
 * ```ts
 * TextSpliterator.fromAsync(path, { delimiter: "\n" })
 * 	.filter((line) => line.includes('"category":"Novelty"'))
 * 	.map((line) => JSON.parse(line))
 * ```
 *
 * For segmentation or counting, use {@link Spliterator} (raw byte ranges) or {@link TextSpliterator}. When unsure,
 * benchmark.
 */
export abstract class JSONSpliterator {
	constructor() {
		throw new TypeError("Static class cannot be instantiated. Did you mean `JSONSpliterator.from`?")
	}

	public static from<T = unknown>(
		source: CharacterSequenceInput,
		init: SpliteratorInit & JSONSpliteratorInit = {}
	): Sequence<T> {
		return new Sequence(parseRows<T>(source, init))
	}

	/**
	 * Given an asynchronous data source, yield each delimited row parsed as JSON.
	 *
	 * @yields Each row's parsed value.
	 */
	public static fromAsync<T = unknown>(
		source: AsyncDataResource,
		{ comment, drop = 0, take = Infinity, ...options }: AdaptiveSourceInit & JSONSpliteratorInit = {}
	): AsyncSequence<T> {
		const decoder = new TextDecoder()
		// A window decoder keeps every BOM; `stripBOM` then drops one per row, as `decoder` does for a row decoded alone.
		const windowDecoder = new TextDecoder("utf-8", { ignoreBOM: true })
		const parseableBytes = createCommentFilter(comment)
		const parseableText = createTextCommentFilter(comment)
		const skipBlank = options.skipEmpty ?? true

		// A streamed source is decoded per engine window and split as text (see `windowedTextRows`), which is where this
		// path stopped losing to `readline`: 1289ms → 707ms over 600k rows, `readline` + `JSON.parse` at 702ms. The bulk
		// branch's rows are bytes decoded per row below. `drop` and `take` are sequence ops rather than engine options
		// because a window cannot have rows removed from it, and they count the rows left after comment and blank rows go.
		let rows = AsyncSequence.from<Uint8Array | string>(async () => {
			const opened = await openDelimitedRows(source, options)

			// The window split is a plain text split, so a quote-aware read keeps the engine's own records.
			return opened instanceof AsyncSpliterator && !options.enableQuoteHandling
				? windowedTextRows(opened, {
						delimiter: new CharacterSequence(options.delimiter),
						crlf: options.crlf ?? false,
						skipEmpty: options.skipEmpty ?? true,
						decoder: windowDecoder,
						stripBOM: true,
						decodeError: (rowIndex, cause) => {
							const error = new SyntaxError(`Failed to decode data at row ${rowIndex}`)
							error.cause = cause

							return error
						},
					})
				: opened
		})

		// Skipping is a fused op ahead of the parse. The chain runs its ops in one loop, so
		// this costs an extra iteration per row rather than an extra async boundary. When no prefix is configured, the
		// chain adds no operation and the hot path is unchanged.
		if (parseableBytes && parseableText) {
			rows = rows.filter((row) => (typeof row === "string" ? parseableText(row) : parseableBytes(row)))
		}

		let texts = rows.map((row) => (typeof row === "string" ? row : decoder.decode(row)))

		if (skipBlank) {
			texts = texts.filter((row) => !isBlankText(row))
		}

		if (drop > 0) {
			texts = texts.drop(drop)
		}

		if (Number.isFinite(take)) {
			texts = texts.take(take)
		}

		// Parsing is an op on the sequence rather than a generator wrapped inside one. An allocating row body makes the extra
		// async frame a wrapping generator adds disproportionately expensive: 1460ms against 1278ms over 500k rows, where
		// the same layer costs a third as much when the body only decodes.
		return texts.map((row, rowCursor) => {
			try {
				return JSON.parse(row) as T
			} catch (parsedError) {
				throw parseError(rowCursor, parsedError)
			}
		})
	}
}
