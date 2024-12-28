/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { AsyncSlidingWindow, DelimitedChunkReader, Delimiter } from "@sister.software/ribbon"
import { NodeFileResource } from "@sister.software/ribbon/node/fs"
import { test } from "vitest"
import { fixturesDirectory } from "./utils.js"

const fixturePath = fixturesDirectory("bdc_06_Cable_fixed_broadband_J24_10dec2024.csv")

test("Delimited Chunk Reader", { timeout: 25_000, skip: true }, async ({ expect, onTestFinished }) => {
	const delimiter = Delimiter.from("\n")

	const handle = await NodeFileResource.open(fixturePath)
	onTestFinished(() => handle.dispose())

	let lineCount = 0

	const desiredChunks = 6

	const chunks = await DelimitedChunkReader.fromAsync(handle, {
		chunks: desiredChunks,
	})

	expect(chunks.length, "Chunk count matches").equal(desiredChunks)

	const slidingWindows = AsyncSlidingWindow.collect(
		Array.from(chunks, ([start, end]) => {
			return new AsyncSlidingWindow(handle, {
				delimiter,
				position: start,
				byteLength: end,
			})
		})
	)

	for await (const ranges of slidingWindows) {
		lineCount += ranges.length

		console.log(`Line Count: ${lineCount}`)
	}

	expect(lineCount, "Line count matches").equal(9669347)
})
