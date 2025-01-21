/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { resolve as resolvePath } from "node:path"
import { CharacterSequence, Spliterator } from "spliterator"
import { createFileWritableStream, createReadStream } from "spliterator/node/fs"
import { ArgumentsCamelCase, Argv } from "yargs"
import {
	commonCommandsBuilder,
	LineTransformer,
	LineTransformerModuleExports,
	PluckArgv,
	SpliteratorFilter,
} from "../utils.js"

export const command = "$0 [source] [destination]"
export const describe = false

export const builder = (argv: Argv) => {
	return commonCommandsBuilder(argv).option("transformer", {
		alias: "t",
		description: "Path to JS file exporting a default transformer function",
		string: true,
	})
}

export type IterateCommandArgs = PluckArgv<typeof builder>

export const handler = async (argv: ArgumentsCamelCase<IterateCommandArgs>) => {
	let transformer: LineTransformer = (line: Uint8Array) => line
	const joinDelimiter = new CharacterSequence(argv.join)

	if (argv.transformer) {
		const module: LineTransformerModuleExports = await import(resolvePath(argv.transformer))
		transformer = module.default
	}

	let filter: SpliteratorFilter = () => true
	if (argv.filter) {
		const module = await import(resolvePath(argv.filter))
		filter = module.default
	}

	const [readStream, writeStream] = await Promise.all([
		createReadStream(argv.source, argv.readerHighWaterMark),
		createFileWritableStream(argv.destination, {
			highWaterMark: argv.writerHighWaterMark,
		}),
	])

	const writer = writeStream.getWriter()

	const spliterator = Spliterator.from(readStream, {
		delimiter: argv.split,
		skipEmpty: argv.skipEmpty,
		take: argv.take,
		drop: argv.drop,
		debug: argv.debug,
	})

	for await (const line of spliterator) {
		const transformed = await transformer(line)

		const emit = await filter(line)

		if (!emit) continue

		await writer.write(transformed)
		await writer.write(joinDelimiter)
	}
}
