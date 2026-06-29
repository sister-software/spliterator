/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

export type SegmentHandler = (
	record: Uint8Array,
	ctx: { index: number; segmentIndex: number }
) => unknown | Promise<unknown>

export interface RunSegmentIO {
	records: AsyncIterable<Uint8Array>
	handleRecord: SegmentHandler
	segmentIndex: number
	batchSize: number
	maxInFlight: number
	post: (batch: unknown[], transfer: ArrayBuffer[]) => void
	waitForAck: () => Promise<void>
	inFlight: () => number
}

/**
 * Drive one segment: read records, run the handler, accumulate results into `batchSize` batches, transfer `Uint8Array`
 * result buffers zero-copy, and respect a bounded in-flight window by awaiting an ack before exceeding `maxInFlight`
 * outstanding batches. Results of `undefined` are skipped (the filter case). Transport-agnostic so it unit-tests
 * without `worker_threads`.
 */
export async function runSegment(io: RunSegmentIO): Promise<void> {
	let batch: unknown[] = []
	let transfer: ArrayBuffer[] = []
	let index = 0

	const flush = async (): Promise<void> => {
		if (batch.length === 0) return

		while (io.inFlight() >= io.maxInFlight) await io.waitForAck()

		io.post(batch, transfer)
		batch = []
		transfer = []
	}

	for await (const record of io.records) {
		const result = await io.handleRecord(record, { index, segmentIndex: io.segmentIndex })
		index++

		if (result === undefined) continue

		batch.push(result)

		if (result instanceof Uint8Array) transfer.push(result.buffer as ArrayBuffer)

		if (batch.length >= io.batchSize) await flush()
	}

	await flush()
}
