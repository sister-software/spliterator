/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

export interface MinimalWorker {
	on(event: "message", cb: (msg: unknown) => void): void
	on(event: "error", cb: (err: Error) => void): void
}

type WorkerMessage<R> = { type: "batch"; records: R[] } | { type: "done" } | { type: "error"; message: string }

/**
 * Drain a worker's batched messages into an async iterator. Listeners attach **eagerly** (messages posted before
 * iteration starts are buffered, not lost) and draining uses a `batches[] + head` pointer (no `Array.shift()`).
 * `onBatchConsumed` fires once per batch after its records are yielded — the ack hook for backpressure. An `error`
 * message or worker `error` rejects the iterator.
 */
export function workerToIterable<R>(worker: MinimalWorker, onBatchConsumed: () => void): AsyncIterableIterator<R> {
	const batches: R[][] = []
	let head = 0
	let done = false
	let error: Error | undefined
	let wake: (() => void) | undefined

	const signal = () => {
		wake?.()
		wake = undefined
	}

	worker.on("message", (msg) => {
		const m = msg as WorkerMessage<R>

		if (m.type === "batch") batches.push(m.records)
		else if (m.type === "done") done = true
		else if (m.type === "error") {
			error = new Error(m.message)
			done = true
		}

		signal()
	})

	worker.on("error", (err) => {
		error = err
		done = true
		signal()
	})

	async function* drain(): AsyncIterableIterator<R> {
		for (;;) {
			if (head < batches.length) {
				const batch = batches[head++]!

				for (const record of batch) yield record

				onBatchConsumed()
				continue
			}

			if (error) throw error
			if (done) return

			await new Promise<void>((resolve) => (wake = resolve))
		}
	}

	return drain()
}
