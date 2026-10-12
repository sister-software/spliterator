/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

import type { Dir, Dirent } from "node:fs"
import { opendir, realpath, stat } from "node:fs/promises"
import { basename, dirname, join, relative, resolve as resolvePath, sep } from "node:path"
import { fileURLToPath } from "node:url"

import type { PathBuilderLike } from "#internal/shared"
import { AsyncSequence } from "#iterators/AsyncSequence"

import { type CompiledGlob, compileGlob } from "./glob-pattern.ts"

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
	 * @default false
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
	 * @default true
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
	 * Matching follows Node's `fs.glob`. Unlike `fs.glob`, this holds memory in proportion to the directories still to be
	 * read rather than to the entries yielded so far, yields only non-directory entries by default, resolves `cwd` to an
	 * absolute path (including `Dirent.parentPath`), accepts {@linkcode PathBuilder}s, and returns an
	 * {@linkcode AsyncSequence} for composable async iteration. Path results are relative to `cwd` by default. Pass `{
	 * absolute: true }` for absolute paths.
	 */
	public static from(pattern: GlobPatternInput, options: GlobDirentOptions): AsyncSequence<Dirent>
	public static from(pattern: GlobPatternInput, options?: GlobStringOptions): AsyncSequence<string>

	public static from(pattern: GlobPatternInput, options: GlobOptions = {}): AsyncSequence<string | Dirent> {
		return AsyncSequence.from(() => globEntries(pattern, options))
	}

	/**
	 * Lazily find files with one or more extensions.
	 *
	 * Extensions may include their leading dot, so `"json"` and `".json"` are equivalent. Searches descendants by
	 * default. Pass `recursive: false` to examine `cwd` itself only.
	 */
	public static files(
		extensions: FileExtension | readonly FileExtension[],
		options: FileGlobOptions = {}
	): AsyncSequence<string> {
		const normalized = (Array.isArray(extensions) ? extensions : [extensions]).map(normalizeExtension)
		const prefix = options.recursive === false ? "" : "**/"
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

/**
 * A directory still to be read, with its path relative to `cwd` split into segments.
 */
interface PendingDirectory {
	path: string
	segments: string[]
	depth: number
	/**
	 * The resolved path of this directory, kept only below a followed symbolic link to detect a cycle.
	 */
	realPath: string | null
}

/**
 * Walks the directory tree under each pattern's static prefix and yields every entry a pattern matches.
 *
 * Node's `fs.glob` keeps per-entry state for the whole walk, about 1 KB per yielded path, so a walk over millions of
 * files holds gigabytes until it finishes. This walk holds only the directories still to be read. Each entry is visited
 * once, so a path that several patterns match is yielded once without a set of yielded paths.
 */
async function* globEntries(pattern: GlobPatternInput, options: GlobOptions): AsyncGenerator<string | Dirent> {
	const cwd = resolveGlobCwd(options.cwd)
	const patterns = (Array.isArray(pattern) ? pattern : [pattern]).map((value) => value.toString())
	const includes = patterns.map(compileGlob)
	const excludes = (options.exclude ?? []).map((value) => compileGlob(value.toString()))
	const onlyFiles = options.onlyFiles ?? true

	options.signal?.throwIfAborted()

	if (!(await isGlobDirectory(cwd, options.throwIfDirectoryMissing ?? true))) return

	// An absolute pattern matches the absolute path; a relative one matches the path relative to `cwd`.
	const segmentsFor = (glob: CompiledGlob, relativeSegments: readonly string[], path: string) =>
		glob.absolute ? splitSegments(path) : relativeSegments

	const isExcluded = (relativeSegments: readonly string[], path: string) =>
		excludes.some((glob) => glob.matches(segmentsFor(glob, relativeSegments, path)))

	const isIncluded = (relativeSegments: readonly string[], path: string) =>
		includes.some((glob) => glob.matches(segmentsFor(glob, relativeSegments, path)))

	let matched = false

	for (const root of walkRoots(cwd, includes)) {
		if (!(await isGlobDirectory(root.path, false))) continue

		// A pattern such as `dir/**` matches the directory it starts from.
		if (
			!onlyFiles &&
			root.segments.length &&
			!isExcluded(root.segments, root.path) &&
			isIncluded(root.segments, root.path)
		) {
			matched = true

			if (options.withFileTypes) {
				const entry = await readOwnDirent(root.path)

				if (entry) {
					yield entry
				}
			} else {
				yield options.absolute === true ? root.path : relative(cwd, root.path)
			}
		}

		const stack: PendingDirectory[] = [{ path: root.path, segments: root.segments, depth: 0, realPath: null }]

		while (stack.length) {
			const directory = stack.pop()!
			let handle: Dir

			try {
				handle = await opendir(directory.path, { bufferSize: 256 })
			} catch (error) {
				if (isNotFoundError(error) || isNotDirectoryError(error)) continue

				throw error
			}

			for await (const entry of handle) {
				options.signal?.throwIfAborted()

				const segments = [...directory.segments, entry.name]
				const path = join(directory.path, entry.name)

				if (isExcluded(segments, path)) continue

				const isDirectory = entry.isDirectory()

				if (!(onlyFiles && isDirectory) && isIncluded(segments, path)) {
					matched = true

					if (options.withFileTypes) {
						yield entry
					} else {
						yield options.absolute === true ? path : relative(cwd, path)
					}
				}

				if (directory.depth + 1 >= root.maxDepth) continue

				const descend = isDirectory || (options.followSymlinks === true && entry.isSymbolicLink())

				if (!descend) continue

				if (!includes.some((glob) => glob.couldMatchBelow(segmentsFor(glob, segments, path)))) continue

				let realPath = directory.realPath === null ? null : join(directory.realPath, entry.name)

				if (entry.isSymbolicLink()) {
					const target = await resolveDirectoryLink(path)

					if (target === null) continue

					const ancestor = directory.realPath ?? (await realpath(directory.path))

					// A link to its own ancestor would be walked forever.
					if (ancestor === target || ancestor.startsWith(target + sep)) continue

					realPath = target
				}

				stack.push({ path, segments, depth: directory.depth + 1, realPath })
			}
		}
	}

	if (!matched && options.throwIfUnmatched) {
		throw new Error(`No entries matched ${formatPatterns(patterns)} in ${cwd}`)
	}
}

/**
 * Where a walk starts and how deep it goes.
 */
interface WalkRoot {
	path: string
	segments: string[]
	maxDepth: number
}

/**
 * Chooses the directories to walk: each pattern's static prefix, with a prefix inside another pattern's prefix walked
 * as part of the outer walk, so that no directory is read twice.
 */
function walkRoots(cwd: string, includes: readonly CompiledGlob[]): WalkRoot[] {
	const roots = includes.map((glob) => {
		const path = glob.absolute ? join("/", ...glob.staticPrefix) : join(cwd, ...glob.staticPrefix)

		return { path, depthBelowPrefix: glob.depthBelowPrefix }
	})

	const outer = roots.filter(
		(root, index) =>
			!roots.some(
				(other, otherIndex) =>
					otherIndex !== index && (isInside(root.path, other.path) || (other.path === root.path && otherIndex < index))
			)
	)

	return outer.map((root) => {
		let maxDepth = 0

		for (const other of roots) {
			if (other.path !== root.path && !isInside(other.path, root.path)) continue

			const offset = other.path === root.path ? 0 : splitSegments(relative(root.path, other.path)).length

			maxDepth = Math.max(maxDepth, offset + other.depthBelowPrefix)
		}

		return { path: root.path, segments: splitSegments(relative(cwd, root.path)), maxDepth }
	})
}

function isInside(path: string, ancestor: string): boolean {
	return path.startsWith(ancestor.endsWith(sep) ? ancestor : ancestor + sep)
}

function splitSegments(path: string): string[] {
	return path.split(sep).filter(Boolean)
}

/**
 * Reads the {@linkcode Dirent} that a path's parent directory lists for it.
 */
async function readOwnDirent(path: string): Promise<Dirent | null> {
	const name = basename(path)

	for await (const entry of await opendir(dirname(path))) {
		if (entry.name === name) return entry
	}

	return null
}

async function resolveDirectoryLink(path: string): Promise<string | null> {
	try {
		const target = await realpath(path)

		return (await stat(target)).isDirectory() ? target : null
	} catch (error) {
		if (isNotFoundError(error)) return null

		throw error
	}
}

function isNotDirectoryError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOTDIR"
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

	return resolvePath(cwd instanceof URL ? fileURLToPath(cwd) : cwd.toString())
}
