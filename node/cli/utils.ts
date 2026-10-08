/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import type { OptionSpec } from "./spec.js"

/**
 * Options accepted by every Spliterator command.
 */
export const commonOptionSpecs = {
	split: { type: "string", short: "s", hint: "delimiter", default: "\n", description: "Delimiter to split lines on." },
	join: { type: "string", short: "j", hint: "delimiter", default: "\n", description: "Delimiter to join lines with." },
	"skip-empty": { type: "boolean", short: "e", default: true, description: "Skip empty lines." },
	take: {
		type: "number",
		short: "t",
		hint: "count",
		description: "Number of lines to take.",
		validate: (value) => Number.isInteger(value) && value >= 0,
		validationMessage: "Option --take must be a non-negative integer.",
	},
	drop: {
		type: "number",
		short: "p",
		hint: "count",
		default: 0,
		description: "Number of lines to drop.",
		validate: (value) => Number.isInteger(value) && value >= 0,
		validationMessage: "Option --drop must be a non-negative integer.",
	},
	debug: { type: "boolean", short: "v", default: false, description: "Enable debug logging." },
	"reader-high-water-mark": {
		type: "number",
		short: "w",
		hint: "bytes",
		default: 4096 * 16,
		description: "Input stream buffer size.",
		validate: (value) => Number.isInteger(value) && value >= 1,
		validationMessage: "Option --reader-high-water-mark must be a positive integer.",
	},
	"writer-high-water-mark": {
		type: "number",
		short: "W",
		hint: "bytes",
		default: 4096 * 16 * 4,
		description: "Output stream buffer size.",
		validate: (value) => Number.isInteger(value) && value >= 1,
		validationMessage: "Option --writer-high-water-mark must be a positive integer.",
	},
	filter: { type: "string", short: "f", hint: "path", description: "JS module exporting a default filter." },
	source: { type: "string", short: "i", hint: "path", description: "Source file, if not given positionally." },
	destination: {
		type: "string",
		short: "o",
		hint: "path",
		description: "Destination file, if not given positionally.",
	},
} as const satisfies Readonly<Record<string, OptionSpec>>

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
