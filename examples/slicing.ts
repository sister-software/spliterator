/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 *
 * Split a large file into delimiter-aligned segments and parse each independently. All segments
 * share the event loop here; see `AsyncSpliterator.asManyWorkers` for the worker-thread version.
 */

import * as fs from "node:fs/promises"

import { AsyncSpliterator } from "spliterator"
import { fixturesDirectory } from "spliterator/test/utils"

const fixturePath = fixturesDirectory("bdc_06_Cable_fixed_broadband_J24_10dec2024.csv")
const fileSize = await fs.stat(fixturePath).then((stat) => stat.size)

console.log(`File size: ${fileSize.toLocaleString()} bytes`)

const ranges = await AsyncSpliterator.segments(fixturePath, { delimiter: "\n", concurrency: 12 })
console.log(`Split into ${ranges.length} delimiter-aligned segments.`)

const spliterators = await AsyncSpliterator.asMany(fixturePath, { delimiter: "\n", concurrency: 12 })

let total = 0

for (let i = 0; i < spliterators.length; i++) {
	let rows = 0

	for await (const _ of spliterators[i]!) rows++
	total += rows

	const [start, end] = ranges[i]!
	console.log(`segment #${i}: [${start}, ${end}] → ${rows.toLocaleString()} rows`)
}

console.log(`Total rows: ${total.toLocaleString()}`)
