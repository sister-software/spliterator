/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

const dec = new TextDecoder()

/**
 * Slow enough that an early break leaves work outstanding.
 */
export async function handleRecord(bytes: Uint8Array) {
	await new Promise((resolve) => {
		setTimeout(resolve, 1)
	})

	return dec.decode(bytes)
}
