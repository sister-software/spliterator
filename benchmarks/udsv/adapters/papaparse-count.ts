/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 *
 * uDSV bench adapter: PapaParse streaming a file and counting rows and cells. The counterpart of `spliterator-count.ts`.
 */

import { createReadStream } from "node:fs"
import { createRequire } from "node:module"

export const name = "PapaParse (stream, count)"
export const repo = "https://github.com/mholt/PapaParse"

interface Papa {
	parse(
		stream: NodeJS.ReadableStream,
		options: { step(result: { data: unknown[] }): void; complete(): void; error(error: Error): void }
	): void
}

export async function load() {
	const require = createRequire(process.env.UDSV_ROOT + "/bench/")
	const Papa = require("papaparse") as Papa

	return (_csvStr: string, path: string) =>
		new Promise<number[][]>((resolve, reject) => {
			let rows = 0
			let cells = 0

			Papa.parse(createReadStream(path), {
				step: (result) => {
					rows++
					cells += result.data.length
				},
				complete: () => resolve([[rows], [cells]]),
				error: reject,
			})
		})
}
