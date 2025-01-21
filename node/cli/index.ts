#!/usr/bin/env node

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file CLI entry point for the Spliterator library.
 */

import { hideBin } from "yargs/helpers"
import yargs from "yargs/yargs"

const argv = yargs(hideBin(process.argv))

argv
	.command(await import("./commands/iterate.js"))
	.usage(
		[
			// ---
			"Iterate over a file, line by line, writing the transformed output to a new file.",
			"$0 [source] [destination]",
			"",
		].join("\n")
	)
	.command(await import("./commands/csv.js"))
	.usage(
		[
			// ---
			"Split a CSV file into JSONL format.",
			"$0 csv [source] [destination]",
			"",
		].join("\n")
	)
	.epilogue(
		[
			// ---
			"Sister Software, AGPL-3.0",
			"https://sister.software",
		].join("\n")
	)
	.wrap(Math.min(120, argv.terminalWidth()))
	.scriptName("spliterator")
	.parse()
