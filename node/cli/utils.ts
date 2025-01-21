/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Argv } from "yargs"

export type PluckArgv<T extends (...args: any[]) => any> = ReturnType<T> extends Argv<infer U> ? U : never

export const commonCommandsBuilder = (argv: Argv) => {
	return argv
		.option("split", {
			alias: "s",
			description: "Delimiter to split lines on",
			default: "\n",
			defaultDescription: "<newline>",
		})
		.option("join", {
			alias: "j",
			description: "Delimiter to join lines on",
			default: "\n",
			defaultDescription: "<newline>",
		})
		.option("skip-empty", {
			alias: "e",
			description: "Skip empty lines",
			default: true,
		})
		.option("take", {
			alias: "t",
			description: "Number of lines to take",
			defaultDescription: "Infinity",
			number: true,
		})
		.option("drop", {
			alias: "p",
			description: "Number of lines to drop",
			default: 0,
		})
		.option("debug", {
			alias: "v",
			description: "Debug mode",
			default: false,
		})
		.option("reader-high-water-mark", {
			alias: "w",
			description: "High water mark for the read stream",
			default: 4096 * 16, // 64 KiB
		})
		.options("writer-high-water-mark", {
			alias: "W",
			description: "High water mark for the write stream",
			default: 4096 * 16 * 4, // 256 KiB
		})
		.option("filter", {
			alias: "f",
			description: "Path to JS file exporting default a filter function",
			string: true,
			normalize: true,
		})
		.positional("source", {
			description: "Path to the source input file",
			alias: "i",
			string: true,
			demandOption: true,
		})
		.positional("destination", {
			description: "Path to the destination output file",
			alias: "o",
			string: true,
			demandOption: true,
		})
}

export type CommonCommandArgs = PluckArgv<typeof commonCommandsBuilder>

/**
 * A function that filters lines from a spliterator's output.
 *
 * @param line - The line to filter, typically a `Uint8Array`.
 *
 * @returns Whether to include the line in the output.
 */
export type SpliteratorFilter = (line: unknown) => boolean | PromiseLike<boolean>

/**
 * A function that transforms lines from a spliterator's output.
 *
 * This occurs **before** filtering.
 */
export type LineTransformer<T = unknown> = (line: Uint8Array) => T | PromiseLike<T>

/**
 * The default export from a module that exports a `LineTransformer`.
 */
export type LineTransformerModuleExports = {
	default: LineTransformer
}
