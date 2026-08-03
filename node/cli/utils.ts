/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import type { ParseArgsOptionsConfig } from "node:util"

/**
 * Options accepted by every Spliterator command.
 */
export const commonOptions = {
	split: { type: "string", short: "s", default: "\n" },
	join: { type: "string", short: "j", default: "\n" },
	"skip-empty": { type: "boolean", short: "e", default: true },
	take: { type: "string", short: "t" },
	drop: { type: "string", short: "p", default: "0" },
	debug: { type: "boolean", short: "v", default: false },
	"reader-high-water-mark": { type: "string", short: "w", default: String(4096 * 16) },
	"writer-high-water-mark": { type: "string", short: "W", default: String(4096 * 16 * 4) },
	filter: { type: "string", short: "f" },
	source: { type: "string", short: "i" },
	destination: { type: "string", short: "o" },
	help: { type: "boolean", short: "h", default: false },
} as const satisfies ParseArgsOptionsConfig

export const commonOptionsHelp = [
	"  -s, --split <delimiter>       Delimiter to split lines on (default: newline)",
	"  -j, --join <delimiter>        Delimiter to join lines on (default: newline)",
	"  -e, --skip-empty              Skip empty lines (default: true, disable with --no-skip-empty)",
	"  -t, --take <count>            Number of lines to take (default: all)",
	"  -p, --drop <count>            Number of lines to drop (default: 0)",
	"  -v, --debug                   Debug mode",
	"  -w, --reader-high-water-mark  High water mark for the read stream (default: 65536)",
	"  -W, --writer-high-water-mark  High water mark for the write stream (default: 262144)",
	"  -f, --filter <path>           Path to JS file exporting a default filter function",
	"  -i, --source <path>           Source file, if not given positionally",
	"  -o, --destination <path>      Destination file, if not given positionally",
	"  -h, --help                    Show this help",
].join("\n")

/**
 * Coerce a numeric option, exiting with a usage error if it isn't a number.
 */
export function toNumber(name: string, input: string | undefined): number | undefined {
	if (input === undefined) return undefined

	const value = Number(input)

	if (!Number.isFinite(value)) {
		usageError(`Option --${name} expects a number, received "${input}".`)
	}

	return value
}

/**
 * Resolve the source and destination paths from positionals, falling back to their flag forms.
 */
export function resolveIO(
	positionals: string[],
	values: { source?: string; destination?: string }
): [source: string, destination: string] {
	const source = values.source ?? positionals[0]
	const destination = values.destination ?? positionals[1]

	if (!source) {
		usageError("Missing required argument: source.")
	}

	if (!destination) {
		usageError("Missing required argument: destination.")
	}

	return [source, destination]
}

/**
 * Print a usage error and exit.
 */
export function usageError(message: string): never {
	console.error(`${message}\n\nRun \`spliterator --help\` for usage.`)

	return process.exit(1)
}

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
export interface LineTransformerModuleExports {
	default: LineTransformer
}
