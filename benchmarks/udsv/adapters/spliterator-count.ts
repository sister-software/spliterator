/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 *
 * uDSV bench adapter: stream a file and count rows and cells without retaining them. uDSV's own non-retained adapters
 * sum one numeric column, which the datasets here do not all have, so the count adapters below are the comparison.
 */

import { CSVSpliterator } from "spliterator"

export const name = "spliterator (stream, count)"
export const repo = "https://github.com/sister-software/spliterator"

export async function load() {
	return async (_csvStr: string, path: string) => {
		let rows = 0
		let cells = 0

		for await (const row of CSVSpliterator.fromAsync(path, {
			mode: "array",
			header: false,
			trim: false,
			bulkThreshold: 0,
		})) {
			rows++
			cells += row.length
		}

		return [[rows], [cells]]
	}
}
