#!/usr/bin/env node

/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 * @file CLI entry point for the Spliterator library.
 */

import { createRequire } from "node:module"

import * as csv from "./commands/csv.js"
import * as iterate from "./commands/iterate.js"
import * as parallel from "./commands/parallel.js"
import { usageError } from "./utils.js"

const rootHelp = [
	iterate.help,
	"",
	"Commands:",
	"  csv                           Split a CSV file into JSONL format.",
	"  parallel                      Run commands concurrently over delimited input.",
	"",
	"Sister Software, AGPL-3.0",
	"https://sister.software",
].join("\n")

const argv = process.argv.slice(2)
const [first, ...rest] = argv

try {
	switch (first) {
		case "csv":
			await csv.run(rest)
			break

		case "parallel":
			await parallel.run(rest)
			break

		case "--version":
			console.log((createRequire(import.meta.url)("../../../package.json") as { version: string }).version)
			break

		case undefined:
		case "help":
		case "--help":
		case "-h":
			console.log(rootHelp)
			break

		default:
			await iterate.run(argv)
	}
} catch (error) {
	// `parseArgs` rejects unknown or malformed flags — report those as usage errors, not crashes.
	if (error instanceof Error && String((error as NodeJS.ErrnoException).code).startsWith("ERR_PARSE_ARGS")) {
		usageError(error.message)
	}

	throw error
}
