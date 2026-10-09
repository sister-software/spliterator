/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 *
 * uDSV bench adapter: stream a file into retained string arrays. Mirrors `streaming/untyped/retained/uDSV.cjs` there.
 */

import { CSVSpliterator } from "spliterator"

export const name = "spliterator (stream)"
export const repo = "https://github.com/sister-software/spliterator"

export async function load() {
	return (_csvStr: string, path: string) =>
		CSVSpliterator.fromAsync(path, { mode: "array", header: false, trim: false, bulkThreshold: 0 }).toArray()
}
