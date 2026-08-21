/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 * @file Command to split a CSV file into JSONL format.
 */

import { resolve as resolvePath } from "node:path"

import {
	CharacterSequence,
	CSVSpliterator,
	type AsyncSpliteratorInit,
	type CSVOutputMode,
	type CSVSpliteratorInit,
	type CSVTransformerRecord,
} from "spliterator"
import { createFileWritableStream, createReadStream } from "spliterator/node/fs"

import { type CommandSpec, parseCommand, renderCommandHelp } from "../spec.js"
import { commonOptionSpecs, resolveIO, type SpliteratorFilter } from "../utils.js"

const MODES = ["object", "array"] as const satisfies CSVOutputMode[]

export const spec = {
	name: "csv",
	usage: "csv [source] [destination] [options]",
	description: "Split a CSV file into JSONL format.",
	options: {
		...commonOptionSpecs,
		header: { type: "boolean", short: "H", default: true, description: "Treat the first row as a header." },
		transformers: {
			type: "string",
			short: "T",
			hint: "path",
			description: "JS module exporting transformer functions.",
		},
		"column-delimiter": {
			type: "string",
			short: "c",
			hint: "delimiter",
			default: ",",
			description: "Delimiter to split columns on.",
		},
		mode: { type: "string", short: "m", hint: "mode", choices: MODES, default: "object", description: "Output mode." },
	},
} as const satisfies CommandSpec

export const help = renderCommandHelp(spec)

export async function run(args: string[]): Promise<void> {
	const { values, positionals } = parseCommand(spec, args)

	if (values.help) {
		console.log(help)

		return
	}

	const [source, destination] = resolveIO(positionals, values as { source?: string; destination?: string })
	const take = values.take as number | undefined
	const drop = values.drop as number
	const readerHighWaterMark = values["reader-high-water-mark"] as number
	const writerHighWaterMark = values["writer-high-water-mark"] as number

	const joinDelimiter = new CharacterSequence(values.join as string).decode()
	let transformers: CSVTransformerRecord = {}

	if (typeof values.transformers === "string") {
		transformers = await import(resolvePath(values.transformers))
	}

	let filter: SpliteratorFilter = () => true

	if (typeof values.filter === "string") {
		const module = await import(resolvePath(values.filter))
		filter = module.default
	}

	const [readStream, writeStream] = await Promise.all([
		createReadStream(source, readerHighWaterMark),
		createFileWritableStream(destination, {
			encoding: "utf8",
			highWaterMark: writerHighWaterMark,
		}),
	])

	const writer = writeStream.getWriter()

	const spliterator = CSVSpliterator.fromAsync(readStream, {
		mode: values.mode as CSVOutputMode,
		delimiter: values.split as string,
		autoDispose: true,
		header: Boolean(values.header),
		transformers,
		columnDelimiter: values["column-delimiter"] as string,
		take,
		drop,
	} satisfies CSVSpliteratorInit & AsyncSpliteratorInit)

	for await (const row of spliterator) {
		const emit = await filter(row)

		if (!emit) continue

		await writer.write(JSON.stringify(row))
		await writer.write(joinDelimiter)
	}

	await writer.close()
}
