/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

const dec = new TextDecoder()
const enc = new TextEncoder()

/** @param {Uint8Array} bytes */
export function handleRecord(bytes) {
	const s = dec.decode(bytes)

	if (!s.length) return undefined

	return enc.encode(JSON.stringify({ line: s }) + "\n") // Uint8Array → transferred zero-copy
}
