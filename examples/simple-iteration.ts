/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { createByteSequenceSearcher, debugAsVisibleCharacters } from "@sister.software/ribbon"
import { fixturesDirectory } from "@sister.software/ribbon/test/utils"

const generator = createByteSequenceSearcher(fixturesDirectory("phonetic-triple-newline.crlf.txt"), {
	// skipEmpty: false,
	autoClose: true,
	delimiter: "\r\n",
	highWaterMark: 8,
	debug: true,
	// take: 10,
	// drop: 1,
})

console.log("Line Number, Line Content")

let idx = 0
for await (const line of generator) {
	idx++
	console.log(`${idx}, ${debugAsVisibleCharacters(line)}`)
}

// const rows = await Array.fromAsync(generator, (line) => debugAsVisibleCharacters(line))

// console.table(rows)
console.log("---")
console.log(`Total rows: ${idx}`)
