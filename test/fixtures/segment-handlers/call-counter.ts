/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 *
 * Top-level state, to observe that a pooled worker imports the handler once and keeps it across
 * calls — the documented difference from the spawn-per-call path.
 */

let records = 0

/** @param {Uint8Array} bytes */
export function handleRecord(bytes) {
	if (!bytes.length) return undefined

	records++

	return records
}
