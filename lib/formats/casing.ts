/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { camelCase, capitalCase, snakeCase } from "change-case"
import type { CamelCase, SnakeCase } from "type-fest"

/**
 * Any character that is not a letter, a digit, or an underscore, in ANY script.
 *
 * `\W` cannot serve here: it is `[^A-Za-z0-9_]` in JavaScript, with or without the `u` flag, so every character of a
 * non-Latin header is "non-word". A Korean CSV header (`영업상태명`) collapsed to a single `_`, and a file of them became
 * `_`, `__2`, `__3` … once `normalizeColumnNames` de-duplicated the collisions — the header was not renamed, it was
 * destroyed, and every value became unreachable by name.
 */
const NON_KEY_CHARACTER = /[^\p{L}\p{N}_]+/gu

/**
 * Converts a name to snake_case, unless the name is already in all caps.
 *
 * A CASELESS SCRIPT TAKES THE ALL-CAPS BRANCH, because `toUpperCase()` is the identity on Korean, Japanese, Chinese,
 * Hebrew and Arabic. That is the right branch — those names have no case to convert and should survive as written — so
 * the branch preserves letters of every script and replaces only what cannot be a key.
 */
export function smartSnakeCase<T extends string>(name: T): T extends Uppercase<T> ? T : SnakeCase<T> {
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

/**
 * Converts a name to camelCase, unless the name is already in all caps.
 */
export function smartCamelCase<T extends string>(name: T): T extends Uppercase<T> ? T : CamelCase<T> {
	if (name.toUpperCase() === name) return name as any

	return camelCase(name) as any
}

/**
 * Predicate to determine if a given string is uniformly cased, i.e. all uppercase or all lowercase.
 */
export function isUniformlyCased(input: string | null): boolean {
	return Boolean(input && (input === input.toUpperCase() || input === input.toLowerCase()))
}

/**
 * Capitalizes a string, unless the string is uniformly cased, or an email address.
 */
export function smartCapitalCase(input: string): string {
	if (input.includes("@")) return input

	if (isUniformlyCased(input)) return input

	return capitalCase(input)
}

/**
 * Given an array of column names, normalize them to ensure they are unique and usable as object keys.
 *
 * Keys are LOWER CASE, where {@link smartSnakeCase} leaves an all-caps name as it found it. A column key is an
 * identifier a caller types, and one source's `LON,LAT,NUMBER` is another's `lon,lat,number` for the same data — a
 * reader that preserves the difference makes every consumer handle both spellings. `smartSnakeCase` keeps its own
 * contract for callers naming things other than columns.
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
