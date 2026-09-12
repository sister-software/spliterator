/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import type { Dirent } from "node:fs"
import { glob as globNative, stat } from "node:fs/promises"
import { join, relative, resolve as resolvePath } from "node:path"
import { fileURLToPath } from "node:url"

import type { PathBuilderLike } from "path-ts"

import { AsyncSequence } from "../../lib/iterators/AsyncSequence.js"

/**
 * A glob pattern, optionally expressed with a {@linkcode PathBuilder}.
 */
export type GlobPattern = string | PathBuilderLike

/**
 * One or more glob patterns.
 */
export type GlobPatternInput = GlobPattern | readonly GlobPattern[]

interface GlobCommonOptions {
	/**
	 * Directory from which patterns are evaluated. Relative paths resolve against {@linkcode process.cwd}.
	 */
	cwd?: string | PathBuilderLike | URL

	/**
	 * Glob patterns to exclude.
	 */
	exclude?: readonly GlobPattern[]

	/**
	 * Yield only non-directory entries.
	 *
	 * @default true
	 */
	onlyFiles?: boolean

	/**
	 * Follow symbolic links while expanding `**` patterns.
	 *
	 * @default false
	 */
	followSymlinks?: boolean

	/**
	 * Abort iteration.
	 */
	signal?: AbortSignal

	/**
	 * Throw when no entries are yielded.
	 *
	 * @default false
	 */
	throwIfUnmatched?: boolean

	/**
	 * Throw when `cwd` does not exist. Set this to `false` for an absence-tolerant walk, which yields no entries when the
	 * directory is missing.
	 *
	 * @default true
	 */
	throwIfDirectoryMissing?: boolean
}

/**
 * Options for a path-returning {@linkcode Globerator.from} call.
 */
export interface GlobStringOptions extends GlobCommonOptions {
	withFileTypes?: false

	/**
	 * Yield absolute paths instead of paths relative to `cwd`.
	 *
	 * @default true
	 */
	absolute?: boolean
}

/**
 * Options for a {@linkcode Dirent}-returning {@linkcode Globerator.from} call.
 */
export interface GlobDirentOptions extends GlobCommonOptions {
	/**
	 * Yield {@linkcode Dirent}s instead of path strings.
	 */
	withFileTypes: true
}

export type GlobOptions = GlobStringOptions | GlobDirentOptions

/**
 * A file extension, with or without its leading dot (for example, `"json"` or `".json"`).
 */
export type FileExtension = string

/**
 * Options for {@linkcode Globerator.files}.
 */
export interface FileGlobOptions extends GlobStringOptions {
	/**
	 * Search descendant directories as well as `cwd`.
	 *
	 * @default false
	 */
	recursive?: boolean
}

/**
 * Node filesystem discovery as composable async sequences.
 *
 * {@linkcode Globerator.from} accepts arbitrary Node glob patterns. {@linkcode Globerator.files} is the concise form for
 * the common “files with these extensions” case.
 */
export abstract class Globerator {
	constructor() {
		throw new TypeError("Static class cannot be instantiated. Did you mean `Globerator.from`?")
	}

	/**
	 * Lazily walk files matching one or more glob patterns.
	 *
	 * Unlike Node's {@linkcode globNative}, this yields only non-directory entries by default, resolves `cwd` to an
	 * absolute path (including `Dirent.parentPath`), accepts {@linkcode PathBuilder}s, and returns an
	 * {@linkcode AsyncSequence} for composable async iteration. Path results are absolute by default; pass `{ absolute:
	 * false }` to make them relative to `cwd`.
	 */
	static from(pattern: GlobPatternInput, options: GlobDirentOptions): AsyncSequence<Dirent>
	static from(pattern: GlobPatternInput, options?: GlobStringOptions): AsyncSequence<string>

	static from(pattern: GlobPatternInput, options: GlobOptions = {}): AsyncSequence<string | Dirent> {
		return AsyncSequence.from(() => globEntries(pattern, options))
	}

	/**
	 * Lazily find files with one or more extensions.
	 *
	 * Extensions may include their leading dot, so `"json"` and `".json"` are equivalent. Pass `recursive: true` to
	 * search descendants; the default only examines `cwd` itself.
	 */
	static files(
		extensions: FileExtension | readonly FileExtension[],
		options: FileGlobOptions = {}
	): AsyncSequence<string> {
		const normalized = (Array.isArray(extensions) ? extensions : [extensions]).map(normalizeExtension)
		const prefix = options.recursive ? "**/" : ""
		const { recursive: _recursive, ...globOptions } = options

		return Globerator.from(
			normalized.map((extension) => `${prefix}*.${extension}`),
			globOptions
		)
	}
}

function normalizeExtension(extension: FileExtension): string {
	const normalized = extension.startsWith(".") ? extension.slice(1) : extension

	if (!normalized || /[/*?\\[\]{}]/u.test(normalized)) {
		throw new TypeError(`Invalid file extension: ${JSON.stringify(extension)}`)
	}

	return normalized
}

async function* globEntries(pattern: GlobPatternInput, options: GlobOptions): AsyncGenerator<string | Dirent> {
	const cwd = resolveGlobCwd(options.cwd)
	const patterns = (Array.isArray(pattern) ? pattern : [pattern]).map(String)
	const exclude = options.exclude?.map(String)
	const onlyFiles = options.onlyFiles ?? true

	options.signal?.throwIfAborted()

	if (!(await isGlobDirectory(cwd, options.throwIfDirectoryMissing ?? true))) return

	let matched = false

	for await (const entry of globNative(patterns, {
		cwd,
		withFileTypes: true,
		exclude,
		followSymlinks: options.followSymlinks,
	})) {
		options.signal?.throwIfAborted()

		if (onlyFiles && entry.isDirectory()) continue

		if (options.withFileTypes) {
			matched = true
			yield entry

			continue
		}

		const path = join(entry.parentPath, entry.name)

		matched = true
		yield options.absolute === false ? relative(cwd, path) : path
	}

	if (!matched && options.throwIfUnmatched) {
		throw new Error(`No entries matched ${formatPatterns(patterns)} in ${cwd}`)
	}
}

async function isGlobDirectory(cwd: string, throwIfMissing: boolean): Promise<boolean> {
	try {
		const details = await stat(cwd)

		if (!details.isDirectory()) {
			throw new TypeError(`Glob cwd is not a directory: ${cwd}`)
		}

		return true
	} catch (error) {
		if (!throwIfMissing && isNotFoundError(error)) return false

		throw error
	}
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function formatPatterns(patterns: readonly string[]): string {
	return patterns.length === 1 ? JSON.stringify(patterns[0]) : JSON.stringify(patterns)
}

function resolveGlobCwd(cwd?: string | PathBuilderLike | URL): string {
	if (!cwd) return process.cwd()

	return resolvePath(cwd instanceof URL ? fileURLToPath(cwd) : String(cwd))
}
