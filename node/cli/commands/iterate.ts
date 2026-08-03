/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 * @file Default command — iterate over a file, line by line.
 */

import { resolve as resolvePath } from "node:path"
import { parseArgs } from "node:util"

import { CharacterSequence, Spliterator } from "spliterator"
import { createFileWritableStream, createReadStream } from "spliterator/node/fs"

import {
	commonOptions,
	commonOptionsHelp,
	resolveIO,
	toNumber,
	type LineTransformer,
	type LineTransformerModuleExports,
	type SpliteratorFilter,
} from "../utils.js"

export const help = [
	"Iterate over a file, line by line, writing the transformed output to a new file.",
	"",
	"Usage: spliterator [source] [destination] [options]",
	"",
	"Options:",
	commonOptionsHelp,
	"  -T, --transformer <path>      Path to JS file exporting a default transformer function",
].join("\n")

export async function run(args: string[]): Promise<void> {
	const { values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		allowNegative: true,
		options: {
			...commonOptions,
			transformer: { type: "string", short: "T" },
		},
	})

	if (values.help) {
		console.log(help)

		return
	}

	const [source, destination] = resolveIO(positionals, values)
	const take = toNumber("take", values.take)
	const drop = toNumber("drop", values.drop)
	const readerHighWaterMark = toNumber("reader-high-water-mark", values["reader-high-water-mark"])!
	const writerHighWaterMark = toNumber("writer-high-water-mark", values["writer-high-water-mark"])

	let transformer: LineTransformer = (line: Uint8Array) => line
	const joinDelimiter = new CharacterSequence(values.join)

	if (values.transformer) {
		const module: LineTransformerModuleExports = await import(resolvePath(values.transformer))
		transformer = module.default
	}

	let filter: SpliteratorFilter = () => true

	if (values.filter) {
		const module = await import(resolvePath(values.filter))
		filter = module.default
	}

	const [readStream, writeStream] = await Promise.all([
		createReadStream(source, readerHighWaterMark),
		createFileWritableStream(destination, {
			highWaterMark: writerHighWaterMark,
		}),
	])

	const writer = writeStream.getWriter()

	const spliterator = Spliterator.from(readStream, {
		delimiter: values.split,
		skipEmpty: values["skip-empty"],
		take,
		drop,
		debug: values.debug,
	})

	for await (const line of spliterator) {
		const transformed = await transformer(line)

		const emit = await filter(line)

		if (!emit) continue

		await writer.write(transformed)
		await writer.write(joinDelimiter)
	}

	await writer.close()
}
