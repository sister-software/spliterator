/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 * @file Default command — iterate over a file, line by line.
 */

import { resolve as resolvePath } from "node:path"

import { CharacterSequence, Spliterator } from "spliterator"
import { createFileWritableStream, createReadStream } from "spliterator/node/fs"

import { type CommandSpec, parseCommand, renderCommandHelp } from "../spec.js"
import {
	commonOptionSpecs,
	resolveIO,
	type LineTransformer,
	type LineTransformerModuleExports,
	type SpliteratorFilter,
} from "../utils.js"

export const spec = {
	name: "",
	usage: "[source] [destination] [options]",
	description: "Iterate over a file line by line, writing transformed output to a new file.",
	options: {
		...commonOptionSpecs,
		transformer: {
			type: "string",
			short: "T",
			hint: "path",
			description: "JS module exporting a default transformer.",
		},
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

	let transformer: LineTransformer = (line: Uint8Array) => line
	const joinDelimiter = new CharacterSequence(values.join as string)

	if (typeof values.transformer === "string") {
		const module: LineTransformerModuleExports = await import(resolvePath(values.transformer))
		transformer = module.default
	}

	let filter: SpliteratorFilter = () => true

	if (typeof values.filter === "string") {
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
		delimiter: values.split as string,
		skipEmpty: Boolean(values["skip-empty"]),
		take,
		drop,
		debug: Boolean(values.debug),
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
