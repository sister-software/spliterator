/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

const HORIZONTAL_TAB = 0x09
const LINE_FEED = 0x0a
const CARRIAGE_RETURN = 0x0d
const SPACE = 0x20

const encoder = new TextEncoder()

/**
 * One or more line-comment prefixes.
 *
 * Prefixes are **text**, not byte sequences — a `string[]` is always a list of prefixes, never a single prefix given as
 * bytes. That ambiguity is the reason this is narrower than `CharacterSequenceInput`.
 */
export type CommentInput = string | readonly string[]

/**
 * Predicate over a raw, still-encoded row. Returns `false` for rows that should be dropped before decoding.
 */
export type RowPredicate = (row: Uint8Array) => boolean

/**
 * Build a predicate that drops line comments and whitespace-only rows, or `null` when no prefix was configured and the
 * caller should skip the check entirely.
 *
 * The test runs on bytes, before any decode or parse. Measured over 500k rows (~103B each, Node 26, min of 11) against
 * an allocation-free terminal op at 276ns per row: the fused `filter` op costs **10.5ns per row** and this predicate a
 * further **6.8ns**. On the real `JSON.parse` pipeline that is ~1%, and **do not try to confirm it there** —
 * `JSON.parse` allocates enough that GC noise swamps a 17ns signal, and successive end-to-end runs disagreed by ±200ns
 * per row in both directions.
 *
 * Two details earn most of that: the whitespace scan exits on the first byte of any row beginning with `{`, and prefix
 * bytes are encoded once here rather than per row.
 *
 * **Line prefixes only — block-comment syntax is deliberately unsupported.** A block comment needs state carried across
 * rows, which would have to interact with quote handling to avoid treating an opening token inside a string as a
 * comment, and it would break segmentation: `AsyncSpliterator.segments` hands independent byte ranges to workers, and a
 * worker whose range opens inside a block comment has no way to know. A line prefix is self-describing at every row
 * boundary, which is why every JSONL-with-comments convention in the wild is one.
 */
export function createCommentFilter(comment: CommentInput | undefined): RowPredicate | null {
	if (comment === undefined) return null

	// An empty prefix would match every row, so it is dropped rather than honored. Passing `comment`
	// at all still opts into whitespace-only skipping, even if nothing survives here.
	const prefixes = (typeof comment === "string" ? [comment] : comment)
		.map((prefix) => encoder.encode(prefix))
		.filter((prefix) => prefix.length > 0)

	return (row) => {
		const { length } = row
		let cursor = 0

		while (cursor < length) {
			const byte = row[cursor]!

			if (byte !== SPACE && byte !== HORIZONTAL_TAB && byte !== CARRIAGE_RETURN && byte !== LINE_FEED) break

			cursor++
		}

		// Ran off the end while scanning whitespace — the row is blank.
		if (cursor === length) return false

		for (const prefix of prefixes) {
			const prefixLength = prefix.length

			if (cursor + prefixLength > length) continue

			let offset = 0

			while (offset < prefixLength && row[cursor + offset] === prefix[offset]) {
				offset++
			}

			if (offset === prefixLength) return false
		}

		return true
	}
}
