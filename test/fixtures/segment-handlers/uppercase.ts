// SPDX-FileCopyrightText: Sister Software
// SPDX-License-Identifier: MIT

const dec = new TextDecoder()

export function handleRecord(bytes: Uint8Array) {
	const s = dec.decode(bytes)

	return s.length ? s.toUpperCase() : undefined
}
