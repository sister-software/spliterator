/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { camelCase, capitalCase, snakeCase } from "change-case"
import type { CamelCase, SnakeCase } from "type-fest"

/**
 * Converts a name to snake_case, unless the name is already in all caps.
 */
export function smartSnakeCase<T extends string>(name: T): T extends Uppercase<T> ? T : SnakeCase<T> {
	const normalizedName = name
		// Remove periods after capital letters, e.g. "U.S.A." -> "USA"
		.replace(/([A-Z])(\.+)/g, "$1")
		.trim()

	if (normalizedName.toUpperCase() === normalizedName) {
		return (
			name
				// Replace all non-word characters with underscores...
				.replace(/\W{1,}/g, "_")
				// ...and then replace all sequences of underscores with a single underscore.
				.replace(/_{2,}/g, "_") as any
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
