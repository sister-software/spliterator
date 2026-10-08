/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import type { CamelCase, SnakeCase } from "type-fest"

/**
 * Matches any character that is not a letter, a digit, or an underscore, across all scripts.
 *
 * `\W` is not usable here. In JavaScript (with or without `u`) it means `[^A-Za-z0-9_]`, so every character in a
 * non-Latin header is treated as "non-word".
 *
 * For example, a Korean CSV header (`영업상태명`) was reduced to `_`, and a file full of such headers became `_`, `__2`,
 * `__3`, … after `normalizeColumnNames` de-duplicated collisions. The headers were effectively destroyed, making values
 * unreachable by name.
 */
const NON_KEY_CHARACTER = /[^\p{L}\p{N}_]+/gu

// Word-boundary split rules. We use a NUL separator because
// it cannot be matched as a word character by the stripping expression.
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
 * Caseless scripts take the all-caps branch because `toUpperCase()` is an identity transform for Korean, Japanese,
 * Chinese, Hebrew, and Arabic. That is intentional: these names have no case to convert and should be preserved.
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
 * Word-split a name and titlecase every word: `firstName`, `first_name` and `FIRST_NAME` all become `First Name`, and
 * `XMLHttpRequest` becomes `Xml Http Request`. The label form of a code or identifier.
 *
 * Unlike {@link titleCase}, this splits on camel boundaries and drops punctuation, so it is not length-preserving and
 * `o'brien` becomes `O Brien`. Use {@link titleCase} for text and this for identifiers.
 */
export function capitalCase(name: string): string {
	return splitWords(name)
		.map((word) => word[0]!.toLocaleUpperCase() + word.slice(1).toLocaleLowerCase())
		.join(" ")
}

/**
 * Converts a name into sentence case for display labels.
 *
 * `afghan_restaurant` and `afghanRestaurant` both become `Afghan restaurant`. The first word is capitalized; the rest
 * are lowercased.
 */
export function sentenceCase(name: string): string {
	const sentence = splitWords(name)
		.map((word) => word.toLocaleLowerCase())
		.join(" ")

	return sentence.charAt(0).toLocaleUpperCase() + sentence.slice(1)
}

/**
 * Options shared by case predicates and {@link titleCase}.
 *
 * Functions that accept these options also accept a number in the same position and ignore it. This makes them usable
 * directly with `Array.prototype.some`, `every`, `filter`, and `map` without a wrapper callback.
 */
export interface CaseOptions {
	/**
	 * Minimum number of cased letters required before a predicate can be true.
	 *
	 * Prevents digit-only, punctuation-only, or single stray tokens from being interpreted as fully upper/lower input.
	 *
	 * @default 1
	 */
	minimumCased?: number

