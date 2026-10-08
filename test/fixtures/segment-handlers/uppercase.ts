/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

const dec = new TextDecoder()

export function handleRecord(bytes: Uint8Array) {
	const s = dec.decode(bytes)

	return s.length ? s.toUpperCase() : undefined
}
