/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { expect, test } from "vitest"

import { parseCommand, renderCommandHelp, type CommandSpec } from "../../node/cli/spec.js"

const spec = {
	name: "example",
	description: "Exercise declarative command metadata.",
	options: {
		count: { type: "number", short: "n", hint: "count", default: 2, description: "Number of jobs." },
		mode: { type: "string", choices: ["fast", "safe"], default: "safe", description: "Execution mode." },
		group: { type: "boolean", default: true, description: "Group output." },
		split: { type: "string", default: "\n", description: "Record delimiter." },
	},
} as const satisfies CommandSpec

test("parseCommand derives parser definitions and typed defaults from a command spec", () => {
	const parsed = parseCommand(spec, ["-n", "4", "--mode", "fast", "--no-group", "--", "child", "--flag"])

	expect(parsed).toEqual({
		positionals: ["child", "--flag"],
		values: { help: false, count: 4, mode: "fast", group: false, split: "\n" },
	})
})

test("renderCommandHelp derives labels, defaults, and escaped control characters", () => {
	const help = renderCommandHelp(spec)

	expect(help).toContain("Usage: spliterator example [options]")
	expect(help).toContain("-n, --count <count>")
	expect(help).toContain("--[no-]group")
	expect(help).toContain('Record delimiter. (default: "\\n")')
})
