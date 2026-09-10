/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { CharacterSequence } from "../core/CharacterSequence.js"

const doubleQuoteSequence = new CharacterSequence('"')
const DOUBLE_QUOTE_CODE = 0x22

/**
 * Decode a single column, stripping wrapping quotes and unescaping doubled quotes (`""` → `"`) when quote handling is
 * on. The unescape allocates only when the field was actually quoted.
 */
function decodeColumn(bytes: Uint8Array, decoder: TextDecoder, enableQuoteHandling: boolean): string {
	const value = decoder.decode(bytes)

	return enableQuoteHandling ? unquoteColumn(value) : value
}

/**
 * Strip wrapping quotes and unescape doubled quotes (`""` → `"`). Allocates only when the field was actually quoted.
 *
 * Shared by both split paths rather than transcribed into each — the two must agree on what a quoted field means, and a
 * constant they both reference would not have proved that.
 */
function unquoteColumn(value: string): string {
	if (value.length >= 2 && value.charCodeAt(0) === DOUBLE_QUOTE_CODE && value.endsWith('"')) {
		return value.slice(1, -1).replaceAll('""', '"')
	}

	return value
}

/**
 * The column delimiter as a string, when it survives a byte→string→byte round trip.
 *
 * `null` for a delimiter that does not — a lone `0xFF`, a truncated multi-byte sequence — because `TextDecoder` maps
 * those to U+FFFD and a string search would then match the replacement character instead of the delimiter. Those
 * delimiters keep the byte scan below. Cached on the sequence: deriving it costs a decode plus an encode, which is
 * per-row work if recomputed and per-parse work if not.
 */
const delimiterStringCache = new WeakMap<CharacterSequence, string | null>()

function delimiterAsString(columnDelimiter: CharacterSequence): string | null {
	const cached = delimiterStringCache.get(columnDelimiter)

	if (cached !== undefined) return cached

	const decoded = new TextDecoder().decode(columnDelimiter)
	const reencoded = new TextEncoder().encode(decoded)

	const lossless =
		reencoded.length === columnDelimiter.length && reencoded.every((byte, i) => byte === columnDelimiter[i])

	const value = lossless ? decoded : null

	delimiterStringCache.set(columnDelimiter, value)

	return value
}

/**
 * Split one decoded row on `delimiter`, honouring double quotes.
 *
 * Callers MUST have established that `line` contains a quote — {@linkcode splitRowColumns} does, and takes
 * `String.prototype.split` when it does not. That split is not merely the cheaper branch: a quote-free row also cannot
 * have a quoted field, so it needs no unquote pass either, and hoisting the check lets the caller skip both. On a
 * 12-column FCC availability file 96% of rows take that path.
 */
function splitQuotedString(line: string, delimiter: string): string[] {
	const columns: string[] = []
	let sliceStart = 0
	let index = 0
	let insideQuotes = false

	while (index < line.length) {
		if (line.charCodeAt(index) === DOUBLE_QUOTE_CODE) {
			insideQuotes = !insideQuotes

			index++
		} else if (!insideQuotes && line.startsWith(delimiter, index)) {
			columns.push(line.slice(sliceStart, index))
			index += delimiter.length
			sliceStart = index
		} else {
			index++
		}
	}

	columns.push(line.slice(sliceStart))

	return columns
}

/**
 * Split one row's bytes into decoded column strings.
 *
 * Without quote handling this is a plain delimiter scan. With it, a column delimiter inside a double-quoted region does
 * not split, and each field is unquoted/unescaped via {@linkcode decodeColumn}. Empty columns are always preserved — a
 * 30-column row must stay 30 columns regardless of the caller's row-level `skipEmpty`.
 *
 * ## Decode the row ONCE
 *
 * The byte-scan path below decodes per COLUMN, and `TextDecoder.decode`'s per-call overhead dominates at column sizes.
 * Measured on a real 12-column, ~110-byte CSV row, 2,000,000 iterations:
 *
 *     scan only, no decode                    370 ns/row
 *     one decode of the whole row              51 ns/row
 *     scan + twelve per-column decodes      1,234 ns/row   <- the old path
 *     one decode + quote-aware string split   307 ns/row   <- this path
 *
 * Twelve small decodes cost 864 ns/row over the scan they sit on; one decode of the same bytes costs 51. So the string
 * path is not merely cheaper than decoding per column — it is cheaper than the byte scan alone, because `String`'s
 * split and `startsWith` are intrinsics while the scan runs a generator per row.
 *
 * The SIMD scanner does not apply here either way: it engages at `WASM_THRESHOLD`, and a single row is far below it.
 * Row-level splitting, whose haystack is the whole buffer, is where that path earns its keep.
 */
export function splitRowColumns(
	row: Uint8Array,
	columnDelimiter: CharacterSequence,
	decoder: TextDecoder,
	enableQuoteHandling: boolean
): string[] {
	const delimiter = delimiterAsString(columnDelimiter)

	if (delimiter !== null) {
		const line = decoder.decode(row)

		// A row with no quote in it cannot split differently under quote handling, and cannot hold a quoted field
		// either — so BOTH the walk and the unquote pass are skipped, not just the walk.
		if (!enableQuoteHandling || line.indexOf('"') === -1) return line.split(delimiter)

		const columns = splitQuotedString(line, delimiter)

		for (let i = 0; i < columns.length; i++) {
			columns[i] = unquoteColumn(columns[i]!)
		}

		return columns
	}

	// A delimiter that does not round-trip through UTF-8 keeps the byte scan.
	if (!enableQuoteHandling) {
		return columnDelimiter.searchAll(row).map(([start, end]) => decoder.decode(row.subarray(start, end)))
	}

	const columns: string[] = []
	let sliceStart = 0
	let insideQuotes = false

	for (const match of columnDelimiter.searchMatches(row, doubleQuoteSequence)) {
		if (match.patternId === 1) {
			insideQuotes = !insideQuotes

			continue
		}

		if (insideQuotes) continue

		columns.push(decodeColumn(row.subarray(sliceStart, match.offset), decoder, enableQuoteHandling))
		sliceStart = match.offset + columnDelimiter.length
	}

	columns.push(decodeColumn(row.subarray(sliceStart), decoder, enableQuoteHandling))

	return columns
}
