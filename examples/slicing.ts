/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { AsyncSlidingWindow } from "@sister.software/ribbon"
import { fixturesDirectory } from "@sister.software/ribbon/test/utils"
import { createReadStream, createWriteStream } from "node:fs"
import * as fs from "node:fs/promises"

const fixturePath = fixturesDirectory("bdc_06_Cable_fixed_broadband_J24_10dec2024.csv")
const ranges = await AsyncSlidingWindow.slice(fixturePath, 4)

const fileSize = await fs.stat(fixturePath).then((stat) => stat.size)

let totalByteLength = 0
let idx = 0

for (const [start, end] of ranges) {
	idx++

	const byteLength = end - start
	totalByteLength += byteLength
	const percentage = (byteLength / fileSize) * 100

	console.log(`Range ${idx}: ${JSON.stringify({ start, end, byteLength })}, ${percentage.toFixed(8)}%`)

	const rangeFilename = fixturesDirectory(`range-${idx}.csv`)

	const readStream = createReadStream(fixturePath, { start, end })

	const writeStream = createWriteStream(rangeFilename)

	readStream.pipe(writeStream)

	await new Promise((resolve) => {
		writeStream.on("close", resolve)
	})

	console.log(`Wrote range ${idx} to ${rangeFilename}`)

	await new Promise((resolve) => readStream.close(resolve))
	await new Promise((resolve) => writeStream.close(resolve))
}

console.log("---")
console.log(`Total Ranges: ${idx}`)
console.log(`Total Byte Length: ${totalByteLength} bytes (${((totalByteLength / fileSize) * 100).toFixed(8)}%)`)
