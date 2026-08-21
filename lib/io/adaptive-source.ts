/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { CharacterSequence } from "../core/CharacterSequence.js"
import { type AsyncSpliteratorInit, Spliterator } from "../core/Spliterator.js"
import type { AsyncChunkIterator, AsyncDataResource } from "../internal/shared.js"

/**
 * Byte length at or below which a source is read whole and parsed synchronously.
 *
 * What this buys is **fixed setup cost** — opening a handle and standing up a read stream, ~100µs — not throughput, so
 * the win decays as the source grows and the threshold marks where it stops being measurable. End-to-end against the
 * streaming path (Node 26, min of 200 runs, two independent sweeps): ~1.85× at 635B, ~1.45× at 6.5KB, ~1.4× at 125KiB.
 * At 253KiB and above the two runs disagreed on which was faster, so there is nothing reliable left to win.
 *
 * Raising this does not recover the much larger gap a raw synchronous parse shows (~1.6× even at 1GiB); that gap is
 * eaten by the per-row cost of the sequence itself, which both paths pay. It only trades resident memory — a 1GiB
 * source costs ~105MB streamed against ~1121MB read whole — for a difference that no longer measures.
 */
export const DEFAULT_BULK_THRESHOLD = 128 * 1024

export interface AdaptiveSourceInit extends AsyncSpliteratorInit {
	/**
	 * Byte length at or below which the whole source is read into memory and parsed synchronously, trading resident
	 * memory for speed.
	 *
	 * Raising it buys nothing measurable and costs memory linearly — the advantage is gone by ~256KiB. Set `0` to always
	 * stream, which is what you want when a bounded footprint is the reason you reached for this library.
	 *
	 * @default 128 KiB ({@linkcode DEFAULT_BULK_THRESHOLD})
	 */
	bulkThreshold?: number
}

function isChunkIterator(source: unknown): source is AsyncChunkIterator {
	return typeof source === "object" && source !== null && Symbol.asyncIterator in source
}

function toBytes(chunk: Uint8Array | string): Uint8Array {
	return typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk
}

/**
 * Parse in-memory bytes with the synchronous engine.
 *
 * Awaiting {@linkcode CharacterSequence.whenReady} first is the point: the WASM scanner loads asynchronously, so a
 * synchronous caller normally completes before it is available and silently uses the JS scanner. Reaching the sync
 * engine through an async path is the one place that can be avoided — worth ~26% on a large source.
 */
async function bulk(bytes: Uint8Array, init: AdaptiveSourceInit): Promise<Iterable<Uint8Array>> {
	await CharacterSequence.whenReady()

	return Spliterator.fromSync(bytes, init)
}

/**
 * Take the delimited rows of `source`, reading it whole when it is small enough to be worth the memory and streaming it
 * otherwise. Returns a sync iterable in the first case and an async one in the second; both satisfy
 * {@linkcode AsyncSequence}.
 */
export async function openDelimitedRows(
	source: AsyncDataResource | AsyncChunkIterator,
	init: AdaptiveSourceInit = {}
): Promise<AsyncIterable<Uint8Array> | Iterable<Uint8Array>> {
	const threshold = init.bulkThreshold ?? DEFAULT_BULK_THRESHOLD

	if (threshold <= 0) return Spliterator.fromAsync(source, init)

	if (isChunkIterator(source)) return openChunkIterator(source, threshold, init)

	let size: number

	try {
		const { readFileSize } = await import("spliterator/node/fs")

		size = await readFileSize(source)
	} catch {
		// Unsized or unreachable by the Node adapter — the streaming path owns reporting why.
		return Spliterator.fromAsync(source, init)
	}

	if (size > threshold) return Spliterator.fromAsync(source, init)

	const { readBytes } = await import("spliterator/node/fs")

	return bulk(await readBytes(source, 0, size), init)
}

/**
 * A stream cannot be measured before it is read, so the size test becomes an end-of-input test: pull one chunk, and if
 * the stream is already exhausted the whole input is in hand and no threshold policy is needed.
 *
 * When it is not exhausted the pulled chunks cannot be discarded, so the stream is re-headed with them in front.
 */
async function openChunkIterator(
	source: AsyncChunkIterator,
	threshold: number,
	init: AdaptiveSourceInit
): Promise<AsyncIterable<Uint8Array> | Iterable<Uint8Array>> {
	const iterator = source[Symbol.asyncIterator]()
	const first = await iterator.next()

	if (first.done) return bulk(new Uint8Array(0), init)

	const second = await iterator.next()
	const head = toBytes(first.value)

	if (second.done && head.byteLength <= threshold) return bulk(head, init)

	const pulled: Array<Uint8Array | string> = second.done ? [first.value] : [first.value, second.value]

	const reheaded: AsyncChunkIterator = {
		async *[Symbol.asyncIterator]() {
			yield* pulled

			for (;;) {
				const next = await iterator.next()

				if (next.done) return

				yield next.value
			}
		},
	}

	if (Symbol.asyncDispose in source) {
		reheaded[Symbol.asyncDispose] = () => source[Symbol.asyncDispose]!()
	}

	return Spliterator.fromAsync(reheaded, init)
}
