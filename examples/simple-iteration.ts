/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { DelimitedTextGenerator } from "@sister.software/ribbon"
import { fixturesDirectory } from "@sister.software/ribbon/test/utils"

const generator = DelimitedTextGenerator.fromAsync(fixturesDirectory("greek-partial.txt"), { skipEmpty: false })

let idx = 0
for await (const line of generator) {
	idx++
	console.log(`Line ${idx}: ${JSON.stringify(line)}`)
}

console.log("---")
console.log(`Total rows: ${idx}`)
