/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

import type { CharacterSequence } from "#core/CharacterSequence"
import { Spliterator } from "#core/Spliterator"

export const DOUBLE_QUOTE_CODE = 0x22

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
export function unquoteColumn(value: string): string {
	if (
		value.length >= 2 &&
		value.charCodeAt(0) === DOUBLE_QUOTE_CODE &&
		value.charCodeAt(value.length - 1) === DOUBLE_QUOTE_CODE
	) {
		const inner = value.slice(1, -1)

		// Most quoted cells escape nothing, and `replaceAll` costs a scan plus a copy even when it finds nothing. One
		// `indexOf` is the cheaper way to learn that. Measured at 17% of a streamed quoted parse before this check. The
		// cell-scan path does not come here: the kernel flags a doubled quote, so it slices the inside directly.
		return inner.indexOf('""') === -1 ? inner : inner.replaceAll('""', '"')
	}

	return value
}

/**
 * The trim step both column paths apply. Most cells have nothing to trim, and reading the two edge code units is far
 * cheaper than the `trim` call that would find that out. Padding outside the quotes (` " Ada " `) is malformed under
 * RFC 4180 but common: the edge-based unquote could not see the quotes, so unquote what trimming exposed, then trim
 * what was inside.
 */
export function normalizeCell(value: string, enableQuoteHandling: boolean, trim: boolean): string {
	if (!trim) return value

	const length = value.length

	if (length === 0 || (!mayNeedTrim(value.charCodeAt(0)) && !mayNeedTrim(value.charCodeAt(length - 1)))) {
		return value
	}

	let column = value.trim()

	if (enableQuoteHandling && column.charCodeAt(0) === DOUBLE_QUOTE_CODE) {
		column = unquoteColumn(column).trim()
	}

	return column
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
 * Split one decoded row on `delimiter`, honouring double quotes, and unquote each field in the same pass.
 *
 * Callers must establish that `line` contains a quote. {@linkcode splitRowColumns} does so and uses
 * `String.prototype.split` otherwise. A quote-free row cannot have a quoted field, so it needs no unquote pass. The
 * hoisted check lets the caller skip both operations. On a 12-column FCC availability file 96% of rows take that path.
 *
 * Unquoting here rather than over the split result is what keeps a fully quoted file close to the unquoted one: the
 * two-pass form sliced each quoted cell and then sliced it again to drop the quotes, and ran `replaceAll` over every
 * quoted cell to find that it had nothing to unescape. Measured over 1M rows of a six-column, every-cell-quoted file:
 * 344ms two-pass, 243ms fused, against 185ms for `String.prototype.split` on the same rows. The walk notes whether a
 * doubled quote was seen inside the cell and only then pays for `replaceAll`. Must agree with {@linkcode unquoteColumn},
 * which the cell-scan path applies to the same fields.
 */
function splitQuotedString(line: string, delimiter: string): string[] {
	const columns: string[] = []
	const length = line.length
	const delimiterLength = delimiter.length
	let sliceStart = 0
	let index = 0
	let insideQuotes = false
	let sawDoubledQuote = false

	while (index < length) {
		if (line.charCodeAt(index) === DOUBLE_QUOTE_CODE) {
			if (insideQuotes && line.charCodeAt(index + 1) === DOUBLE_QUOTE_CODE) {
				sawDoubledQuote = true
				index += 2

				continue
			}

			insideQuotes = !insideQuotes

			index++
		} else if (!insideQuotes && line.startsWith(delimiter, index)) {
			columns.push(unquoteSlice(line, sliceStart, index, sawDoubledQuote))
			sawDoubledQuote = false
			index += delimiterLength
			sliceStart = index
		} else {
			index++
		}
	}

	columns.push(unquoteSlice(line, sliceStart, length, sawDoubledQuote))

	return columns
}

/**
 * The cell `[start, end)` of `line`, unquoted the way {@linkcode unquoteColumn} would unquote the slice, without first
 * materializing the quoted slice.
 */
function unquoteSlice(line: string, start: number, end: number, sawDoubledQuote: boolean): string {
	if (
		end - start >= 2 &&
		line.charCodeAt(start) === DOUBLE_QUOTE_CODE &&
		line.charCodeAt(end - 1) === DOUBLE_QUOTE_CODE
	) {
		const inner = line.slice(start + 1, end - 1)

		return sawDoubledQuote ? inner.replaceAll('""', '"') : inner
	}

	return line.slice(start, end)
}

/**
 * Split one row's bytes into decoded column strings.
 *
 * Without quote handling this is a plain delimiter scan. With it, a column delimiter inside a double-quoted region does
 * not split, and each field is unquoted/unescaped via {@linkcode decodeColumn}. Empty columns are always preserved. A
 * 30-column row must stay 30 columns regardless of the caller's row-level `skipEmpty`.
 *
 * ## Decode the row once
 *
 * The byte-scan path below decodes per column, and `TextDecoder.decode`'s per-call overhead dominates at column sizes.
 * Measured on a real 12-column, ~110-byte CSV row, 2,000,000 iterations:
 *
 *     scan only, without decoding             370 ns/row
 *     one decode of the whole row              51 ns/row
 *     scan + twelve per-column decodes      1,234 ns/row   <- the old path
 *     one decode + quote-aware string split   307 ns/row   <- this path
 *
 * Twelve small decodes cost 864 ns/row over the scan they sit on. One decode of the same bytes costs 51. The string
 * path is cheaper than decoding per column. It is also cheaper than the byte scan alone because `String`'s split and
 * `startsWith` are intrinsics while the scan runs a generator per row.
 *
 * The SIMD scanner does not apply here either way: it engages at `WASM_THRESHOLD`, and a single row is far below it.
 * Row-level splitting, whose haystack is the whole buffer, is where that path earns its keep. A source that is wholly
 * in memory does not come through here at all by default: `csv-cells.ts` decodes it once and slices cells at the
 * boundaries the kernel emits, and this module is the `columnScan: "rows"` reference it is checked against.
 */
export function splitRowColumns(
	row: Uint8Array,
	columnDelimiter: CharacterSequence,
	decoder: TextDecoder,
	enableQuoteHandling: boolean,
	trim = false
): string[] {
	const columns = splitRowColumnsRaw(row, columnDelimiter, decoder, enableQuoteHandling)

	if (trim) {
		for (let i = 0; i < columns.length; i++) {
			columns[i] = normalizeCell(columns[i]!, enableQuoteHandling, true)
		}
	}

	return columns
}

/**
 * Whether a code unit at a cell's edge could be something `trim` removes: ASCII whitespace, or anything non-ASCII,
 * which is left to `trim` itself to judge.
 */
function mayNeedTrim(code: number): boolean {
	return code <= 0x20 || code >= 0x80
}

function splitRowColumnsRaw(
	row: Uint8Array,
	columnDelimiter: CharacterSequence,
	decoder: TextDecoder,
	enableQuoteHandling: boolean
): string[] {
	const delimiter = delimiterAsString(columnDelimiter)

	if (delimiter !== null) {
		const line = decoder.decode(row)

		// A row without a quote cannot split differently under quote handling and cannot hold a quoted field. Skip both
		// the walk and the unquote pass.
		if (!enableQuoteHandling || line.indexOf('"') === -1) return line.split(delimiter)

		return splitQuotedString(line, delimiter)
	}

	// A delimiter that does not round-trip through UTF-8 keeps the byte scan, through the engine itself: a row is a
	// delimited source like any other, and the quote-aware split is written once, there. This costs ~3µs a row against
	// ~0.3µs for the string path, which is why it is only for a delimiter the string path cannot represent.
	const columns: string[] = []

	for (const column of Spliterator.fromSync(row, {
		delimiter: columnDelimiter,
		enableQuoteHandling,
		skipEmpty: false,
	})) {
		columns.push(decodeColumn(column, decoder, enableQuoteHandling))
	}

	return columns
}
