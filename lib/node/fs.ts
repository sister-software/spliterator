/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { read, type PathLike } from "node:fs"
import { open } from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { isFileHandleLike, StatsLike, type FileHandleLike, type FileResourceLike } from "../shared.js"

export interface NodeFileResourceInit {
	name?: string
	type?: string
	position?: number
	byteLength?: number
	lastModified?: number
}

/**
 * An isomorphic file resource which can be read from and disposed.
 */
export class NodeFileResource implements FileResourceLike, AsyncDisposable {
	readonly #handle: FileHandleLike

	/**
	 * The last modified timestamp of the file.
	 */
	public readonly lastModified: number
	/**
	 * The name of the file.
	 */
	public readonly name: string
	/**
	 * @deprecated This property is not supported in Node.js.
	 */
	public readonly webkitRelativePath = ""

	/**
	 * The byte length of the file.
	 */
	readonly #byteLength: number

	/**
	 * The byte length of the file.
	 *
	 * Alias for {@linkcode #byteLength}.
	 */
	public get size(): number {
		return this.#byteLength
	}

	/**
	 * The byte position of the file.
	 */
	readonly #position: number
	public readonly type: string

	constructor(handle: FileHandleLike, init: NodeFileResourceInit) {
		this.#handle = handle

		this.lastModified = init.lastModified ?? Date.now()
		this.name = init.name ?? ""
		this.#position = init.position ?? 0
		this.#byteLength = (init.byteLength ?? 0) - this.#position
		this.type = init.type ?? ""
	}

	/**
	 * Read the entire file as a byte array.
	 *
	 * @see {@linkcode slice} to create a sliced view of the file.
	 * @see {@linkcode arrayBuffer} to read the file as an array buffer.
	 */
	public async bytes(): Promise<Uint8Array> {
		const buffer = new Uint8Array(this.#byteLength)

		await new Promise<void>((resolve, reject) =>
			read(
				this.#handle.fd,
				{
					buffer,
					position: this.#position,
				},
				(error: unknown) => {
					if (error) reject(error)
					else resolve()
				}
			)
		)

		return buffer
	}

	/**
	 * Read the entire file as an array buffer.
	 *
	 * @see {@linkcode slice} to create a sliced view of the file.
	 * @see {@linkcode bytes} to read the file as a byte array.
	 */
	public arrayBuffer(): Promise<ArrayBuffer> {
		return this.bytes().then((bytes) => bytes.buffer)
	}

	/**
	 * Slice the file into a new file resource.
	 *
	 * Note that the slice is a view of the original file, thus we're really just creating a new file
	 * resource with a different byte range.
	 *
	 * @param start - The starting byte offset.
	 * @param end - The ending byte offset.
	 * @param contentType - The content type of the slice.
	 *
	 * @returns A new file resource representing the sliced view of the file.
	 */
	public slice(start?: number, end?: number, contentType?: string): NodeFileResource {
		start = start ?? 0
		end = end ?? this.#byteLength

		const byteLength = Math.max(0, end - start)

		return new NodeFileResource(this.#handle, {
			name: this.name,
			type: contentType ?? this.type,
			position: this.#position + start,
			byteLength,
			lastModified: this.lastModified,
		})
	}

	/**
	 * Read the entire file as a string.
	 */
	public async text(): Promise<string> {
		const buffer = await this.bytes()
		const decoder = new TextDecoder()

		return decoder.decode(buffer)
	}

	/**
	 * Create a readable stream of the file.
	 */
	public stream(): ReadableStream<Uint8Array> {
		return this.#handle.readableWebStream() as unknown as ReadableStream<Uint8Array>
	}

	public async [Symbol.asyncDispose](): Promise<void> {
		return this.#handle.close()
	}

	public dispose(): Promise<void> {
		return this.#handle.close()
	}

	/**
	 * Create a new file resource from a file handle or path.
	 */
	static async open(
		input: FileHandleLike | PathLike,
		stats?: StatsLike,
		init: NodeFileResourceInit = {}
	): Promise<NodeFileResource> {
		const handle = isFileHandleLike(input) ? input : await open(input, "r")

		stats = stats ?? (await handle.stat())

		const name = init.name ?? path.basename(fileURLToPath(input.toString()))

		return new NodeFileResource(handle, {
			lastModified: stats.mtimeMs,
			byteLength: stats.size,
			...init,
			name,
		})
	}
}

export default NodeFileResource
