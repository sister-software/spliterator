/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { CSVSpliterator } from "spliterator"
import { fixturesDirectory } from "spliterator/test/utils"

const generator = CSVSpliterator.fromAsync(fixturesDirectory("carvel.csv"), {
	mode: "object",
	autoDispose: true,
	header: true,
	transformers: {
		PRICE: (value) => Number.parseFloat(value.replaceAll(/[^\d.]/g, "")),
		size: (value) => value.toUpperCase(),
	},
})

const rows = await Array.fromAsync(generator)

console.table(rows)
