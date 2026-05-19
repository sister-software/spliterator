/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Yargs command to split a CSV file.
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
import { type ArgumentsCamelCase, type Argv } from "yargs"
import { commonCommandsBuilder, type PluckArgv, type SpliteratorFilter } from "../utils.js"

export const command = "csv [source] [destination]"
export const describe = false

export const builder = (argv: Argv) => {
	return commonCommandsBuilder(argv)
		.option("header", {
			alias: "h",
			description: "Whether the CSV file has a header",
			default: true,
			boolean: true,
		})
		.option("transformers", {
			alias: "ts",
			description: "Path to JS file exporting transformer functions",
			string: true,
			normalize: true,
		})
		.options("column-delimiter", {
			alias: "c",
			description: "Delimiter to split columns on",
			default: ",",
		})
		.option("mode", {
			alias: "m",
			description: "Output mode",
			choices: ["object", "array"] as const satisfies CSVOutputMode[],
			default: "object",
			string: true,
		})
}

export type CSVCommandArgs = PluckArgv<typeof builder>

export const handler = async (argv: ArgumentsCamelCase<CSVCommandArgs>) => {
	const joinDelimiter = new CharacterSequence(argv.join).decode()
	let transformers: CSVTransformerRecord = {}

	if (argv.transformers) {
		transformers = await import(resolvePath(argv.transformers))
	}

	let filter: SpliteratorFilter = () => true
	if (argv.filter) {
		const module = await import(resolvePath(argv.filter))
		filter = module.default
	}

	const [readStream, writeStream] = await Promise.all([
		createReadStream(argv.source, argv.readerHighWaterMark),
		createFileWritableStream(argv.destination, {
			encoding: "utf8",
			highWaterMark: argv.writerHighWaterMark,
		}),
	])

	const writer = writeStream.getWriter()

	const spliterator = CSVSpliterator.fromAsync(readStream, {
		mode: argv.mode as CSVOutputMode,
		delimiter: argv.split,
		autoDispose: true,
		header: argv.header,
		transformers,
		columnDelimiter: argv.columnDelimiter,
		take: argv.take,
		drop: argv.drop,
	} satisfies CSVSpliteratorInit & AsyncSpliteratorInit)

	for await (const row of spliterator) {
		const emit = await filter(row)

		if (!emit) continue

		await writer.write(JSON.stringify(row))
		await writer.write(joinDelimiter)
	}

	await writer.close()
}
