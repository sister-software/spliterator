/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import type { CamelCase, SnakeCase } from "type-fest"

/**
 * Any character that is not a letter, a digit, or an underscore in any script.
 *
 * `\W` cannot serve here: it is `[^A-Za-z0-9_]` in JavaScript, with or without the `u` flag, so every character of a
 * non-Latin header is "non-word". A Korean CSV header (`영업상태명`) collapsed to a single `_`, and a file of them became
 * `_`, `__2`, `__3` … once `normalizeColumnNames` de-duplicated the collisions — the header was not renamed, it was
 * destroyed, and every value became unreachable by name.
 */
const NON_KEY_CHARACTER = /[^\p{L}\p{N}_]+/gu

// These are the word-boundary rules. The separator is a NUL
// because it cannot be a word character matched by the stripping expression.
const SPLIT_LOWER_UPPER = /([\p{Ll}\d])(\p{Lu})/gu
const SPLIT_UPPER_UPPER = /(\p{Lu})([\p{Lu}][\p{Ll}])/gu
const STRIP_NON_WORD = /[^\p{L}\d]+/giu

function splitWords(input: string): string[] {
	let result = input.trim().replace(SPLIT_LOWER_UPPER, "$1\0$2").replace(SPLIT_UPPER_UPPER, "$1\0$2")
	result = result.replace(STRIP_NON_WORD, "\0")

	let start = 0
	let end = result.length

	while (result.charAt(start) === "\0") {
		start++
	}

	if (start === end) {
		return []
	}

	while (result.charAt(end - 1) === "\0") {
		end--
	}

	return result.slice(start, end).split("\0")
}

export function snakeCase(input: string): string {
	return splitWords(input)
		.map((word) => word.toLocaleLowerCase())
		.join("_")
}

/**
 * Converts a name to snake_case, unless the name is already in all caps.
 *
 * A caseless script takes the all-caps branch, because `toUpperCase()` is the identity on Korean, Japanese, Chinese,
 * Hebrew and Arabic. That is the right branch. Those names have no case to convert and survive as written.
 */
export function smartSnakeCase<T extends string>(name: T): T extends Uppercase<T> ? T : SnakeCase<T>
export function smartSnakeCase(name: string): string

export function smartSnakeCase(name: string): string {
	const normalizedName = name
		// Remove periods after capital letters, e.g. "U.S.A." -> "USA"
		.replaceAll(/([A-Z])(\.+)/g, "$1")
		.trim()

	if (normalizedName.toUpperCase() === normalizedName) {
		return (
			normalizedName
				// Replace everything that cannot be part of a key with underscores...
				.replaceAll(NON_KEY_CHARACTER, "_")
				// ...and then replace all sequences of underscores with a single underscore.
				.replaceAll(/_{2,}/g, "_") as any
		)
	}

	return snakeCase(normalizedName) as any
}

export function camelCase<T extends string>(name: T): CamelCase<T>
export function camelCase(name: string): string

export function camelCase(name: string): string {
	return splitWords(name)
		.map((word, index) => {
			const lower = word.toLocaleLowerCase()

			if (index === 0) {
				return lower
			}

			const first = lower[0]!

			return (first >= "0" && first <= "9" ? "_" : "") + first.toLocaleUpperCase() + lower.slice(1)
		})
		.join("") as any
}

/**
 * Converts a name to camelCase, unless the name is already in all caps.
 */
export function smartCamelCase<T extends string>(name: T): T extends Uppercase<T> ? T : CamelCase<T> {
	if (name.toUpperCase() === name) return name as any

	return camelCase(name) as any
}

/**
 * Sentence-case a name into a display label: `afghan_restaurant` and `afghanRestaurant` both become `Afghan
 * restaurant`. The first word is capitalized and the rest are lowercased.
 */
export function sentenceCase(name: string): string {
	const sentence = splitWords(name)
		.map((word) => word.toLocaleLowerCase())
		.join(" ")

	return sentence.charAt(0).toLocaleUpperCase() + sentence.slice(1)
}

/**
 * Options shared by the case predicates and {@link titleCase}. Every function taking them also accepts a number in the
 * same position and ignores it, so they can be handed straight to `Array.prototype.some`, `every`, `filter` and `map`
 * without a wrapping arrow.
 */
export interface CaseOptions {
	/**
	 * Cased letters the input needs before the predicate can be true. Keeps a digit-only, punctuation-only or single
	 * stray token from reading as a whole shouting or whispering input.
	 *
	 * @default 1
	 */
	minimumCased?: number

	/**
	 * Which characters the input may contain. `"latin"` refuses a letter from any other script; `"ascii"` refuses any
	 * character above U+007F. Case conversion outside Latin script is locale-sensitive and can change string length, so a
	 * caller that must keep offsets stable gates on this.
	 *
	 * @default "any"
	 */
	script?: "any" | "latin" | "ascii"
}

