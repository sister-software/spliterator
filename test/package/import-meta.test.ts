/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "vitest"

const outDir = fileURLToPath(new URL("../../out/", import.meta.url))

function* jsFiles(dir: string): Generator<string> {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name)

		if (entry.isDirectory()) {
			yield* jsFiles(path)
		} else if (entry.name.endsWith(".js")) {
			yield path
		}
	}
}

describe("import.meta in the shipped library", () => {
	/**
	 * Jiti, which Docusaurus loads its plugins through, transpiles an ESM dependency to CommonJS on the fly. It rewrites
	 * `import.meta.url` and leaves every other `import.meta` form in place, and Node then refuses the file with "Cannot
	 * use 'import.meta' outside a module". spliterator 9.1.0 shipped `import.meta.resolve` in
	 * `lib/internal/node-modules.js` and broke a consumer's docs build. The CLI is not loaded that way and may keep its
	 * `import.meta.url`.
	 */
	test("only import.meta.url appears under out/lib and out/node", () => {
		const offending: string[] = []

		for (const dir of ["lib", "node"]) {
			for (const file of jsFiles(join(outDir, dir))) {
				// Comments may name the forbidden form while explaining why it is forbidden.
				const source = readFileSync(file, "utf8")
					.replaceAll(/\/\*[\s\S]*?\*\//g, "")
					.replaceAll(/^\s*\/\/.*$/gm, "")

				for (const match of source.matchAll(/import\.meta(?:\.(\w+))?/g)) {
					if (match[1] !== "url") {
						offending.push(`${file.slice(outDir.length)}: ${match[0]}`)
					}
				}
			}
		}

		expect(offending).toEqual([])
	})
})
