/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 *
 *   A glob pattern compiled once into per-segment matchers, with the semantics of Node's `fs.glob`: `*`, `?`, `[...]`,
 *   `{a,b}` and `**`, where a wildcard never matches a segment that begins with a dot unless the pattern segment itself
 *   begins with one.
 */

/**
 * One `/`-separated piece of a compiled pattern: the globstar, or a matcher for exactly one path segment.
 */
type Segment = { globstar: true } | { globstar: false; test: (segment: string) => boolean }

/**
 * A pattern compiled for repeated matching against `/`-separated paths.
 */
export interface CompiledGlob {
	/**
	 * Whether the pattern is absolute, and so matches absolute paths rather than paths relative to `cwd`.
	 */
	readonly absolute: boolean

	/**
	 * The leading segments that contain no wildcard. A walk for this pattern starts there.
	 */
	readonly staticPrefix: readonly string[]

	/**
	 * How many segments below {@linkcode staticPrefix} a match can lie, or `Infinity` when the pattern has a globstar.
	 */
	readonly depthBelowPrefix: number

	/**
	 * Whether the path, split into segments, matches the whole pattern.
	 */
	matches(segments: readonly string[]): boolean

	/**
	 * Whether some descendant of the directory, split into segments, could match the pattern.
	 */
	couldMatchBelow(segments: readonly string[]): boolean
}

const MAGIC = /[*?[\]{}]/u

/**
 * Compiles a glob pattern.
 */
export function compileGlob(pattern: string): CompiledGlob {
	const absolute = pattern.startsWith("/")
	const parts = pattern.split("/").filter((part, index) => part !== "" || index === 0)

	if (absolute) {
		parts.shift()
	}

	const collapsed = parts.filter((part, index) => !(part === "**" && parts[index - 1] === "**"))

	const segments: Segment[] = collapsed.map((part) =>
		part === "**" ? { globstar: true } : { globstar: false, test: compileSegment(part) }
	)

	const firstMagic = collapsed.findIndex((part) => MAGIC.test(part))
	const prefixLength = firstMagic === -1 ? Math.max(collapsed.length - 1, 0) : firstMagic
	const staticPrefix = collapsed.slice(0, prefixLength).map(unescape)
	const rest = collapsed.slice(prefixLength)

	return {
		absolute,
		staticPrefix,
		depthBelowPrefix: rest.includes("**") ? Infinity : rest.length,
		matches: (path) => matchFrom(segments, 0, path, 0, false),
		couldMatchBelow: (path) => matchFrom(segments, 0, path, 0, true),
	}
}

/**
 * Matches `path[pi..]` against `segments[si..]`.
 *
 * With `partial`, a path that runs out while pattern segments remain counts as a match, because a descendant could
 * supply them; a globstar left at the end also matches.
 */
function matchFrom(
	segments: readonly Segment[],
	si: number,
	path: readonly string[],
	pi: number,
	partial: boolean
): boolean {
	while (si < segments.length) {
		const segment = segments[si]!

		if (segment.globstar) {
			if (si === segments.length - 1) {
				// A trailing globstar matches every remaining segment that does not begin with a dot.
				for (let i = pi; i < path.length; i++) if (path[i]!.startsWith(".")) return false

				return true
			}

			for (let i = pi; i <= path.length; i++) {
				if (matchFrom(segments, si + 1, path, i, partial)) return true

				if (i < path.length && path[i]!.startsWith(".")) return false
			}

			return false
		}

		if (pi >= path.length) return partial

		if (!segment.test(path[pi]!)) return false

		si++

		pi++
	}

	return pi === path.length
}

/**
 * Compiles one segment to a test. A literal segment compares by equality.
 */
function compileSegment(part: string): (segment: string) => boolean {
	if (!MAGIC.test(part)) {
		const literal = unescape(part)

		return (segment) => segment === literal
	}

	const source = translate(part)
	const dotGuard = part.startsWith(".") ? "" : "(?!\\.)"
	const regex = new RegExp(`^${dotGuard}${source}$`, "u")

	return (segment) => regex.test(segment)
}

/**
 * Translates a glob segment into a regular-expression source.
 */
function translate(part: string): string {
	let out = ""
	let braceDepth = 0

	for (let i = 0; i < part.length; i++) {
		const char = part[i]!

		if (char === "\\" && i + 1 < part.length) {
			out += escapeRegExp(part[++i]!)
		} else if (char === "*") {
			out += "[^/]*"
		} else if (char === "?") {
			out += "[^/]"
		} else if (char === "[") {
			const close = part.indexOf("]", i + 2)

			if (close === -1) {
				out += "\\["
			} else {
				let body = part.slice(i + 1, close)

				if (body.startsWith("!")) {
					body = "^" + body.slice(1)
				}

				out += `[${body.replaceAll("\\", "\\\\")}]`
				i = close
			}
		} else if (char === "{") {
			braceDepth++
			out += "(?:"
		} else if (char === "}" && braceDepth > 0) {
			braceDepth--
			out += ")"
		} else if (char === "," && braceDepth > 0) {
			out += "|"
		} else {
			out += escapeRegExp(char)
		}
	}

	return out + ")".repeat(braceDepth)
}

function escapeRegExp(char: string): string {
	return /[\\^$.*+?()[\]{}|]/u.test(char) ? `\\${char}` : char
}

function unescape(part: string): string {
	return part.replaceAll(/\\(.)/gu, "$1")
}
