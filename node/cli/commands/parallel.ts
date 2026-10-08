/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 * @file Run commands concurrently over delimited records or record-aligned blocks.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createReadStream as createNodeReadStream, createWriteStream } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { availableParallelism, tmpdir } from "node:os"
import { join } from "node:path"
import { pipeline } from "node:stream/promises"

import { CharacterSequence, Spliterator } from "spliterator"
import { createReadStream } from "spliterator/node/fs"

import { type CommandSpec, parseCommand, renderCommandHelp } from "../spec.js"
import { usageError } from "../utils.js"

type HaltMode = "never" | "soon" | "now"
const haltModes = ["never", "soon", "now"] as const satisfies readonly HaltMode[]

interface Job {
	index: number
	command: string
	args: string[]
	stdin?: Uint8Array
}

interface JobResult {
	job: Job
	code: number | null
	signal: NodeJS.Signals | null
	stdoutPath?: string
	stderrPath?: string
}

interface SchedulerOptions {
	concurrency: number
	group: boolean
	keepOrder: boolean
	lineBuffer: boolean
	halt: HaltMode
	tag: boolean
	dryRun: boolean
}

export const spec = {
	name: "parallel",
	usage: "parallel [options] -- <command> [arguments...]",
	description:
		"Run a command concurrently over delimited input. Record mode substitutes {} in arguments, or appends the record when {} is absent. Pipe mode sends record-aligned blocks to each command's standard input.",
	options: {
		jobs: {
			type: "number",
			short: "j",
			hint: "count",
			default: availableParallelism(),
			description: "Maximum concurrent jobs.",
			validate: (value) => Number.isInteger(value) && value >= 1,
			validationMessage: "Option --jobs must be a positive integer.",
		},
		split: {
			type: "string",
			short: "s",
			hint: "delimiter",
			default: "\n",
			description: "Delimiter to split records on.",
		},
		null: { type: "boolean", short: "0", default: false, description: "Use NUL-delimited input." },
		pipe: { type: "boolean", default: false, description: "Send record-aligned blocks to child stdin." },
		block: { type: "string", hint: "size", default: "1MiB", description: "Target pipe block size." },
		"keep-order": { type: "boolean", short: "k", default: false, description: "Emit output in input order." },
		group: { type: "boolean", default: true, description: "Keep each job's output together." },
		"line-buffer": {
			type: "boolean",
			default: false,
			description: "Emit complete lines without mixing partial lines.",
		},
		halt: { type: "string", hint: "mode", choices: haltModes, default: "never", description: "Failure policy." },
		tag: { type: "boolean", default: false, description: "Prefix output lines with the input sequence number." },
		"dry-run": { type: "boolean", default: false, description: "Print commands without executing them." },
		source: { type: "string", short: "i", hint: "path", description: "Read input from a file instead of stdin." },
		"skip-empty": { type: "boolean", short: "e", description: "Skip empty records (the record-mode default)." },
		"reader-high-water-mark": {
			type: "number",
			short: "w",
			hint: "bytes",
			default: 64 * 1024,
			description: "Input stream buffer size.",
			validate: (value) => Number.isInteger(value) && value >= 1,
			validationMessage: "Option --reader-high-water-mark must be a positive integer.",
		},
	},
} as const satisfies CommandSpec

export const help = renderCommandHelp(spec)

function parseByteSize(input: string): number {
	const match = /^(\d+(?:\.\d+)?)\s*(B|K|KB|KIB|M|MB|MIB|G|GB|GIB)?$/i.exec(input)

	if (!match) {
		usageError(`Option --block expects a byte size, received "${input}".`)
	}

	const value = Number(match[1])
	const unit = match[2]?.toUpperCase() ?? "B"

	const multiplier =
		unit === "K" || unit === "KB" || unit === "KIB"
			? 1024
			: unit === "M" || unit === "MB" || unit === "MIB"
				? 1024 ** 2
				: unit === "G" || unit === "GB" || unit === "GIB"
					? 1024 ** 3
					: 1

	const bytes = Math.floor(value * multiplier)

	if (!Number.isSafeInteger(bytes) || bytes < 1) {
		usageError(`Option --block must be at least one byte.`)
	}

	return bytes
}

