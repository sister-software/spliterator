/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import * as fs from "node:fs/promises"
import { PathBuilder, PathBuilderLike } from "path-ts"

export const fixturesDirectory = PathBuilder.from("test/fixtures")

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export interface FixtureResult {
	bytes: Uint8Array
	text: string
	encodedLines: Uint8Array[]
	decodedLines: string[]
}

export async function loadFixture(fixturePath: PathBuilderLike): Promise<FixtureResult> {
	const bytes = await fs.readFile(fixturePath).then((buffer) => new Uint8Array(buffer))
	const text = decoder.decode(bytes)

	const decodedLines = text.split("\n")
	const encodedLines = decodedLines.map((line) => encoder.encode(line))

	return {
		bytes,
		text,
		encodedLines,
		decodedLines,
	}
}
