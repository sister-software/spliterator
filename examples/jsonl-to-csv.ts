/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { JSONSpliterator } from "spliterator"
import { fixturesDirectory } from "spliterator/test/utils"

interface Row {
	item_name: string
	character_name: string
	category: string
	size: string
}

const generator = JSONSpliterator.fromAsync<Row>(fixturesDirectory("carvel.jsonl"))
const firstRow = await generator.next()

if (firstRow.done) {
	process.exit(1)
}

console.log(Object.keys(firstRow.value).join(","))
console.log(Object.values(firstRow.value).join(","))

for await (const row of generator) {
	console.log(Object.values(row).join(","))
}
