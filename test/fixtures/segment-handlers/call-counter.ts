// SPDX-FileCopyrightText: Sister Software
// SPDX-License-Identifier: MIT

/**
 * Top-level counter for tests. Pooled workers keep this value between calls. Spawn-per-call workers reset it each time.
 */

let records = 0

export function handleRecord(bytes: Uint8Array) {
	if (!bytes.length) return undefined

	records++

	return records
}
