/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { read as readRange } from "node:fs"
import { open as openHandle } from "node:fs/promises"
import { type AsyncDataResource, type FileHandleLike, type TypedArray, isFileHandleLike } from "../shared.js"

export async function open(resource: AsyncDataResource, flags = "r"): Promise<FileHandleLike> {
	if (isFileHandleLike(resource)) return resource

	return openHandle(resource, flags)
}

/**
 * Given a file handle and a range of bytes, read the range into a buffer.
 *
 * @param fileHandle The file handle to read from.
 * @param position The initial byte position to start reading from.
 * @param end The ending byte index.
 * @param destination A buffer to write the data to. If not provided, a new buffer will be created.
 */
export function read<Destination extends TypedArray = Uint8Array>(
	fileHandle: FileHandleLike,
	position: number,
	end: number,
	destination?: Destination
): Promise<Destination> {
	const length = end - position

	if (length <= 0) {
		throw new Error(`Invalid range length ${length}. Start: ${position}, End: ${end}`)
	}

	destination ||= new Uint8Array(length) as Destination

	return new Promise((resolve, reject) => {
		readRange(
			// ---
			fileHandle.fd,
			destination,
			0,
			length,
			position,
			(error) => {
				if (error) {
					reject(error)
				} else {
					resolve(destination)
				}
			}
		)
	})
}
