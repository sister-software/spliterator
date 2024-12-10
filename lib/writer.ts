/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { createWriteStream, PathLike, WriteStream } from "node:fs"

/**
 * Callback for writing a line to a newline-delimited file.
 */
export interface WriteLineCallback {
	/**
	 * Write a line to the file. The line should not contain a newline character.
	 */
	(content: string): Promise<void>
	/**
	 * Write a chunk to the file. The chunk should not contain a newline character.
	 */
	(chunk: any, encoding: BufferEncoding): Promise<void>
}

export interface NewlineWriter extends AsyncDisposable {
	/**
	 * Write a line to the file.
	 *
	 * The content should not contain a newline character.
	 */
	write: WriteLineCallback
	dispose: () => Promise<void>
	writer: WriteStream
}

/**
 * Creates a writer for newline-delimited files.
 */
export function createNewlineWriter(filePath: PathLike): NewlineWriter {
	const writer = createWriteStream(filePath)

	const write: WriteLineCallback = (content) => {
		return new Promise((resolve, reject) => {
			writer.write(content, "utf8", (error) => {
				if (error) {
					reject(error)
					return
				}

				resolve()
			})
		})
	}

	const dispose = () => {
		return new Promise<void>((resolve, reject) => {
			writer.close((error) => {
				if (error) {
					reject(error)
					return
				}

				resolve()
			})
		})
	}

	return {
		write,
		writer,
		dispose,
		[Symbol.asyncDispose]: dispose,
	}
}
