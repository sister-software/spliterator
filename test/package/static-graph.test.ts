/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "vitest"

/**
 * Every specifier a bundler can follow: static `import`/`export ... from`, and a dynamic `import()` whose argument is a
 * string literal. Vite and webpack chase the latter into a chunk and warn on it exactly as they would a static import,
 * so the only escape hatch is a variable specifier (`lib/internal/node-modules.ts`).
 */
const STATIC_SPECIFIER =
	/^\s*(?:import|export)\b[^"'`;]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const outDir = resolve(packageDir, "out")

type MapTarget = string | { default: string }

const manifest = JSON.parse(await readFile(resolve(packageDir, "package.json"), "utf8")) as {
	name: string
	imports: Record<string, MapTarget>
	exports: Record<string, MapTarget>
}

/**
 * Resolve a `#` import-map or self-package specifier to the compiled file a bundler would take. Returns `null` for
 * anything else, which the walk reports as a bare specifier.
 */
function resolveInternal(specifier: string): string | null {
	const selfPrefix = `${manifest.name}/`
	const table = specifier.startsWith("#") ? manifest.imports : manifest.exports

	const key = specifier.startsWith("#")
		? specifier
		: specifier === manifest.name
			? "."
			: specifier.startsWith(selfPrefix)
				? `./${specifier.slice(selfPrefix.length)}`
				: null

	if (key === null) return null

	for (const [pattern, target] of Object.entries(table)) {
		const file = typeof target === "string" ? target : target.default
		const star = pattern.indexOf("*")

		if (star === -1) {
			if (pattern === key) return resolve(packageDir, file)

			continue
		}

		const prefix = pattern.slice(0, star)
		const suffix = pattern.slice(star + 1)

		if (key.startsWith(prefix) && key.endsWith(suffix) && key.length >= pattern.length - 1) {
			return resolve(packageDir, file.replace("*", key.slice(prefix.length, key.length - suffix.length)))
		}
	}

	return null
}

/**
 * Walks the static import graph from a compiled entry point, through relative, `#` import-map and self-package
 * specifiers, and returns every bare specifier reached.
 */
async function bareSpecifiersReachableFrom(entry: string): Promise<Set<string>> {
	const seen = new Set<string>()
	const bare = new Set<string>()
	const queue = [entry]

	while (queue.length) {
		const file = queue.pop()!

		if (seen.has(file)) continue
		seen.add(file)

		// Block comments and whole-line comments are dropped first: a doc comment that mentions `import("node:...")` is
		// prose, not an edge.
		const text = (await readFile(file, "utf8")).replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^\s*\/\/.*$/gm, "")

		for (const match of text.matchAll(STATIC_SPECIFIER)) {
			const specifier = match[1] ?? match[2] ?? match[3]!

			if (specifier.startsWith(".")) {
				queue.push(resolve(dirname(file), specifier))

				continue
			}

			const internal = resolveInternal(specifier)

			if (internal) {
				queue.push(internal)
			} else {
				bare.add(specifier)
			}
		}
	}

	return bare
}

describe("static import graph", () => {
	test("the root entry statically imports no node: module", async () => {
		const bare = await bareSpecifiersReachableFrom(resolve(outDir, "index.js"))

		expect([...bare].filter((s) => s.startsWith("node:"))).toEqual([])
	})

	test("the web entry statically imports nothing outside the package", async () => {
		const bare = await bareSpecifiersReachableFrom(resolve(outDir, "web.js"))

		expect([...bare]).toEqual([])
	})

	test("the casing entry statically imports nothing outside the package", async () => {
		const bare = await bareSpecifiersReachableFrom(resolve(outDir, "lib/formats/casing.js"))

		expect([...bare]).toEqual([])
	})
})
