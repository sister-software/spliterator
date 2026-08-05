/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { type AdaptiveSourceInit, openDelimitedRows } from "./adaptive-source.js"
import { AsyncSequence } from "./AsyncSequence.js"
import type { CharacterSequenceInput } from "./CharacterSequence.js"
import type { AsyncDataResource } from "./shared.js"
import { type AsyncSpliteratorInit, Spliterator, type SpliteratorInit } from "./Spliterator.js"

/**
 * Stream a delimited byte source and `JSON.parse` each row — one parsed value per line, for JSONL / NDJSON. Set the row
 * delimiter via `options.delimiter` (there is no implicit default); `skipEmpty` drops blank rows.
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

	static *from<T = unknown>(source: CharacterSequenceInput, options: SpliteratorInit = {}): Generator<T> {
		const decoder = new TextDecoder()
		let rowCursor = 0

		const spliterator = Spliterator.fromSync(source, options)

		for (const row of spliterator) {
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
	static fromAsync<T = unknown>(source: AsyncDataResource, options: AdaptiveSourceInit = {}): AsyncSequence<T> {
		const decoder = new TextDecoder()

		// Parsing is an op on the sequence, not a generator wrapped inside one. An allocating row body makes the extra
		// async frame a wrapping generator adds disproportionately expensive: 1460ms against 1278ms over 500k rows, where
		// the same layer costs a third as much when the body only decodes.
		return AsyncSequence.from<Uint8Array>(() => openDelimitedRows(source, options)).map((row, rowCursor) => {
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