function shellQuote(value: string): string {
	if (/^[\w@%+=:,./-]+$/.test(value)) return value

	return `'${value.replaceAll("'", `'\\''`)}'`
}

async function writeOutput(stream: NodeJS.WriteStream, chunk: Uint8Array | string): Promise<void> {
	if (stream.write(chunk)) return

	await new Promise<void>((resolve, reject) => {
		const cleanup = () => {
			stream.off("drain", onDrain)
			stream.off("error", onError)
		}

		const onDrain = () => {
			cleanup()
			resolve()
		}

		const onError = (error: Error) => {
			cleanup()
			reject(error)
		}

		stream.once("drain", onDrain)
		stream.once("error", onError)
	})
}

function taggedChunk(index: number, chunk: Uint8Array): Uint8Array {
	const prefix = Buffer.from(`${index}\t`)
	const output = Buffer.allocUnsafe(prefix.length + chunk.length)

	output.set(prefix)
	output.set(chunk, prefix.length)

	return output
}

async function pumpLines(
	stream: NodeJS.ReadableStream,
	destination: NodeJS.WriteStream,
	index: number,
	tag: boolean
): Promise<void> {
	let pending: Uint8Array = new Uint8Array()

	for await (const input of stream) {
		const chunk = Buffer.isBuffer(input) ? input : Buffer.from(input)
		const bytes = pending.length ? Buffer.concat([pending, chunk]) : chunk
		let start = 0

		for (let cursor = bytes.indexOf(10); cursor !== -1; cursor = bytes.indexOf(10, start)) {
			const line = bytes.subarray(start, cursor + 1)

			await writeOutput(destination, tag ? taggedChunk(index, line) : line)
			start = cursor + 1
		}

		pending = start < bytes.length ? bytes.subarray(start) : new Uint8Array()
	}

	if (pending.length) {
		await writeOutput(destination, tag ? taggedChunk(index, pending) : pending)
	}
}

async function pumpRaw(stream: NodeJS.ReadableStream, destination: NodeJS.WriteStream): Promise<void> {
	for await (const chunk of stream) {
		await writeOutput(destination, chunk as Uint8Array)
	}
}

async function publishFile(path: string, destination: NodeJS.WriteStream, index: number, tag: boolean): Promise<void> {
	await (tag
		? pumpLines(createNodeReadStream(path), destination, index, true)
		: pumpRaw(createNodeReadStream(path), destination))
}

async function waitForChild(
	child: ChildProcessWithoutNullStreams
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolve, reject) => {
		child.once("error", reject)
		child.once("close", (code, signal) => resolve({ code, signal }))
	})
}

async function writeChildInput(child: ChildProcessWithoutNullStreams, input?: Uint8Array): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const cleanup = () => child.stdin.off("error", onError)

		const onError = (error: Error) => {
			cleanup()
			reject(error)
		}

		const end = () => {
			child.stdin.end(() => {
				cleanup()
				resolve()
			})
		}

		child.stdin.once("error", onError)

		if (!input?.length || child.stdin.write(input)) {
			end()
		} else {
			child.stdin.once("drain", end)
		}
	})
}

async function captureToFile(stream: NodeJS.ReadableStream, path: string): Promise<void> {
	await pipeline(stream, createWriteStream(path))
}

async function* recordJobs(
	source: unknown,
	command: string,
	commandArgs: string[],
	delimiter: CharacterSequence,
	skipEmpty: boolean,
	readerHighWaterMark: number
): AsyncGenerator<Job> {
	const input = await createReadStream(source, readerHighWaterMark)
	const records = Spliterator.from(input, { delimiter, skipEmpty })
	const decoder = new TextDecoder()
	let index = 1

	for await (const recordBytes of records) {
		const record = decoder.decode(recordBytes)

		if (record.includes("\0")) throw new TypeError("A command-line argument cannot contain a NUL byte.")

		const hasPlaceholder = commandArgs.some((argument) => argument.includes("{}"))

		const args = hasPlaceholder
			? commandArgs.map((argument) => argument.replaceAll("{}", record))
			: [...commandArgs, record]

		yield { index: index++, command, args }
	}
}

async function* pipeJobs(
	source: unknown,
	command: string,
	commandArgs: string[],
	delimiter: CharacterSequence,
	skipEmpty: boolean,
	blockSize: number,
	readerHighWaterMark: number
): AsyncGenerator<Job> {
	const input = await createReadStream(source, readerHighWaterMark)

	if (!skipEmpty) {
		let buffer = new Uint8Array(Math.max(blockSize + readerHighWaterMark, 1024))
		let bytesWritten = 0
		let index = 1
		const encoder = new TextEncoder()

		for await (const chunkValue of input) {
			const chunk = typeof chunkValue === "string" ? encoder.encode(chunkValue) : chunkValue
			const required = bytesWritten + chunk.length

			if (required > buffer.length) {
				const grown = new Uint8Array(Math.max(required, buffer.length * 2))

				grown.set(buffer.subarray(0, bytesWritten))
				buffer = grown
			}

			buffer.set(chunk, bytesWritten)
			bytesWritten = required

			while (bytesWritten >= blockSize) {
				// Include a delimiter that starts just before the target but ends at/after it.
				const searchStart = Math.max(0, blockSize - delimiter.length)
				const delimiterOffset = delimiter.search(buffer, searchStart, bytesWritten)

				if (delimiterOffset === -1) break

				const blockEnd = delimiterOffset + delimiter.length
				const stdin = buffer.slice(0, blockEnd)
				const remaining = bytesWritten - blockEnd

				buffer.copyWithin(0, blockEnd, bytesWritten)
				bytesWritten = remaining

				yield { index: index++, command, args: [...commandArgs], stdin }
			}
		}

		if (bytesWritten) {
			yield { index, command, args: [...commandArgs], stdin: buffer.slice(0, bytesWritten) }
		}

		return
	}

	const records = Spliterator.from(input, { delimiter, skipEmpty })
	let chunks: Uint8Array[] = []
	let byteLength = 0
	let index = 1
	let pendingRecord: Uint8Array | undefined

	const flush = (): Job | undefined => {
		if (!chunks.length) return

		const stdin = new Uint8Array(byteLength)
		let offset = 0

		for (const chunk of chunks) {
			stdin.set(chunk, offset)
			offset += chunk.length
		}

		chunks = []
		byteLength = 0

		return { index: index++, command, args: [...commandArgs], stdin }
	}

	for await (const recordView of records) {
		const currentRecord = recordView.slice()

		if (!pendingRecord) {
			pendingRecord = currentRecord

			continue
		}

		const record = new Uint8Array(pendingRecord.length + delimiter.length)

		record.set(pendingRecord)
		record.set(delimiter, pendingRecord.length)

		if (byteLength && byteLength + record.length > blockSize) {
			yield flush()!
		}

		chunks.push(record)
		byteLength += record.length
		pendingRecord = currentRecord
	}

	if (pendingRecord?.length) {
		if (byteLength && byteLength + pendingRecord.length > blockSize) {
			yield flush()!
		}

		chunks.push(pendingRecord)
		byteLength += pendingRecord.length
	}

	const finalJob = flush()

	if (finalJob) {
		yield finalJob
	}
}

async function runScheduler(jobs: AsyncIterable<Job>, options: SchedulerOptions): Promise<number> {
	const temporaryDirectory =
		(options.group && !options.lineBuffer) || options.keepOrder
			? await mkdtemp(join(tmpdir(), "spliterator-"))
			: undefined

	const active = new Set<Promise<void>>()
	const children = new Set<ChildProcessWithoutNullStreams>()
	const ordered = new Map<number, JobResult>()
	let nextOutput = 1
	let publishQueue = Promise.resolve()
	let failed = false
	let stopping = false

	const publish = async (result: JobResult): Promise<void> => {
		if (result.stdoutPath) {
			await publishFile(result.stdoutPath, process.stdout, result.job.index, options.tag)
		}

		if (result.stderrPath) {
			await publishFile(result.stderrPath, process.stderr, result.job.index, options.tag)
		}
	}

	const accept = (result: JobResult) => {
		if (!options.keepOrder) {
			publishQueue = publishQueue.then(() => publish(result))

			return
		}

		ordered.set(result.job.index, result)

		publishQueue = publishQueue.then(async () => {
			while (ordered.has(nextOutput)) {
				const ready = ordered.get(nextOutput)!

				ordered.delete(nextOutput++)
				await publish(ready)
			}

			return undefined
		})
	}

	const stopChildren = (signal: NodeJS.Signals) => {
		for (const child of children) {
			child.kill(signal)
		}
	}

	const onSignal = (signal: NodeJS.Signals) => {
		stopping = true
		failed = true
		stopChildren(signal)
	}

	const onSigint = () => onSignal("SIGINT")
	const onSigterm = () => onSignal("SIGTERM")

	process.once("SIGINT", onSigint)
	process.once("SIGTERM", onSigterm)

	const launch = async (job: Job): Promise<void> => {
		if (options.dryRun) {
			await writeOutput(process.stdout, `${[job.command, ...job.args].map(shellQuote).join(" ")}\n`)

			return
		}

		const child = spawn(job.command, job.args, { stdio: ["pipe", "pipe", "pipe"] })

		children.add(child)

		const stdoutPath = temporaryDirectory ? join(temporaryDirectory, `${job.index}.stdout`) : undefined
		const stderrPath = temporaryDirectory ? join(temporaryDirectory, `${job.index}.stderr`) : undefined

		const outputTasks = stdoutPath
			? [captureToFile(child.stdout, stdoutPath), captureToFile(child.stderr, stderrPath!)]
			: options.lineBuffer || options.tag
				? [
						pumpLines(child.stdout, process.stdout, job.index, options.tag),
						pumpLines(child.stderr, process.stderr, job.index, options.tag),
					]
				: [pumpRaw(child.stdout, process.stdout), pumpRaw(child.stderr, process.stderr)]

		try {
			const [{ code, signal }] = await Promise.all([
				waitForChild(child),
				writeChildInput(child, job.stdin),
				...outputTasks,
			])

			const result = { job, code, signal, stdoutPath, stderrPath }

			if (code !== 0 || signal) {
				failed = true

				if (options.halt !== "never") {
					stopping = true
				}

				if (options.halt === "now") {
					stopChildren("SIGTERM")
				}
			}

			if (stdoutPath) {
				accept(result)
			}
		} catch (error) {
			failed = true
			stopping = options.halt !== "never"
			await writeOutput(process.stderr, `spliterator: job ${job.index} failed: ${String(error)}\n`)

			if (options.halt === "now") {
				stopChildren("SIGTERM")
			}
		} finally {
			children.delete(child)
		}
	}

	try {
		for await (const job of jobs) {
			if (stopping) break

			while (active.size >= options.concurrency) {
				await Promise.race(active)
			}

			if (stopping) break

			const task = launch(job).finally(() => active.delete(task))

			active.add(task)
		}

		await Promise.all(active)
		await publishQueue
	} finally {
		process.off("SIGINT", onSigint)
		process.off("SIGTERM", onSigterm)

		if (temporaryDirectory) {
			await rm(temporaryDirectory, { recursive: true, force: true })
		}
	}

	return failed ? 1 : 0
}

export async function run(args: string[]): Promise<void> {
	const separator = args.indexOf("--")
	const { values, positionals: commandArgs } = parseCommand(spec, args)

	if (values.help) {
		console.log(help)

		return
	}

	if (separator === -1 || !commandArgs.length) {
		usageError("Missing command after `--`.")
	}

	const concurrency = values.jobs as number
	const delimiter = new CharacterSequence(values.null ? 0 : (values.split as string))
	const [command, ...childArgs] = commandArgs
	const skipEmpty = values["skip-empty"] ?? !values.pipe
	const readerHighWaterMark = values["reader-high-water-mark"] as number

	const jobs = values.pipe
		? pipeJobs(
				values.source,
				command!,
				childArgs,
				delimiter,
				Boolean(skipEmpty),
				parseByteSize(values.block as string),
				readerHighWaterMark
			)
		: recordJobs(values.source, command!, childArgs, delimiter, Boolean(skipEmpty), readerHighWaterMark)

	const exitCode = await runScheduler(jobs, {
		concurrency,
		group: Boolean(values.group),
		keepOrder: Boolean(values["keep-order"]),
		lineBuffer: Boolean(values["line-buffer"]),
		halt: values.halt as HaltMode,
		tag: Boolean(values.tag),
		dryRun: Boolean(values["dry-run"]),
	})

	if (exitCode) {
		process.exitCode = exitCode
	}
}
