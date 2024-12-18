/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import * as fs from "node:fs/promises"
import { PathBuilder, PathBuilderLike } from "path-ts"

export const fixturesDirectory = PathBuilder.from("test/fixtures")

export function loadFixture(fixturePath: PathBuilderLike): Promise<Buffer>
export function loadFixture(fixturePath: PathBuilderLike, encoding: BufferEncoding): Promise<string>
export function loadFixture(fixturePath: PathBuilderLike, encoding?: BufferEncoding): Promise<Buffer | string> {
	return fs.readFile(fixturePath, encoding)
}
