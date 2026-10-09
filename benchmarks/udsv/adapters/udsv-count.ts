/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 *
 * uDSV bench adapter: uDSV streaming a file and counting rows and cells. The counterpart of `spliterator-count.ts`.
 */

import { createReadStream } from "node:fs"
import { createRequire } from "node:module"

export const name = "uDSV (stream, count)"
export const repo = "https://github.com/leeoniya/uDSV"

interface UDSVParser {
	stringArrs: unknown
	chunk: (chunk: string, mode: unknown, each: (row: string[]) => void) => void
	end: () => void
}

interface UDSV {
	inferSchema: (chunk: string) => unknown
	initParser: (schema: unknown) => UDSVParser
}

export async function load() {
	const require = createRequire(process.env.UDSV_ROOT + "/")
	const { inferSchema, initParser } = require("./dist/uDSV.cjs.js") as UDSV

	return (_csvStr: string, path: string) =>
		new Promise<number[][]>((resolve) => {
			const stream = createReadStream(path, { highWaterMark: 1024 * 1024 })
			let parser: UDSVParser | null = null
			let rows = 0
			let cells = 0

			stream.on("data", (chunk) => {
				const text = chunk.toString()

				parser ??= initParser(inferSchema(text))

				parser.chunk(text, parser.stringArrs, (row) => {
					rows++
					cells += row.length
				})
			})

			stream.on("end", () => {
				parser?.end()
				resolve([[rows], [cells]])
			})
		})
}
