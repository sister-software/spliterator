/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 * @file Declarative command metadata, parsing, validation, and help rendering.
 */

import { parseArgs } from "node:util"

import { usageError } from "./utils.js"

type OptionValue = boolean | number | string

interface OptionSpecBase {
	description: string
	short?: string
	default?: OptionValue
	hint?: string
}

interface BooleanOptionSpec extends OptionSpecBase {
	type: "boolean"
	default?: boolean
}

interface NumberOptionSpec extends OptionSpecBase {
	type: "number"
	default?: number
	validate?: (value: number) => boolean
	validationMessage?: string
}

interface StringOptionSpec extends OptionSpecBase {
	type: "string"
	default?: string
	choices?: readonly string[]
	validate?: (value: string) => boolean
	validationMessage?: string
}

export type OptionSpec = BooleanOptionSpec | NumberOptionSpec | StringOptionSpec

export interface CommandSpec {
	name: string
	description: string
	usage?: string
	options?: Readonly<Record<string, OptionSpec>>
}

export interface ParsedCommand {
	positionals: string[]
	values: Record<string, OptionValue | undefined>
}

function parseNumber(name: string, input: string, spec: NumberOptionSpec): number {
	const value = Number(input)

	if (!Number.isFinite(value)) {
		usageError(`Option --${name} expects a finite number, received ${JSON.stringify(input)}.`)
	}

	if (spec.validate && !spec.validate(value)) {
		usageError(spec.validationMessage ?? `Invalid value for --${name}: ${input}.`)
	}

	return value
}

/**
 * Parse and validate a command from the same metadata used to render its help.
 */
export function parseCommand(spec: CommandSpec, args: readonly string[]): ParsedCommand {
	const definitions: Record<string, { type: "boolean" | "string"; short?: string; default?: boolean | string }> = {
		help: { type: "boolean", short: "h", default: false },
	}

	for (const [name, option] of Object.entries(spec.options ?? {})) {
		definitions[name] = {
			type: option.type === "boolean" ? "boolean" : "string",
			...(option.short ? { short: option.short } : {}),
			...(option.default !== undefined && option.type !== "number" ? { default: option.default } : {}),
		}
	}

	const parsed = parseArgs({ args, allowNegative: true, allowPositionals: true, options: definitions, strict: true })
	const values = { ...parsed.values } as Record<string, OptionValue | undefined>

	for (const [name, option] of Object.entries(spec.options ?? {})) {
		const input = values[name]

		if (option.type === "number") {
			values[name] = input === undefined ? option.default : parseNumber(name, String(input), option)
		} else if (option.type === "string" && input !== undefined) {
			const value = String(input)

			if (option.choices && !option.choices.includes(value)) {
				usageError(`Option --${name} expects one of: ${option.choices.join(", ")}.`)
			}

			if (option.validate && !option.validate(value)) {
				usageError(option.validationMessage ?? `Invalid value for --${name}: ${value}.`)
			}
		}
	}

	return { positionals: parsed.positionals, values }
}

function optionLabel(name: string, option: OptionSpec): string {
	const longName = option.type === "boolean" && option.default === true ? `[no-]${name}` : name
	const long = `--${longName}${option.type === "boolean" ? "" : ` <${option.hint ?? option.type}>`}`

	return option.short ? `-${option.short}, ${long}` : long
}

function formatDefault(value: OptionValue): string {
	return typeof value === "string" && (!value || /\s/.test(value)) ? JSON.stringify(value) : String(value)
}

/**
 * Render command help without loading a UI framework.
 */
export function renderCommandHelp(spec: CommandSpec): string {
	const options = [
		{ label: "-h, --help", description: "Show command help." },
		...Object.entries(spec.options ?? {}).map(([name, option]) => ({
			label: optionLabel(name, option),
			description: `${option.description}${option.default === undefined ? "" : ` (default: ${formatDefault(option.default)})`}`,
		})),
	]

	const labelWidth = Math.min(46, Math.max(...options.map(({ label }) => label.length)) + 4)
	const lines = [`Usage: spliterator ${spec.usage ?? `${spec.name} [options]`}`, "", spec.description, "", "Options:"]

	for (const option of options) {
		lines.push(`  ${option.label.padEnd(labelWidth)}${option.description}`)
	}

	return lines.join("\n")
}
