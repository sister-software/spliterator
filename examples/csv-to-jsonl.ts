/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { CSVSpliterator } from "spliterator"
import { fixturesDirectory } from "spliterator/test/utils"

const generator = CSVSpliterator.fromAsync(fixturesDirectory("carvel.csv"), {
	mode: "object",
	autoDispose: true,
	header: true,
	transformers: {
		PRICE: (value) => parseFloat(value.replace(/[^\d.]/g, "")),
		size: (value) => value.toUpperCase(),
	},
})

const rows = await Array.fromAsync(generator)

console.table(rows)
