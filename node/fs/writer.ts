/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { open } from "node:fs/promises"
import type { CreateWriteStreamOptions } from "node:fs/promises"
import type { Writable } from "node:stream"
import { WritableStream } from "node:stream/web"

/**
 * Create a writable stream from a file system destination.
 */
export async function createFileWritableStream(
	destination: unknown,
	options: CreateWriteStreamOptions = {}
): Promise<WritableStream> {
	let nodeWriteStream: Writable

	if (typeof destination !== "string" || !destination) {
		nodeWriteStream = process.stdout
	} else {
		const handle = await open(destination, "w")
		nodeWriteStream = handle.createWriteStream({ autoClose: true, ...options })
	}

	nodeWriteStream.once("error", (error) => {
		console.error("Failed to write to the destination stream:", error)

		process.exit(1)
	})

	return new WritableStream({
		async write(chunk) {
			if (nodeWriteStream.write(chunk)) return

			return new Promise((resolve) => {
				nodeWriteStream.once("drain", resolve)
			})
		},

		async abort(reason) {
			return new Promise((resolve, reject) => {
				if ("destroy" in nodeWriteStream) {
					nodeWriteStream.destroy(reason)
				}

				nodeWriteStream.once("error", reject)
				nodeWriteStream.once("close", resolve)
			})
		},

		async close() {
			return new Promise((resolve, reject) => {
				nodeWriteStream.end()
				nodeWriteStream.once("error", reject)
				nodeWriteStream.once("finish", resolve)
			})
		},
	})
}
