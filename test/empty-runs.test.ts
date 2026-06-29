/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 *
 * A long run of consecutive delimiters enqueues many empty ranges in a single fill
 * (empty ranges don't count toward the high-water mark). With `skipEmpty`, the engine
 * must skip them without recursing once per range, or it overflows the stack.
 */

import { AsyncSpliterator, Spliterator } from "spliterator"
import { describe, expect, test } from "vitest"

const RUN = 200_000

describe("long runs of empty fields", () => {
	test("sync: skipEmpty drops a huge delimiter run without overflowing", () => {
		const buf = new Uint8Array(RUN).fill(10) // RUN newlines => RUN empty fields

		const rows = Spliterator.fromSync(buf, { skipEmpty: true }).toArray()

		expect(rows).toHaveLength(0)
	})

	test("async: skipEmpty drops a huge delimiter run without overflowing", async () => {
		const buf = new Uint8Array(RUN).fill(10)
		async function* source() {
			yield buf
		}

		const spliterator = new AsyncSpliterator(source(), { skipEmpty: true })
		const rows = await spliterator.toArray()

		expect(rows).toHaveLength(0)
	})

	// An all-empty source must match String.split semantics on both sides of skipEmpty:
	// dropped entirely when skipping, or one empty field per delimiter (+1) when not.
	test("an all-delimiter buffer matches String.split", () => {
		const text = "\n\n\n"
		const buf = new TextEncoder().encode(text)

		const kept = Spliterator.fromSync(buf, { skipEmpty: false }).toDecodedArray()
		expect(kept).toEqual(text.split("\n")) // ["", "", "", ""]

		const skipped = Spliterator.fromSync(buf, { skipEmpty: true }).toArray()
		expect(skipped).toHaveLength(0)
	})
})