	/**
	 * Restricts which characters the input may contain.
	 *
	 * `"latin"` rejects letters from other scripts; `"ascii"` rejects any character above U+007F.
	 *
	 * Case conversion outside Latin script can be locale-sensitive and may change string length, so callers that need
	 * stable offsets can enforce that here.
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
 * Returns the UTF-16 code-point length at `index`.
 *
 * This ensures supplementary characters are examined as one code point rather than two surrogate code units.
 */
function codePointLengthAt(input: string, index: number): number {
	const unit = input.charCodeAt(index)

	return unit >= SURROGATE_HIGH_START && unit <= SURROGATE_HIGH_END && index + 1 < input.length ? 2 : 1
}

/**
 * Matches a consecutive run of uncased characters.
 *
 * Sticky mode (`y`) lets a single `exec` at Korean, Chinese, Japanese, digit, or punctuation text skip the whole run at
 * once, instead of classifying each character individually.
 */
const UNCASED_RUN = /[^\p{Lu}\p{Ll}\p{Lt}]+/uy

function caseProfile(input: string): CaseProfile {
	const profile: CaseProfile = { upper: 0, lower: 0, nonLatin: false, nonAscii: false }

	for (let i = 0; i < input.length; i++) {
		const code = input.charCodeAt(i)

		// ASCII is the common fast path and needs no allocation to classify.
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
 * Normalizes the optional predicate argument.
 *
 * A numeric argument is treated as an array index (from callback signatures) and means "no options".
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
 * With `minimumCased` and `script`, this becomes a strict "shouting input" detector. `isUpperCase(text, { minimumCased:
 * 3, script: "latin" })` is true only for Latin-script input with three or more uppercase letters and no lowercase
 * letters.
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
 * Returns true when a string is uniformly cased (it does not mix upper and lower case).
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
	 * A run of Latin letters of this length or shorter is treated as "short" and handled by {@link TitleCaseOptions.short}
	 * instead of normal titlecasing.
	 *
	 * In address text, one- or two-letter runs are often abbreviations (`NY`, `DC`, `NW`, `ST`) that read best in
	 * uppercase; titlecasing `NY` to `Ny` can change meaning.
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

	/**
	 * Lowercase words that stay lowercase anywhere but first: the joining particles of a place name
	 * (`Stratford-upon-Avon`, `Villeneuve-l'Archevêque`, `Weston-super-Mare`). A run is matched by its lowercased form,
	 * and the first run of the input is always titlecased. The set is the locale's; this function only applies it.
	 */
	particles?: ReadonlySet<string>
}

/**
 * Titlecases each run of Latin letters: first letter uppercase, remaining letters lowercase.
 *
 * `o'brien` becomes `O'Brien` and `mcdonald's` becomes `Mcdonald's`. Non-Latin text, digits, and punctuation pass
 * through as typed, so `first_name` becomes `First_Name`; use {@link sentenceCase} to create labels from code-like
 * names.
 *
 * Length-preserving by design: if case conversion would change run length (`İ` lowercases to two code units, `ß`
 * uppercases to `SS`), the original run is kept so offsets into the input remain stable.
 *
 * Accepts a number in place of options and ignores it, so `strings.map(titleCase)` works directly.
 */
export function titleCase(input: string, options?: TitleCaseOptions | number): string {
	const shortLength = typeof options === "object" ? (options.shortLength ?? 0) : 0
	const uppercaseShort = typeof options === "object" && options.short === "upper"
	const particles = typeof options === "object" ? options.particles : undefined

	let out = ""
	// Index of the first character not yet copied into `out`.
	let copied = 0
	// Index where the current Latin run begins, or -1 when not in a run.
	let runStart = -1
	let runAfterApostrophe = false
	let runIndex = 0

	const closeRun = (runEnd: number) => {
		const run = input.slice(runStart, runEnd)
		let converted: string

		if (runAfterApostrophe && run.length <= CONTRACTION_LENGTH) {
			converted = run.toLowerCase()
		} else if (particles && runIndex > 0 && particles.has(run.toLowerCase())) {
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

		runIndex++
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
 * Titlecases a string unless it is uniformly cased or appears to be an email address.
 */
export function smartCapitalCase(input: string): string {
	if (input.includes("@")) return input

	if (isUniformlyCased(input)) return input

	return titleCase(input)
}

/**
 * Apply `reference`'s case pattern to `target`: an all-uppercase reference uppercases the target, an all-lowercase one
 * lowercases it, and anything mixed titlecases it. A reference with no cased letters counts as uppercase, and an empty
 * one leaves the target as typed.
 *
 * The idiom for rewriting one token in a user's own casing: replacing `AVE` with `AVENUE`, `Ave` with `Avenue`.
 */
export function matchCase(target: string, reference: string): string {
	if (!reference) return target

	const { upper, lower } = caseProfile(reference)

	if (lower === 0) return target.toUpperCase()

	if (upper === 0) return target.toLowerCase()

	return titleCase(target)
}

/**
 * Titlecases shouting input and leaves everything else unchanged.
 *
 * Useful for shape-source dumps where fields often arrive in all caps.
 */
export function titleCaseIfUpper(input: string, options?: CaseOptions | number): string {
	return isUpperCase(input, options) ? titleCase(input) : input
}

/**
 * Given an array of column names, normalize them to ensure they are unique and usable as object keys.
 *
 * Keys are lowercased, even though {@link smartSnakeCase} preserves all-caps names.
 *
 * Column keys are caller-facing identifiers. One source may emit `LON,LAT,NUMBER` while another emits `lon,lat,number`
 * for the same data. Preserving that difference forces every consumer to handle both spellings. `smartSnakeCase` keeps
 * its original contract for non-column naming use cases.
 */
export function normalizeColumnNames(columnHeaders: Iterable<string>): string[] {
	const columnInputCountMap = new Map<string, number>()
	const distinctColumns = new Set<string>()
	const keyableColumnNames = Iterator.from(columnHeaders).map((name) => smartSnakeCase(name).toLowerCase())

	for (const columnHeader of keyableColumnNames) {
		if (!distinctColumns.has(columnHeader)) {
			distinctColumns.add(columnHeader)

			continue
		}

		// A suffixed name can itself collide with a literal header (`a_2, a, a`), so keep counting until it is free.
		// One name per header, always: a dropped one would shift every later column onto the wrong key.
		let headerCount = columnInputCountMap.get(columnHeader) ?? 1
		let uniqueColumnName: string

		do {
			headerCount++
			uniqueColumnName = `${columnHeader}_${headerCount}`
		} while (distinctColumns.has(uniqueColumnName))

		columnInputCountMap.set(columnHeader, headerCount)
		distinctColumns.add(uniqueColumnName)
	}

	return Array.from(distinctColumns)
}
