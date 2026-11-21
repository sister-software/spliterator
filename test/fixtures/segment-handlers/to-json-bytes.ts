// SPDX-FileCopyrightText: Sister Software
// SPDX-License-Identifier: MIT

const dec = new TextDecoder()
const enc = new TextEncoder()

export function handleRecord(bytes: Uint8Array) {
	const s = dec.decode(bytes)

	if (!s.length) return undefined

	return enc.encode(JSON.stringify({ line: s }) + "\n") // Uint8Array → transferred zero-copy
}
