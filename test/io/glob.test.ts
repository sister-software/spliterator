/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { AsyncSequence } from "spliterator"
import { Globerator } from "spliterator/node/fs"
import { afterAll, describe, expect, test } from "vitest"

const dir = mkdtempSync(join(tmpdir(), "spliterator-glob-"))
writeFileSync(join(dir, "abc.txt"), "abc")
mkdirSync(join(dir, "nested"))
writeFileSync(join(dir, "nested", "second.txt"), "second")
writeFileSync(join(dir, "nested", "ignored.log"), "ignored")

afterAll(async () => {
	const { rm } = await import("node:fs/promises")
	await rm(dir, { recursive: true, force: true })
})

describe("Globerator", () => {
	test("returns a composable sequence of absolute, non-directory paths by default", async () => {
		const matches = Globerator.from("**/*", { cwd: dir })

		expect(matches).toBeInstanceOf(AsyncSequence)

		expect((await matches.filter((path) => path.endsWith(".txt")).toArray()).toSorted()).toEqual(
			[join(dir, "abc.txt"), join(dir, "nested", "second.txt")].toSorted()
		)
	})

	test("supports exclusions and relative paths", async () => {
		const matches = await Globerator.from("**/*", {
			cwd: dir,
			exclude: ["nested/**"],
			absolute: false,
		}).toArray()

		expect(matches).toEqual(["abc.txt"])
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

	test("finds one or more extensions, with recursion opt-in", async () => {
		const shallow = await Globerator.files(".txt", { cwd: dir, absolute: false }).toArray()
		const recursive = await Globerator.files(["txt", ".log"], { cwd: dir, absolute: false, recursive: true }).toArray()

		expect(shallow).toEqual(["abc.txt"])
		expect(recursive.toSorted()).toEqual(["abc.txt", "nested/ignored.log", "nested/second.txt"])
	})

	test("rejects extensions that are empty or glob patterns", () => {
		expect(() => Globerator.files(".")).toThrow(/Invalid file extension/)
		expect(() => Globerator.files("*.json")).toThrow(/Invalid file extension/)
	})
})
