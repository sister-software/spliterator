// SPDX-FileCopyrightText: Sister Software
// SPDX-License-Identifier: MIT

const enc = new TextEncoder()

export function handleItem(x: number) {
	// Drop odds (filter); evens map to their decimal string as bytes (transferred).
	if (x % 2 !== 0) return undefined

	return enc.encode(String(x))
}