const LATIN_LETTER = /\p{Script=Latin}/u
const CONTRACTION_LENGTH = 2
const ASCII_MAX = 0x7f

interface CaseProfile {
	/**
	 * Count of uppercase letters.
	 */
	upper: number
	/**
	 * Count of lowercase letters.
	 */
	lower: number
	/**
	 * Whether a letter from a script other than Latin was seen.
	 */
	nonLatin: boolean
	/**
	 * Whether any character above U+007F was seen.
	 */
	nonAscii: boolean
}

const CODE_A = 0x41
const CODE_Z = 0x5a
const CODE_a = 0x61
const CODE_z = 0x7a
const CODE_UNDERSCORE = 0x5f
const CODE_APOSTROPHE = 0x27
const CODE_RIGHT_SINGLE_QUOTE = 0x20_19
const SURROGATE_HIGH_START = 0xd8_00
const SURROGATE_HIGH_END = 0xdb_ff

/**
 * Read the code point at `index`, so a supplementary character is examined whole rather than as two surrogates.
 */
function codePointLengthAt(input: string, index: number): number {
	const unit = input.charCodeAt(index)

	return unit >= SURROGATE_HIGH_START && unit <= SURROGATE_HIGH_END && index + 1 < input.length ? 2 : 1
}

/**
 * A run of characters with no case. Sticky, so one `exec` at a Korean, Chinese, Japanese, digit or punctuation position
 * skips the whole run instead of classifying it a character at a time.
 */
const UNCASED_RUN = /[^\p{Lu}\p{Ll}\p{Lt}]+/uy

function caseProfile(input: string): CaseProfile {
	const profile: CaseProfile = { upper: 0, lower: 0, nonLatin: false, nonAscii: false }

	for (let i = 0; i < input.length; i++) {
		const code = input.charCodeAt(i)

		// ASCII is the overwhelmingly common case, and needs no allocation to classify.
		if (code <= ASCII_MAX) {
			if (code >= CODE_A && code <= CODE_Z) {
				profile.upper++
			} else if (code >= CODE_a && code <= CODE_z) {
				profile.lower++
			}

			continue
		}

		profile.nonAscii = true

		UNCASED_RUN.lastIndex = i
		const uncased = UNCASED_RUN.exec(input)

		if (uncased) {
			i += uncased[0].length - 1

			continue
		}

		const length = codePointLengthAt(input, i)
		const ch = input.slice(i, i + length)
		i += length - 1

		if (!LATIN_LETTER.test(ch)) {
			profile.nonLatin = true
		}

		if (ch === ch.toUpperCase()) {
			profile.upper++
		} else {
			profile.lower++
		}
	}

	return profile
}

/**
 * Normalize the second argument of a predicate: a number is an array index and means "no options".
 */
function toOptions(options: CaseOptions | number | undefined): Required<CaseOptions> {
	if (typeof options !== "object") return { minimumCased: 1, script: "any" }

	return { minimumCased: options.minimumCased ?? 1, script: options.script ?? "any" }
}

function admits(profile: CaseProfile, script: CaseOptions["script"]): boolean {
	if (script === "ascii") return !profile.nonAscii

	if (script === "latin") return !profile.nonLatin

	return true
}

/**
 * True when the input has at least one cased character and every cased character is uppercase.
 *
 * `"123"` and a Korean header have no cased characters, so they are neither upper nor lower case; see
 * {@link isUniformlyCased} for the predicate that accepts them.
 *
 * With `minimumCased` and `script` this is the strict "shouting input" detector: `isUpperCase(text, { minimumCased: 3,
 * script: "latin" })` is true only for a Latin-script input with three or more capitals and no lowercase letter.
 */
export function isUpperCase(input: string, options?: CaseOptions | number): boolean {
	const { minimumCased, script } = toOptions(options)
	const profile = caseProfile(input)

	return profile.lower === 0 && profile.upper >= minimumCased && admits(profile, script)
}

/**
 * True when the input has at least one cased character and every cased character is lowercase.
 *
 * Takes the same options as {@link isUpperCase}.
 */
export function isLowerCase(input: string, options?: CaseOptions | number): boolean {
	const { minimumCased, script } = toOptions(options)
	const profile = caseProfile(input)

	return profile.upper === 0 && profile.lower >= minimumCased && admits(profile, script)
}

/**
 * Predicate to determine if a given string is uniformly cased, i.e. it does not mix upper and lower case.
 *
 * A string with no cased characters at all (`"123"`, `"한글"`) is uniformly cased. `null` and the empty string are not.
 */
export function isUniformlyCased(input: string | null): boolean {
	if (!input) return false

	const { upper, lower } = caseProfile(input)

	return upper === 0 || lower === 0
}

export interface TitleCaseOptions {
	/**
	 * A run of Latin letters this long or shorter is "short" and handled by {@link TitleCaseOptions.short} instead of
	 * being titlecased. In address text every run of one or two letters is an abbreviation (`NY`, `DC`, `NW`, `ST`) that
	 * reads best uppercase, and titlecasing `NY` to `Ny` turns a region into a locality.
	 *
	 * @default 0
	 */
	shortLength?: number

