/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 * @file Command to split a CSV file into JSONL format.
 */

import { resolve as resolvePath } from "node:path"
import { parseArgs } from "node:util"

import {
	CharacterSequence,
	CSVSpliterator,
	type AsyncSpliteratorInit,
	type CSVOutputMode,
	type CSVSpliteratorInit,
	type CSVTransformerRecord,
} from "spliterator"
import { createFileWritableStream, createReadStream } from "spliterator/node/fs"

import { commonOptions, commonOptionsHelp, resolveIO, toNumber, usageError, type SpliteratorFilter } from "../utils.js"

const MODES = ["object", "array"] as const satisfies CSVOutputMode[]

export const help = [
	"Split a CSV file into JSONL format.",
	"",
	"Usage: spliterator csv [source] [destination] [options]",
	"",
	"Options:",
	commonOptionsHelp,
	"  -H, --header                  Whether the CSV file has a header (default: true, disable with --no-header)",
	"  -T, --transformers <path>     Path to JS file exporting transformer functions",
	"  -c, --column-delimiter <str>  Delimiter to split columns on (default: ,)",
	`  -m, --mode <mode>             Output mode: ${MODES.join(" | ")} (default: object)`,
].join("\n")

export async function run(args: string[]): Promise<void> {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		allowNegative: true,
		options: {
			...commonOptions,
			header: { type: "boolean", short: "H", default: true },
			transformers: { type: "string", short: "T" },
			"column-delimiter": { type: "string", short: "c", default: "," },
			mode: { type: "string", short: "m", default: "object" },
		},
	})

	if (values.help) {
		console.log(help)

		return
	}

	const [source, destination] = resolveIO(positionals, values)

	if (!(MODES as readonly string[]).includes(values.mode)) {
		usageError(`Option --mode expects one of: ${MODES.join(", ")}.`)
	}

	const take = toNumber("take", values.take)
	const drop = toNumber("drop", values.drop)
	const readerHighWaterMark = toNumber("reader-high-water-mark", values["reader-high-water-mark"])!
	const writerHighWaterMark = toNumber("writer-high-water-mark", values["writer-high-water-mark"])

	const joinDelimiter = new CharacterSequence(values.join).decode()
	let transformers: CSVTransformerRecord = {}

	if (values.transformers) {
		transformers = await import(resolvePath(values.transformers))
	}

	let filter: SpliteratorFilter = () => true

	if (values.filter) {
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
		delimiter: values.split,
		autoDispose: true,
		header: values.header,
		transformers,
		columnDelimiter: values["column-delimiter"],
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
