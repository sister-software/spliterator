/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { CharacterSequence, DelimitedChunkReader } from "@sister.software/ribbon"
import { NodeFileResource } from "@sister.software/ribbon/node/fs"
import { fixturesDirectory } from "@sister.software/ribbon/test/utils"
import { createReadStream, createWriteStream } from "node:fs"
import * as fs from "node:fs/promises"
import { pipeline } from "node:stream/promises"

const fixturePath = fixturesDirectory("bdc_06_Cable_fixed_broadband_J24_10dec2024.csv")
const handle = await NodeFileResource.open(fixturePath)

const delimiter = new CharacterSequence()
const chunkReader = await DelimitedChunkReader.fromAsync(handle, {
	chunks: 12,
})

const fileSize = await fs.stat(fixturePath).then((stat) => stat.size)

console.log(`Expected File Size: ${fileSize} bytes`)

let totalByteLength = 0
let previousRangeEnd = 0
let idx = 0

for (const [start, end] of chunkReader) {
	idx++

	const byteLength = end - start
	totalByteLength += byteLength
	const rangeDistance = previousRangeEnd - start + idx * delimiter.length
	const percentage = (byteLength / fileSize) * 100

	console.log(
		`#${idx}: [${start}, ${end}] (${totalByteLength.toLocaleString()}) ${rangeDistance}, ${percentage.toFixed(8)}%`
	)

	const rangeFilename = fixturesDirectory(`range-${idx}.csv`)

	const readStream = createReadStream(fixturePath, { start, end, autoClose: true })

	const writeStream = createWriteStream(rangeFilename, { autoClose: true })
	await pipeline(readStream, writeStream)

	previousRangeEnd = totalByteLength
	// console.log(`Wrote range ${idx} to ${rangeFilename}`)
}

await handle.dispose()

const omittedDelimiterByteLength = idx * delimiter.length
totalByteLength += omittedDelimiterByteLength
const shortage = fileSize - totalByteLength - (idx - 1) * delimiter.length

console.log("---")
console.log(`Total Ranges: ${idx}`)
console.log(`Total Byte Length: ${totalByteLength} bytes (${((totalByteLength / fileSize) * 100).toFixed(8)}%)`)
console.log(`Total Byte Shortage: ${shortage} bytes (${((shortage / fileSize) * 100).toFixed(8)}%)`)
