/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import type { CharacterSequenceInput } from "./CharacterSequence.js"
import type { AsyncDataResource } from "./shared.js"
import { type AsyncSpliteratorInit, Spliterator, type SpliteratorInit } from "./Spliterator.js"

/**
 * Stream a delimited byte source and `JSON.parse` each row — one parsed value per line, for JSONL / NDJSON. Set the row
 * delimiter via `options.delimiter` (there is no implicit default); `skipEmpty` drops blank rows.
 *
 * **Performance caveat — this path is `JSON.parse`-bound, not scan-bound.** The underlying SIMD newline scan is
 * genuinely fast (scan-only measures ~1.75× a JS line-splitter on large files), but a full `JSON.parse` per row dwarfs
 * the scan, so end-to-end this typically runs **~0.75× of Node's `readline` + `JSON.parse` — a net loss** — because the
 * per-row decode + parse dominates and `readline`'s line emission is already well-tuned. Use this for API convenience,
 * or when streaming to bound memory; do NOT swap a working `readline` loop to it expecting a speedup on parse-heavy
 * JSONL. The scan advantage only shows when you _don't_ fully parse every row (segmentation, counting, extracting a
 * couple of fields) — use {@link Spliterator} (raw byte ranges) or {@link TextSpliterator} for those. When unsure,
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
				const error = SyntaxError(`Failed to parse JSON at row ${rowCursor}`)
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
	static async *fromAsync<T = unknown>(source: AsyncDataResource, options: AsyncSpliteratorInit = {}) {
		const decoder = new TextDecoder()
		let rowCursor = 0
		const spliterator = await Spliterator.from(source, options)

		for await (const row of spliterator) {
			let parsed: T

			try {
				const content = decoder.decode(row)

				parsed = JSON.parse(content) as T
			} catch (parsedError) {
				const error = SyntaxError(`Failed to parse JSON at row ${rowCursor}`)
				error.cause = parsedError

				throw error
			}

			yield parsed

			rowCursor++
		}
	}
}
