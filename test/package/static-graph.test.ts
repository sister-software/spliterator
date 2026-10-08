/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
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

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../out")

/**
 * Walks the static import graph from a compiled entry point and returns every bare (non-relative) specifier reached.
 */
async function bareSpecifiersReachableFrom(entry: string): Promise<Set<string>> {
	const seen = new Set<string>()
	const bare = new Set<string>()
	const queue = [entry]

	while (queue.length) {
		const file = queue.pop()!

		if (seen.has(file)) continue
		seen.add(file)

		const text = await readFile(file, "utf8")

		for (const match of text.matchAll(STATIC_SPECIFIER)) {
			const specifier = match[1] ?? match[2] ?? match[3]!

			if (specifier.startsWith(".")) {
				queue.push(resolve(dirname(file), specifier))
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
