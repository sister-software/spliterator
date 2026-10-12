/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"

import { AsyncSequence } from "spliterator"
import { Globerator } from "spliterator/node/fs"
import { afterAll, describe, expect, test } from "vitest"

const dir = mkdtempSync(join(tmpdir(), "spliterator-glob-"))
writeFileSync(join(dir, "abc.txt"), "abc")
mkdirSync(join(dir, "nested"))
writeFileSync(join(dir, "nested", "second.txt"), "second")
writeFileSync(join(dir, "nested", "ignored.log"), "ignored")

const parityDir = mkdtempSync(join(tmpdir(), "spliterator-glob-parity-"))

for (const path of [
	"top.txt",
	"top.log",
	".dotfile.txt",
	".hidden/inside.txt",
	"deep/b.txt",
	"deep/a/a.txt",
	"deep/a/b/c.txt",
	"deep/a/.dot.txt",
	"deep/x/z.txt",
	"nested/x.txt",
	"keep/nested/y.txt",
	"a-alt-b/z.txt",
	"q/w-alt-1.txt",
]) {
	mkdirSync(dirname(join(parityDir, path)), { recursive: true })
	writeFileSync(join(parityDir, path), "")
}

afterAll(async () => {
	const { rm } = await import("node:fs/promises")
	await rm(dir, { recursive: true, force: true })
	await rm(parityDir, { recursive: true, force: true })
})

describe("Globerator", () => {
	test("returns a composable sequence of relative, non-directory paths by default", async () => {
		const matches = Globerator.from("**/*", { cwd: dir })

		expect(matches).toBeInstanceOf(AsyncSequence)

		expect((await matches.filter((path) => path.endsWith(".txt")).toArray()).toSorted()).toEqual(
			["abc.txt", "nested/second.txt"].toSorted()
		)
	})

	test("supports exclusions and absolute paths", async () => {
		const matches = await Globerator.from("**/*", {
			cwd: dir,
			exclude: ["nested/**"],
			absolute: true,
		}).toArray()

		expect(matches).toEqual([join(dir, "abc.txt")])
	})

	test("returns dirents with an absolute parent path", async () => {
		const entries = await Globerator.from("*.txt", { cwd: dir, withFileTypes: true }).toArray()

		expect(entries).toHaveLength(1)
		expect(entries[0]!.name).toBe("abc.txt")
		expect(entries[0]!.parentPath).toBe(dir)
	})

	test("honors an already-aborted signal when iteration begins", async () => {
		const controller = new AbortController()
		controller.abort()

		await expect(Globerator.from("**/*", { cwd: dir, signal: controller.signal }).toArray()).rejects.toThrow(/aborted/i)
	})

	test("throws for a missing cwd by default, or yields nothing when allowed", async () => {
		const missing = join(dir, "missing")

		await expect(Globerator.from("*", { cwd: missing }).toArray()).rejects.toMatchObject({ code: "ENOENT" })
		expect(await Globerator.from("*", { cwd: missing, throwIfDirectoryMissing: false }).toArray()).toEqual([])
	})

	test("can require a yielded match", async () => {
		await expect(Globerator.from("*.json", { cwd: dir, throwIfUnmatched: true }).toArray()).rejects.toThrow(
			/No entries matched/
		)

		expect(await Globerator.from("*.json", { cwd: dir }).toArray()).toEqual([])
	})

	test("finds one or more extensions recursively by default", async () => {
		const files = await Globerator.files(["txt", ".log"], { cwd: dir }).toArray()

		expect(files.toSorted()).toEqual(["abc.txt", "nested/ignored.log", "nested/second.txt"])
	})

	test("can limit extension discovery to cwd", async () => {
		const files = await Globerator.files(".txt", { cwd: dir, recursive: false }).toArray()

		expect(files).toEqual(["abc.txt"])
	})

	test.each([
		["**/*", {}],
		["**/*.txt", {}],
		["*/*.txt", {}],
		["**/*.{txt,log}", {}],
		["deep/**/?.txt", {}],
		["deep/*/[ab].txt", {}],
		["deep/*/[!ab].txt", {}],
		[".hidden/*", {}],
		["**/.*", {}],
		[["**/*.txt", "deep/**/*.txt"], {}],
		["**/*.txt", { exclude: ["nested/**"] }],
		["**/*.txt", { exclude: ["**/deep/**"] }],
		["**/*.txt", { exclude: ["**/*-alt-*"] }],
		["**/*", { onlyFiles: false }],
		["deep/**", { onlyFiles: false }],
	] as const)("matches Node's fs.glob for %j %j", async (pattern, options) => {
		const { glob } = await import("node:fs/promises")
		const onlyFiles = !("onlyFiles" in options) || options.onlyFiles !== false
		const native: string[] = []

		for await (const entry of glob(pattern as string | string[], {
			cwd: parityDir,
			withFileTypes: true,
			exclude: "exclude" in options ? options.exclude : undefined,
		})) {
			if (onlyFiles && entry.isDirectory()) continue

			native.push(relative(parityDir, join(entry.parentPath, entry.name)))
		}

		const ours = await Globerator.from(pattern, { cwd: parityDir, ...options }).toArray()

		expect(ours.toSorted()).toEqual([...new Set(native)].filter(Boolean).toSorted())
	})

	test("walks an absolute pattern from its own static prefix", async () => {
		const matches = await Globerator.from(join(parityDir, "deep", "**", "*.txt"), {
			cwd: dir,
			absolute: true,
		}).toArray()

		expect(matches.toSorted()).toEqual(
			["deep/a/a.txt", "deep/a/b/c.txt", "deep/b.txt", "deep/x/z.txt"].map((path) => join(parityDir, path)).toSorted()
		)
	})

	test("rejects extensions that are empty or glob patterns", () => {
		expect(() => Globerator.files(".")).toThrow(/Invalid file extension/)
		expect(() => Globerator.files("*.json")).toThrow(/Invalid file extension/)
	})
})
