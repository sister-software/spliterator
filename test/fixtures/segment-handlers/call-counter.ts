/**
 * @license MIT
 * @author Teffen Ellis, et al. Top-level state, to observe that a pooled worker imports the handler once and keeps it
 *   across calls — the documented difference from the spawn-per-call path.
 * @copyright Sister Software
 */

let records = 0

export function handleRecord(bytes: Uint8Array) {
	if (!bytes.length) return undefined

	records++

	return records
}
