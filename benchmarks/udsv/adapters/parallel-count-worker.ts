/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 *
 * Worker half of `spliterator-parallel-count.ts`. Counts the quote-aware, CRLF-normalized logical rows of one byte
 * range — the same row semantics as `CSVSpliterator.countAsync`'s streaming branch — and posts a single number back,
 * so a segment of any size costs one message. The WASM scanner is warmed once at module load; workers persist across
 * the harness's timing cycles.
 */

import { parentPort } from "node:worker_threads"

import { AsyncSpliterator, CharacterSequence } from "spliterator"
import { createChunkIterator } from "spliterator/node/fs"

export interface CountRowsRequest {
	source: string
	/**
	 * Range start byte.
	 */
	start: number
	/**
	 * Range end byte, exclusive — one past the delimiter that closed the previous record.
	 */
	end: number
}

export interface CountRowsReply {
	rows?: number
	error?: string
}

const scannerReady = CharacterSequence.whenReady()

parentPort!.on("message", async (request: CountRowsRequest) => {
	const reply = (message: CountRowsReply) => parentPort!.postMessage(message)

	try {
		await scannerReady

		const chunks = await createChunkIterator(request.source, {
			start: request.start,
			end: request.end - 1,
		})

		await using engine = new AsyncSpliterator(chunks, {
			crlf: true,
			enableQuoteHandling: true,
		})

		let rows = 0

		for await (const _row of engine) {
			rows++
		}

		reply({ rows })
	} catch (error) {
		reply({ error: error instanceof Error ? error.message : String(error) })
	}
})
