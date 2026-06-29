/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

const dec = new TextDecoder()

/** @param {Uint8Array} bytes */
export function handleRecord(bytes) {
	const s = dec.decode(bytes)

	return s.length ? s.toUpperCase() : undefined
}
