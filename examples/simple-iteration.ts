/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { debugAsVisibleCharacters, Spliterator } from "spliterator"
import { fixturesDirectory } from "spliterator/test/utils"
import * as Colorette from "colorette"

const spliterator = await Spliterator.fromAsync(fixturesDirectory("phonetic-single-spaced.txt"), {
	// skipEmpty: false,
	autoClose: true,
	debug: true,
	// highWaterMark: 8,
	// take: 10,
	// drop: 1,
})

const tableMode = false

if (tableMode) {
	const rows = await Array.fromAsync(spliterator, (line) => debugAsVisibleCharacters(line))
	console.table(rows)

	console.log("---")
	console.log(`Total rows: ${rows.length}`)
} else {
	console.log("Line Number, Line Content")

	let idx = 0
	for await (const line of spliterator) {
		idx++
		console.log(`${Colorette.bold(idx)}, ${Colorette.yellow(debugAsVisibleCharacters(line))}`)
	}

	console.log("---")
	console.log(`Total rows: ${idx}`)
}
