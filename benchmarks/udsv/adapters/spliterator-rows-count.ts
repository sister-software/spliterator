/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 *
 * uDSV bench adapter: stream a file and count rows only, never decoding columns. This is spliterator's scan-only
 * path (`CSVSpliterator.countAsync`) — a different workload from the full-parse count adapters, which produce every
 * cell and discard it, so it is listed as its own row rather than replacing them.
 */

import { CSVSpliterator } from "spliterator"

export const name = "spliterator (stream, row count)"
export const repo = "https://github.com/sister-software/spliterator"

export async function load() {
	return async (_csvStr: string, path: string) => {
		const rows = await CSVSpliterator.countAsync(path, {
			header: false,
			trim: false,
			bulkThreshold: 0,
		})

		return [[rows]]
	}
}