	/**
	 * What to do with a short run: leave it as typed, or uppercase it.
	 *
	 * @default "keep"
	 */
	short?: "keep" | "upper"
}

/**
 * Titlecase each run of Latin letters: the first letter uppercased, the rest lowercased. `o'brien` becomes `O'Brien`
 * and `mcdonald's` becomes `Mcdonald's`. Characters outside Latin script, digits and punctuation pass through as typed,
 * so `first_name` becomes `First_Name`; use {@link sentenceCase} for a label from a code.
 *
 * Length-preserving by construction: a run whose case conversion changes its length (`İ` lowercases to two code units,
 * `ß` uppercases to `SS`) is kept as typed, so offsets into the input never move.
 *
 * Accepts a number in place of options and ignores it, so `strings.map(titleCase)` works.
 */
export function titleCase(input: string, options?: TitleCaseOptions | number): string {
	const shortLength = typeof options === "object" ? (options.shortLength ?? 0) : 0
	const uppercaseShort = typeof options === "object" && options.short === "upper"

	let out = ""
	// Index of the first character not yet copied to `out`.
	let copied = 0
	// Index where the current Latin run began, or -1 outside a run.
	let runStart = -1
	let runAfterApostrophe = false

	const closeRun = (runEnd: number) => {
		const run = input.slice(runStart, runEnd)
		let converted: string

		if (runAfterApostrophe && run.length <= CONTRACTION_LENGTH) {
			converted = run.toLowerCase()
		} else if (run.length <= shortLength) {
			converted = uppercaseShort ? run.toUpperCase() : run
		} else {
			converted = run[0]!.toUpperCase() + run.slice(1).toLowerCase()
		}

		if (converted !== run && converted.length === run.length) {
			out += input.slice(copied, runStart) + converted
			copied = runEnd
		}

		runStart = -1
	}

	for (let i = 0; i < input.length; i++) {
		const code = input.charCodeAt(i)
		let latin: boolean
		let length = 1

		if (code <= ASCII_MAX) {
			latin = (code >= CODE_A && code <= CODE_Z) || (code >= CODE_a && code <= CODE_z)
		} else {
			length = codePointLengthAt(input, i)
			latin = LATIN_LETTER.test(input.slice(i, i + length))
		}

		if (latin) {
			if (runStart === -1) {
				runStart = i

				runAfterApostrophe =
					i > 0 && (input.charCodeAt(i - 1) === CODE_APOSTROPHE || input.charCodeAt(i - 1) === CODE_RIGHT_SINGLE_QUOTE)
			}

			i += length - 1

			continue
		}

		if (runStart !== -1) {
			closeRun(i)
		}

		if (code === CODE_UNDERSCORE) {
			out += input.slice(copied, i) + " "
			copied = i + 1
		}

		i += length - 1
	}

	if (runStart !== -1) {
		closeRun(input.length)
	}

	return copied === 0 ? input : out + input.slice(copied)
}

/**
 * Titlecases a string, unless the string is uniformly cased, or an email address.
 */
export function smartCapitalCase(input: string): string {
	if (input.includes("@")) return input

	if (isUniformlyCased(input)) return input

	return titleCase(input)
}

/**
 * Titlecase a shouted string, leave anything else alone. The shape source dumps use when a field arrives all caps.
 */
export function titleCaseIfUpper(input: string, options?: CaseOptions | number): string {
	return isUpperCase(input, options) ? titleCase(input) : input
}

/**
 * Given an array of column names, normalize them to ensure they are unique and usable as object keys.
 *
 * Keys are LOWER CASE, where {@link smartSnakeCase} leaves an all-caps name as it found it. A column key is an
 * identifier a caller types. One source's `LON,LAT,NUMBER` is another's `lon,lat,number` for the same data. A reader
 * that preserves the difference makes every consumer handle both spellings. `smartSnakeCase` keeps its own contract for
 * callers naming things other than columns.
 */
export function normalizeColumnNames(columnHeaders: Iterable<string>): string[] {
	const columnInputCountMap = new Map<string, number>()
	const distinctColumns = new Set<string>()
	const keyableColumnNames = Iterator.from(columnHeaders).map((name) => smartSnakeCase(name).toLowerCase())

	for (const columnHeader of keyableColumnNames) {
		if (distinctColumns.has(columnHeader)) {
			const headerCount = (columnInputCountMap.get(columnHeader) ?? 1) + 1
			columnInputCountMap.set(columnHeader, headerCount)

			const uniqueColumnName = `${columnHeader}_${headerCount}`
			distinctColumns.add(uniqueColumnName)
		} else {
			distinctColumns.add(columnHeader)
		}
	}

	return Array.from(distinctColumns)
}
