/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

const dec = new TextDecoder()

export function handleRecord(bytes: Uint8Array) {
	const s = dec.decode(bytes)

	return s.length ? s.toUpperCase() : undefined
}
