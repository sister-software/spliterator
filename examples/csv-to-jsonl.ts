/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { CSVGenerator } from "@sister.software/ribbon"
import { fixturesDirectory } from "@sister.software/ribbon/test/utils"

const generator = CSVGenerator.fromAsync(fixturesDirectory("carvel.csv"), {
	mode: "object",
})

for await (const row of generator) {
	console.log(JSON.stringify(row))
}
