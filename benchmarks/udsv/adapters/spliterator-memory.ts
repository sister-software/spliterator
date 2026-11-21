// SPDX-FileCopyrightText: Sister Software
// SPDX-License-Identifier: MIT

/**
 * UDSV bench adapter: parse an in-memory string into string arrays. Mirrors `non-streaming/untyped/uDSV.cjs` there.
 */

import { CharacterSequence, CSVSpliterator } from "spliterator"

export const name = "spliterator"
export const repo = "https://github.com/sister-software/spliterator"

export async function load() {
	await CharacterSequence.whenReady()

	return (csvStr: string) =>
		Promise.resolve(CSVSpliterator.from(csvStr, { mode: "array", header: false, trim: false }).toArray())
}
