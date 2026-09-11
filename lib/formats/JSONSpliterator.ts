/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import type { CharacterSequenceInput } from "../core/CharacterSequence.js"
import { type AsyncSpliteratorInit, Spliterator, type SpliteratorInit } from "../core/Spliterator.js"
import type { AsyncDataResource } from "../internal/shared.js"
import { type AdaptiveSourceInit, openDelimitedRows } from "../io/adaptive-source.js"
import { AsyncSequence } from "../iterators/AsyncSequence.js"
import { type CommentInput, createCommentFilter } from "./comment-filter.js"

export interface JSONSpliteratorInit {
	/**
	 * Line-comment prefixes to skip, e.g. `"//"` or `["//", "#"]`. Rows whose first non-whitespace bytes match a prefix
	 * are dropped before decoding, as are rows that are entirely whitespace.
	 *
	 * Off by default: without it, a comment row reaches `JSON.parse` and throws, which is the right outcome for a plain
	 * JSONL stream. Setting it is how you opt into the fixture-header convention.
	 *
	 * The prefix describes the **start** of a row, not a substring of it — a row carrying `//` inside a string value is
	 * still parsed. Block-comment syntax is not supported; see {@linkcode createCommentFilter} for why.
	 */
	comment?: CommentInput
}

/**
 * Stream a delimited byte source and `JSON.parse` each row — one parsed value per line, for JSONL / NDJSON. The row
 * delimiter defaults to a line feed; override it via `options.delimiter`. `skipEmpty` (on by default) drops blank
 * rows.
 *
 * Sources carrying a comment header — fixture suites, hand-maintained JSONL — can name their prefix with `comment:
 * "//"`, which skips those rows (and whitespace-only ones) on the raw bytes, before any decode or parse. A malformed
 * row still throws; the check is a prefix test rather than a recovery from `JSON.parse`, precisely so that corrupt data
 * cannot be mistaken for a header.
 *
 * **Performance caveat — this path is `JSON.parse`-bound, not scan-bound.** Measured over 500k rows (88MB, ~177B per
 * row, Node 26): the delimiter scan is ~140ms and decoding ~46ms, while `JSON.parse` and the per-row async machinery
 * account for the rest of ~1280ms. Against Node's `readline` + `JSON.parse` at ~630ms, this runs **roughly half the
 * speed — a net loss.** Use it for API convenience, or when streaming to bound memory; do NOT swap a working `readline`
 * loop to it expecting a speedup on parse-heavy JSONL.
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

	static *from<T = unknown>(
		source: CharacterSequenceInput,
		{ comment, ...options }: SpliteratorInit & JSONSpliteratorInit = {}
	): Generator<T> {
		const decoder = new TextDecoder()
		const parseable = createCommentFilter(comment)
		let rowCursor = 0

		const spliterator = Spliterator.fromSync(source, options)

		for (const row of spliterator) {
			if (parseable && !parseable(row)) continue

			let parsed: T

			try {
				const content = decoder.decode(row)

				parsed = JSON.parse(content) as T
			} catch (parsedError) {
				const error = new SyntaxError(`Failed to parse JSON at row ${rowCursor}`)
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
	static fromAsync<T = unknown>(
		source: AsyncDataResource,
		{ comment, ...options }: AdaptiveSourceInit & JSONSpliteratorInit = {}
	): AsyncSequence<T> {
		const decoder = new TextDecoder()
		const parseable = createCommentFilter(comment)

		// Parsing is an op on the sequence, not a generator wrapped inside one. An allocating row body makes the extra
		// async frame a wrapping generator adds disproportionately expensive: 1460ms against 1278ms over 500k rows, where
		// the same layer costs a third as much when the body only decodes.
		const rows = AsyncSequence.from<Uint8Array>(() => openDelimitedRows(source, options))

		// Skipping is a fused op ahead of the parse, not a wrapping generator — the chain runs its ops in one loop, so
		// this costs an extra iteration per row rather than an extra async boundary. When no prefix is configured, no op
		// is added at all and the hot path is unchanged.
		return (parseable ? rows.filter(parseable) : rows).map((row, rowCursor) => {
			try {
				return JSON.parse(decoder.decode(row)) as T
			} catch (parsedError) {
				const error = new SyntaxError(`Failed to parse JSON at row ${rowCursor}`)
				error.cause = parsedError

				throw error
			}
		})
	}
}
