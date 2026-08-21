/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

import { expect, test } from "vitest"

const cli = fileURLToPath(new URL("../../out/node/cli/index.js", import.meta.url))

interface CliResult {
	code: number | null
	stdout: string
	stderr: string
}

async function runCLI(args: string[], input: string | Uint8Array): Promise<CliResult> {
	const child = spawn(process.execPath, [cli, "parallel", ...args], { stdio: ["pipe", "pipe", "pipe"] })
	const stdout: Uint8Array[] = []
	const stderr: Uint8Array[] = []

	child.stdout.on("data", (chunk: Uint8Array) => stdout.push(chunk))
	child.stderr.on("data", (chunk: Uint8Array) => stderr.push(chunk))
	child.stdin.end(input)

	const code = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject)
		child.once("close", resolve)
	})

	return {
		code,
		stdout: Buffer.concat(stdout).toString(),
		stderr: Buffer.concat(stderr).toString(),
	}
}

test("parallel CLI substitutes records directly without shell interpretation", async () => {
	const script = "console.log(process.argv[1])"
	const result = await runCLI(["-j", "2", "-k", "--", process.execPath, "-e", script, "{}"], "hello world\nx$y\n")

	expect(result).toEqual({ code: 0, stdout: "hello world\nx$y\n", stderr: "" })
})

test("parallel CLI keeps output in input order while jobs finish out of order", async () => {
	const script = "setTimeout(() => console.log(process.argv[1]), Number(process.argv[1]) * 20)"
	const result = await runCLI(["-j", "3", "-k", "--", process.execPath, "-e", script, "{}"], "3\n1\n2\n")

	expect(result).toEqual({ code: 0, stdout: "3\n1\n2\n", stderr: "" })
})

test("parallel CLI groups each job's output", async () => {
	const script = "const x=process.argv[1]; console.log(x+'a'); setTimeout(() => console.log(x+'b'), Number(x) * 20)"
	const result = await runCLI(["-j", "2", "--", process.execPath, "-e", script, "{}"], "2\n1\n")

	expect(result.code).toBe(0)
	expect(result.stderr).toBe("")
	expect(["1a\n1b\n2a\n2b\n", "2a\n2b\n1a\n1b\n"]).toContain(result.stdout)
})

test("parallel CLI pipe mode keeps records intact at block boundaries", async () => {
	const script = "process.stdin.pipe(process.stdout)"

	const result = await runCLI(
		["--pipe", "--block", "5", "-j", "2", "-k", "--", process.execPath, "-e", script],
		"aa\nbbbb\nc\n"
	)

	expect(result).toEqual({ code: 0, stdout: "aa\nbbbb\nc\n", stderr: "" })
})

test.each(["aa\n\nbbbb\nc", "aa\n\nbbbb\nc\n"])(
	"parallel CLI pipe mode preserves terminators exactly for %j",
	async (input) => {
		const script = "process.stdin.pipe(process.stdout)"

		const result = await runCLI(
			["--pipe", "--block", "4", "-j", "2", "-k", "--", process.execPath, "-e", script],
			input
		)

		expect(result).toEqual({ code: 0, stdout: input, stderr: "" })
	}
)

test("parallel CLI pipe mode aligns multi-byte delimiters across block boundaries", async () => {
	const script = "process.stdin.pipe(process.stdout)"
	const input = "a::bbbb::c"

	const result = await runCLI(
		["--pipe", "--split", "::", "--block", "3", "-j", "2", "-k", "--", process.execPath, "-e", script],
		input
	)

	expect(result).toEqual({ code: 0, stdout: input, stderr: "" })
})

test("parallel CLI accepts NUL-delimited records", async () => {
	const script = "console.log(process.argv[1])"

	const result = await runCLI(["-0", "-k", "--", process.execPath, "-e", script, "{}"], "a b\0c\0")

	expect(result).toEqual({ code: 0, stdout: "a b\nc\n", stderr: "" })
})

test("parallel CLI shares the usual --split input vocabulary", async () => {
	const script = "console.log(process.argv[1])"

	const result = await runCLI(["--split", "|", "-k", "--", process.execPath, "-e", script, "{}"], "a|b|")

	expect(result).toEqual({ code: 0, stdout: "a\nb\n", stderr: "" })
})

test("parallel CLI dry-run renders commands without executing them", async () => {
	const result = await runCLI(["--dry-run", "--", "printf", "value=%s", "{}"], "a b\n")

	expect(result).toEqual({ code: 0, stdout: "printf value=%s 'a b'\n", stderr: "" })
})

test("parallel CLI halt soon stops pulling records after a failed job", async () => {
	const script = "console.log(process.argv[1]); process.exit(process.argv[1] === 'bad' ? 7 : 0)"

	const result = await runCLI(
		["-j", "1", "--halt", "soon", "--", process.execPath, "-e", script, "{}"],
		"bad\nnot-run\n"
	)

	expect(result).toEqual({ code: 1, stdout: "bad\n", stderr: "" })
})

test("parallel CLI tags complete output lines", async () => {
	const script = "console.log(process.argv[1])"
	const result = await runCLI(["--tag", "-k", "--", process.execPath, "-e", script, "{}"], "a\nb\n")

	expect(result).toEqual({ code: 0, stdout: "1\ta\n2\tb\n", stderr: "" })
})

test("parallel CLI line buffering never mixes partial lines", async () => {
	const script =
		"const x=process.argv[1]; process.stdout.write(x); setTimeout(() => console.log('-done'), Number(x) * 20)"

	const result = await runCLI(["--line-buffer", "-j", "2", "--", process.execPath, "-e", script, "{}"], "2\n1\n")

	expect(result.code).toBe(0)
	expect(result.stderr).toBe("")
	expect(result.stdout.split("\n").filter(Boolean).toSorted()).toEqual(["1-done", "2-done"])
})
