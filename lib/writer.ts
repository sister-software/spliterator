/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { createWriteStream, type PathLike, WriteStream } from "node:fs"

/**
 * Callback for writing a line to a newline-delimited file.
 *
 * The trailing newline is appended for you — pass the content alone.
 */
export interface WriteLineCallback {
	/**
	 * Write a line to the file, terminated with a newline. The content should not contain one itself.
	 */
	(content: string): Promise<void>
	/**
	 * Write a chunk to the file, terminated with a newline. The chunk should not contain one itself.
	 */
	(chunk: any, encoding: BufferEncoding): Promise<void>
}

export interface NewlineWriter extends AsyncDisposable {
	/**
	 * Write a line to the file, terminated with a newline.
	 *
	 * The content should not contain a newline character — the writer supplies the delimiter.
	 */
	write: WriteLineCallback
	dispose: () => Promise<void>
	writer: WriteStream
}

/**
 * Creates a writer for newline-delimited files.
 *
 * Every {@linkcode NewlineWriter.write} terminates its content with `\n`, so the file is delimited (and round-trips
 * through {@linkcode TextSpliterator}) without the caller appending anything:
 *
 * ```ts
 * await using out = createNewlineWriter("rows.jsonl")
 *
 * for (const row of rows) await out.write(JSON.stringify(row))
 * ```
 */
export function createNewlineWriter(filePath: PathLike): NewlineWriter {
	const writer = createWriteStream(filePath)

	const write: WriteLineCallback = (content: any, encoding?: BufferEncoding) => {
		return new Promise((resolve, reject) => {
			const settle = (error: Error | null | undefined): void => {
				if (error) {
					reject(error)

					return
				}

				resolve()
			}

			// The delimiter goes out as its own chunk rather than concatenated onto `content`: the
			// two-argument overload accepts a Buffer, and `buffer + "\n"` would stringify it via
			// `toString()` and corrupt the bytes. Stream writes are ordered, so the newline always
			// follows its content, and settling on the delimiter's callback resolves once the whole
			// line has flushed.
			writer.write(content, encoding ?? "utf8")
			writer.write("\n", "utf8", settle)
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
