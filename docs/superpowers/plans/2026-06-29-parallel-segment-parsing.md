# Parallel Segment Parsing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delegate one large file's read+parse+transform to worker threads — each worker owns a handle to a delimiter-aligned segment — streaming handler results back to the main thread as a single async iterator for a single-thread writer.

**Architecture:** Three layers. (1) `node/fs` gains an `end` bound and `readBytes`. (2) `AsyncSpliterator.segments` computes delimiter-aligned `[start,end)` ranges. (3) `asMany` returns one `AsyncSpliterator` per segment (shared event loop); `asManyWorkers` spawns one Worker per segment running a user handler module, with chunked batching, bounded in-flight ack backpressure, and zero-copy `Uint8Array` transfer.

**Tech Stack:** TypeScript (ESM, `"type": "module"`), `node:worker_threads`, `node:fs/promises`, vitest. Tests import the library via the package name `spliterator` (resolves to `out/`), so `yarn test` compiles first.

## Global Constraints

- ESM only; `.js` extensions on all relative imports. Node ≥ 20.18.1.
- `node/fs` is dynamically imported from core (`import("spliterator/node/fs")`) so the library stays isomorphic — never statically import it from `lib/`.
- `CreateChunkIteratorOptions.end` is **inclusive** (Node `createReadStream` semantics); to read `[start, end)` pass `{ start, end: end - 1 }`.
- Tests run with `yarn test --run <file>`; never bare `vitest` (watch mode).
- Lint must stay green: `yarn lint` (oxlint + oxfmt). Tabs for indentation; run `yarn exec oxfmt <files>` before committing.
- `ByteRange` is `[start: number, end: number]` (half-open) from `lib/shared.js`.
- Defaults: `probeSize` 65536, `batchSize` 256, `maxInFlight` 4, `delimiter` LineFeed.

---

### Task 1: `createChunkIterator` `end` bound

**Files:**

- Modify: `node/fs/index.ts` (`CreateChunkIteratorOptions`, `createChunkIterator`)
- Test: `test/node-fs.test.ts` (create)

**Interfaces:**

- Produces: `CreateChunkIteratorOptions.end?: number` (inclusive); `createChunkIterator(source, { start, end, highWaterMark })` reads only `[start, end]`.

- [ ] **Step 1: Write the failing test**

```ts
// test/node-fs.test.ts
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createChunkIterator } from "spliterator/node/fs"
import { afterAll, describe, expect, test } from "vitest"

const dir = mkdtempSync(join(tmpdir(), "spliterator-fs-"))
const file = join(dir, "abc.txt")
writeFileSync(file, "0123456789")

afterAll(async () => {
	const { rm } = await import("node:fs/promises")
	await rm(dir, { recursive: true, force: true })
})

async function collect(it: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
	const parts: Uint8Array[] = []
	for await (const c of it) parts.push(c)
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
	let o = 0
	for (const p of parts) {
		out.set(p, o)
		o += p.length
	}
	return out
}

describe("createChunkIterator end bound", () => {
	test("reads only [start, end] inclusive", async () => {
		const it = await createChunkIterator(file, { start: 2, end: 5 })
		const bytes = await collect(it)
		expect(new TextDecoder().decode(bytes)).toBe("2345")
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test --run test/node-fs.test.ts`
Expected: FAIL — reads "23456789" (end ignored), not "2345".

- [ ] **Step 3: Add the `end` option and pass it through**

In `node/fs/index.ts`, add to `CreateChunkIteratorOptions`:

```ts
	/**
	 * The byte position to stop reading at, **inclusive** (matches Node `createReadStream({ end })`).
	 * To read the half-open range `[start, end)`, pass `{ start, end: end - 1 }`.
	 */
	end?: number
```

Change the destructuring and the path branch:

```ts
	{ highWaterMark = 4096 * 16, start = 0, end }: CreateChunkIteratorOptions = {}
```

```ts
const readStream = handle.createReadStream({
	start,
	end,
	highWaterMark,
	autoClose: true,
})
```

And the file-handle branch (`source.createReadStream`):

```ts
return source.createReadStream({
	start,
	end,
	highWaterMark,
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test --run test/node-fs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
yarn exec oxfmt node/fs/index.ts test/node-fs.test.ts
git add node/fs/index.ts test/node-fs.test.ts
git commit -m "feat(node/fs): inclusive end bound on createChunkIterator"
```

---

### Task 2: `readBytes`

**Files:**

- Modify: `node/fs/index.ts`
- Test: `test/node-fs.test.ts`

**Interfaces:**

- Produces: `readBytes(source: AsyncDataResource, start: number, length: number): Promise<Uint8Array>` — random-access window read, EOF-clamped (returns fewer than `length` bytes at EOF).

- [ ] **Step 1: Write the failing test**

```ts
// add to test/node-fs.test.ts
import { readBytes } from "spliterator/node/fs"

describe("readBytes", () => {
	test("reads a window from an offset", async () => {
		const bytes = await readBytes(file, 3, 4)
		expect(new TextDecoder().decode(bytes)).toBe("3456")
	})

	test("clamps at EOF", async () => {
		const bytes = await readBytes(file, 8, 100) // file is 10 bytes
		expect(new TextDecoder().decode(bytes)).toBe("89")
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test --run test/node-fs.test.ts`
Expected: FAIL — `readBytes` is not exported.

- [ ] **Step 3: Implement `readBytes`**

Add to `node/fs/index.ts` (uses the already-imported `open`):

```ts
/**
 * Read a fixed-length window of bytes from `start`. The result is EOF-clamped, so it may be shorter
 * than `length`. Used for delimiter-boundary probing.
 *
 * @internal
 */
export async function readBytes(source: AsyncDataResource, start: number, length: number): Promise<Uint8Array> {
	if (typeof source !== "string" && !(source instanceof URL) && !isFileHandleLike(source)) {
		throw new TypeError("readBytes requires a file path, URL, or file handle.")
	}

	const handle = isFileHandleLike(source) ? source : await open(source, "r")

	try {
		const buffer = new Uint8Array(length)
		const { bytesRead } = await handle.read(buffer, 0, length, start)

		return buffer.subarray(0, bytesRead)
	} finally {
		// Only close handles we opened.
		if (!isFileHandleLike(source)) await handle.close()
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test --run test/node-fs.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
yarn exec oxfmt node/fs/index.ts test/node-fs.test.ts
git add node/fs/index.ts test/node-fs.test.ts
git commit -m "feat(node/fs): readBytes window read for boundary probing"
```

---

### Task 3: AsyncSpliterator fd-leak fix on early termination

**Files:**

- Modify: `lib/AsyncSpliterator.ts` (`#finalize`, `return`, `[Symbol.asyncDispose]`)
- Test: `test/AsyncSpliterator.dispose.test.ts` (create)

**Interfaces:**

- Consumes: existing `#chunkReader: AsyncIterator<Uint8Array>`.
- Produces: `return()` / `[Symbol.asyncDispose]()` propagate cancellation to the chunk reader via `#chunkReader.return?.()`, so an early `break` destroys the underlying read stream (closing its fd) instead of leaking it.

- [ ] **Step 1: Write the failing test**

```ts
// test/AsyncSpliterator.dispose.test.ts
import { AsyncSpliterator } from "spliterator"
import { describe, expect, test } from "vitest"

/** A fake chunk source whose iterator records whether `return()` was called (cancellation). */
function spySource(chunks: Uint8Array[]) {
	const state = { returned: false }
	const source = {
		[Symbol.asyncIterator]() {
			let i = 0
			return {
				next: async () => (i < chunks.length ? { value: chunks[i++]!, done: false } : { value: undefined, done: true }),
				return: async () => {
					state.returned = true
					return { value: undefined, done: true as const }
				},
			}
		},
	}
	return { source, state }
}

describe("AsyncSpliterator early termination", () => {
	test("propagates cancellation to the chunk reader on early return", async () => {
		const enc = new TextEncoder()
		const { source, state } = spySource([enc.encode("a\nb\nc\nd\n")])
		const spliterator = new AsyncSpliterator(source as never, { delimiter: "\n" })

		for await (const _ of spliterator) break // consume one, then bail

		await spliterator.return()
		expect(state.returned).toBe(true)
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test --run test/AsyncSpliterator.dispose.test.ts`
Expected: FAIL — `state.returned` is `false` (cancellation never propagated).

- [ ] **Step 3: Propagate cancellation**

In `lib/AsyncSpliterator.ts`, add a private helper and call it from `#finalize` and `[Symbol.asyncDispose]`. Add near the other private methods:

```ts
	/** Signal the underlying chunk reader to stop, destroying an owned read stream (closing its fd). */
	async #closeReader(): Promise<void> {
		try {
			await this.#chunkReader.return?.()
		} catch {
			// The reader may already be closed; ignore.
		}
	}
```

In `#finalize()`, before the `autoDispose` block, add:

```ts
await this.#closeReader()
```

In `[Symbol.asyncDispose]()`, before the `autoDispose` block, add:

```ts
await this.#closeReader()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test --run test/AsyncSpliterator.dispose.test.ts`
Expected: PASS. Also run the full suite to confirm no regression: `yarn test --run`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
yarn exec oxfmt lib/AsyncSpliterator.ts test/AsyncSpliterator.dispose.test.ts
git add lib/AsyncSpliterator.ts test/AsyncSpliterator.dispose.test.ts
git commit -m "fix(async): destroy chunk reader on early termination (fd leak)"
```

---

### Task 4: `computeSegments` boundary detection

**Files:**

- Create: `lib/segments.ts`
- Modify: `index.ts` (export)
- Test: `test/segments.test.ts` (create)

**Interfaces:**

- Consumes: `readFileSize`, `readBytes` (dynamic `import("spliterator/node/fs")`); `CharacterSequence`; `ByteRange`.
- Produces: `computeSegments(source: AsyncDataResource, options: { delimiter?: CharacterSequenceInput; concurrency: number; probeSize?: number }): Promise<ByteRange[]>` — contiguous, delimiter-aligned, ≤ concurrency, covering `[0, fileSize]`; `[]` for an empty file.

- [ ] **Step 1: Write the failing test**

```ts
// test/segments.test.ts
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { computeSegments, Spliterator } from "spliterator"
import { afterAll, describe, expect, test } from "vitest"

const dir = mkdtempSync(join(tmpdir(), "spliterator-seg-"))
afterAll(async () => (await import("node:fs/promises")).rm(dir, { recursive: true, force: true }))

function fixture(name: string, text: string): string {
	const p = join(dir, name)
	writeFileSync(p, text)
	return p
}

/** Records of the whole file, parsed sequentially (the oracle). */
function sequentialRecords(text: string): string[] {
	return Spliterator.fromSync(new TextEncoder().encode(text), { skipEmpty: false }).toDecodedArray()
}

/** Records reconstructed by concatenating each segment's parse. */
function recordsFromSegments(text: string, segments: Array<[number, number]>): string[] {
	const bytes = new TextEncoder().encode(text)
	const out: string[] = []
	for (const [start, end] of segments) {
		out.push(...Spliterator.fromSync(bytes.subarray(start, end), { skipEmpty: false }).toDecodedArray())
	}
	return out
}

describe("computeSegments", () => {
	test("segments are contiguous and cover the whole file", async () => {
		const text = Array.from({ length: 1000 }, (_, i) => `row-${i}`).join("\n") + "\n"
		const p = fixture("rows.txt", text)

		const segments = await computeSegments(p, { delimiter: "\n", concurrency: 4 })

		expect(segments[0]![0]).toBe(0)
		expect(segments.at(-1)![1]).toBe(text.length)
		for (let i = 1; i < segments.length; i++) expect(segments[i]![0]).toBe(segments[i - 1]![1])
	})

	test("every internal boundary sits right after a delimiter (no split records)", async () => {
		const text = Array.from({ length: 1000 }, (_, i) => `row-${i}`).join("\n") + "\n"
		const p = fixture("rows2.txt", text)

		const segments = await computeSegments(p, { delimiter: "\n", concurrency: 7 })
		// Reconstructed records (minus the trailing empty each segment may carry) equal the oracle.
		const oracle = sequentialRecords(text).filter((r) => r.length > 0)
		const got = recordsFromSegments(text, segments).filter((r) => r.length > 0)
		expect(got).toEqual(oracle)
	})

	test("concurrency 1 yields a single full-file segment", async () => {
		const p = fixture("one.txt", "a\nb\nc\n")
		expect(await computeSegments(p, { delimiter: "\n", concurrency: 1 })).toEqual([[0, 6]])
	})

	test("empty file yields no segments", async () => {
		const p = fixture("empty.txt", "")
		expect(await computeSegments(p, { delimiter: "\n", concurrency: 4 })).toEqual([])
	})

	test("a record longer than probeSize collapses its boundary, never splitting it", async () => {
		const long = "x".repeat(5000)
		const text = `${long}\n${long}\n`
		const p = fixture("long.txt", text)

		const segments = await computeSegments(p, { delimiter: "\n", concurrency: 4, probeSize: 1024 })
		const got = recordsFromSegments(text, segments).filter((r) => r.length > 0)
		expect(got).toEqual([long, long])
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test --run test/segments.test.ts`
Expected: FAIL — `computeSegments` is not exported.

- [ ] **Step 3: Implement `computeSegments`**

```ts
// lib/segments.ts
/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { CharacterSequence, type CharacterSequenceInput } from "./CharacterSequence.js"
import type { AsyncDataResource, ByteRange } from "./shared.js"

export interface SegmentOptions {
	/** The record delimiter. @default LineFeed */
	delimiter?: CharacterSequenceInput
	/** Desired number of segments. Clamped to ≥ 1; the result may be fewer. */
	concurrency: number
	/** Bytes read at each ideal boundary to find the next delimiter. @default 65536 */
	probeSize?: number
}

/**
 * Divide `source` into up to `concurrency` delimiter-aligned byte ranges. Each internal boundary is
 * placed immediately after the first delimiter at or past the ideal cut, so concatenating each
 * segment's records reproduces the file exactly — no record is split or duplicated.
 */
export async function computeSegments(source: AsyncDataResource, options: SegmentOptions): Promise<ByteRange[]> {
	const { readFileSize, readBytes } = await import("spliterator/node/fs")
	const needle = new CharacterSequence(options.delimiter)
	const probeSize = options.probeSize ?? 65536
	const concurrency = Math.max(1, Math.floor(options.concurrency))

	const fileSize = await readFileSize(source)

	if (fileSize === 0) return []
	if (concurrency === 1) return [[0, fileSize]]

	// Probe each ideal cut in parallel; resolve to the aligned cut (just past the next delimiter) or
	// null when the probe window held no delimiter (a record longer than probeSize → cut collapses).
	const idealCuts = Array.from({ length: concurrency - 1 }, (_, i) => Math.round(((i + 1) * fileSize) / concurrency))

	const alignedCuts = await Promise.all(
		idealCuts.map(async (cut) => {
			if (cut <= 0 || cut >= fileSize) return null
			const window = await readBytes(source, cut, probeSize)
			const index = needle.search(window, 0, window.length)
			if (index === -1) return null
			return cut + index + needle.length
		})
	)

	const boundaries = new Set<number>([0, fileSize])
	for (const cut of alignedCuts) {
		if (cut !== null && cut > 0 && cut < fileSize) boundaries.add(cut)
	}

	const sorted = Array.from(boundaries).sort((a, b) => a - b)
	const segments: ByteRange[] = []
	for (let i = 1; i < sorted.length; i++) {
		const start = sorted[i - 1]!
		const end = sorted[i]!
		if (end > start) segments.push([start, end])
	}

	return segments
}
```

Export from `index.ts` (add a line, keep alphabetical-ish with the others):

```ts
export * from "./lib/segments.js"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test --run test/segments.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
yarn exec oxfmt lib/segments.ts test/segments.test.ts
git add lib/segments.ts index.ts test/segments.test.ts
git commit -m "feat: computeSegments delimiter-aligned boundary detection"
```

---

### Task 5: `AsyncSpliterator.segments` + `asMany`

**Files:**

- Modify: `lib/AsyncSpliterator.ts` (replace the `asMany` stub; add `segments`)
- Test: `test/asMany.test.ts` (create)

**Interfaces:**

- Consumes: `computeSegments`; `createChunkIterator` (dynamic import).
- Produces:
  - `static segments(source, options: SegmentOptions): Promise<ByteRange[]>` (delegates to `computeSegments`).
  - `static asMany(source, options: { delimiter?: CharacterSequenceInput; concurrency: number; probeSize?: number }): Promise<AsyncSpliterator[]>` — one `AsyncSpliterator` per segment.

- [ ] **Step 1: Write the failing test**

```ts
// test/asMany.test.ts
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { AsyncSpliterator, TextSpliterator } from "spliterator"
import { afterAll, describe, expect, test } from "vitest"

const dir = mkdtempSync(join(tmpdir(), "spliterator-many-"))
afterAll(async () => (await import("node:fs/promises")).rm(dir, { recursive: true, force: true }))

const text = Array.from({ length: 5000 }, (_, i) => `row-${i}-data`).join("\n") + "\n"
const file = join(dir, "rows.txt")
writeFileSync(file, text)

async function flatten(spliterators: AsyncSpliterator[]): Promise<string[]> {
	const dec = new TextDecoder()
	const out: string[] = []
	for (const s of spliterators) for await (const row of s) out.push(dec.decode(row))
	return out
}

describe("asMany", () => {
	for (const concurrency of [1, 4, 9]) {
		test(`parity with sequential parse at concurrency ${concurrency}`, async () => {
			const oracle: string[] = []
			for await (const line of TextSpliterator.fromAsync(file)) oracle.push(line)

			const spliterators = await AsyncSpliterator.asMany(file, { delimiter: "\n", concurrency })
			expect(spliterators.length).toBeLessThanOrEqual(concurrency)
			const got = await flatten(spliterators)
			expect(got).toEqual(oracle)
		})
	}
})
```

Note: `TextSpliterator.fromAsync` skips empty lines by default, so the trailing empty after the final `\n` is dropped on both sides — segments parity holds.

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test --run test/asMany.test.ts`
Expected: FAIL — `asMany` throws "Not implemented." (the stub).

- [ ] **Step 3: Replace the stub and add `segments`**

In `lib/AsyncSpliterator.ts`, add the import at the top:

```ts
import { computeSegments, type SegmentOptions } from "./segments.js"
```

Replace the entire `public static async asMany(...)` stub body (the `Experimental` region) with:

```ts
	/**
	 * Compute delimiter-aligned `[start, end)` byte ranges dividing `source` into up to `concurrency`
	 * segments. Hand each range to a worker (with its own handle) for parallel parsing.
	 */
	public static segments(source: AsyncDataResource, options: SegmentOptions): Promise<ByteRange[]> {
		return computeSegments(source, options)
	}

	/**
	 * Split `source` into delimiter-aligned segments and return one {@link AsyncSpliterator} per
	 * segment. All share the event loop (no worker threads). Returns ≤ `concurrency` instances.
	 */
	public static async asMany(source: AsyncDataResource, options: SegmentOptions): Promise<AsyncSpliterator[]> {
		const { createChunkIterator } = await import("spliterator/node/fs")
		const segments = await computeSegments(source, options)

		return Promise.all(
			segments.map(async ([start, end]) => {
				// `end` is exclusive here; createChunkIterator's `end` is inclusive.
				const chunkIterator = await createChunkIterator(source, { start, end: end - 1 })
				return new AsyncSpliterator(chunkIterator, { delimiter: options.delimiter, autoDispose: true })
			})
		)
	}
```

(Delete the old `asMany` body that did `if (Date.now()) throw new Error("Not implemented.")` and its now-unused locals.)

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test --run test/asMany.test.ts`
Expected: PASS (3 tests). Run `yarn test --run` to confirm no regressions.

- [ ] **Step 5: Commit**

```bash
yarn exec oxfmt lib/AsyncSpliterator.ts test/asMany.test.ts
git add lib/AsyncSpliterator.ts test/asMany.test.ts
git commit -m "feat(async): segments() + asMany() over delimiter-aligned ranges"
```

---

### Task 6: `runSegment` — the testable per-segment loop (batching, transfer, backpressure)

**Files:**

- Create: `lib/segment-runtime.ts`
- Test: `test/segment-runtime.test.ts` (create)

**Interfaces:**

- Produces:
  ```ts
  interface SegmentBatch {
  	records: unknown[]
  } // posted to main
  type Handler = (record: Uint8Array, ctx: { index: number; segmentIndex: number }) => unknown
  interface RunSegmentIO {
  	records: AsyncIterable<Uint8Array>
  	handleRecord: Handler
  	segmentIndex: number
  	batchSize: number
  	maxInFlight: number
  	post: (batch: unknown[], transfer: ArrayBuffer[]) => void // post a batch (+ transferables)
  	waitForAck: () => Promise<void> // resolves when an ack arrives
  	inFlight: () => number // unacked batches outstanding
  }
  async function runSegment(io: RunSegmentIO): Promise<void>
  ```
- `runSegment` pulls records, calls `handleRecord`, **skips `undefined` results**, accumulates `batchSize` per batch, collects `ArrayBuffer`s of any `Uint8Array` results into the transfer list, and `post`s. Before posting when `inFlight() >= maxInFlight`, it `await waitForAck()`. This isolates the protocol from `worker_threads` so it is unit-testable.

- [ ] **Step 1: Write the failing test**

```ts
// test/segment-runtime.test.ts
import { runSegment } from "spliterator/segment-runtime"
import { describe, expect, test } from "vitest"

const enc = new TextEncoder()
async function* records(n: number): AsyncIterable<Uint8Array> {
	for (let i = 0; i < n; i++) yield enc.encode(`r${i}`)
}

describe("runSegment", () => {
	test("batches results and skips undefined", async () => {
		const posted: unknown[][] = []
		await runSegment({
			records: records(5),
			handleRecord: (bytes, ctx) => (ctx.index % 2 === 0 ? new TextDecoder().decode(bytes) : undefined),
			segmentIndex: 0,
			batchSize: 2,
			maxInFlight: 99,
			post: (batch) => posted.push(batch),
			waitForAck: async () => {},
			inFlight: () => 0,
		})
		// indices 0,2,4 kept => ["r0","r2","r4"] in batches of 2 then 1
		expect(posted).toEqual([["r0", "r2"], ["r4"]])
	})

	test("adds Uint8Array result buffers to the transfer list", async () => {
		const transfers: ArrayBuffer[][] = []
		await runSegment({
			records: records(1),
			handleRecord: () => enc.encode("out"),
			segmentIndex: 0,
			batchSize: 10,
			maxInFlight: 99,
			post: (_batch, transfer) => transfers.push(transfer),
			waitForAck: async () => {},
			inFlight: () => 0,
		})
		expect(transfers[0]).toHaveLength(1)
		expect(transfers[0]![0]).toBeInstanceOf(ArrayBuffer)
	})

	test("waits for an ack when the in-flight window is full", async () => {
		const order: string[] = []
		let flight = 0
		await runSegment({
			records: records(4),
			handleRecord: (b) => new TextDecoder().decode(b),
			segmentIndex: 0,
			batchSize: 1,
			maxInFlight: 1,
			post: () => {
				flight++
				order.push("post")
			},
			waitForAck: async () => {
				flight--
				order.push("ack")
			},
			inFlight: () => flight,
		})
		// With window 1, every post after the first must be preceded by an ack.
		expect(order).toEqual(["post", "ack", "post", "ack", "post", "ack", "post"])
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test --run test/segment-runtime.test.ts`
Expected: FAIL — module `spliterator/segment-runtime` / `runSegment` not found.

- [ ] **Step 3: Implement `runSegment` and export the subpath**

```ts
// lib/segment-runtime.ts
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
 * Drive one segment: read records, run the handler, accumulate results into `batchSize` batches,
 * transfer `Uint8Array` result buffers zero-copy, and respect a bounded in-flight window by awaiting
 * an ack before exceeding `maxInFlight` outstanding batches. Transport-agnostic so it unit-tests
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
```

Add the subpath export to `package.json` `exports` (alongside `./node/fs`):

```json
		"./segment-runtime": "./out/lib/segment-runtime.js",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test --run test/segment-runtime.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
yarn exec oxfmt lib/segment-runtime.ts test/segment-runtime.test.ts
git add lib/segment-runtime.ts package.json test/segment-runtime.test.ts
git commit -m "feat: runSegment batching/transfer/backpressure loop"
```

---

### Task 7: `workerToIterable` — main-side drain

**Files:**

- Create: `lib/segment-workers.ts` (start it here; extended in Task 8)
- Test: `test/workerToIterable.test.ts` (create)

**Interfaces:**

- Produces: `workerToIterable<R>(worker: MinimalWorker, onBatchConsumed: () => void): AsyncIterableIterator<R>` where

  ```ts
  interface MinimalWorker {
  	on(event: "message", cb: (msg: unknown) => void): void
  	on(event: "error", cb: (err: Error) => void): void
  }
  ```

  Worker messages are `{ type: "batch"; records: R[] } | { type: "done" } | { type: "error"; message: string }`. Listeners attach **eagerly** at call time (not in `[Symbol.asyncIterator]`). Draining uses a `chunks[] + head` pointer (no `Array.shift()`). After all records of a batch are yielded, `onBatchConsumed()` fires (the ack hook). An `error` message or worker `error` rejects the iterator.

- [ ] **Step 1: Write the failing test**

```ts
// test/workerToIterable.test.ts
import { workerToIterable } from "spliterator/segment-workers"
import { describe, expect, test } from "vitest"

/** A fake worker we can drive by emitting messages. */
function fakeWorker() {
	const handlers: Record<string, ((arg: never) => void)[]> = { message: [], error: [] }
	return {
		on(event: "message" | "error", cb: (arg: never) => void) {
			handlers[event]!.push(cb)
		},
		emit(event: "message" | "error", arg: unknown) {
			for (const cb of handlers[event]!) cb(arg as never)
		},
	}
}

describe("workerToIterable", () => {
	test("yields batched records in order then completes on done", async () => {
		const w = fakeWorker()
		const acks: number[] = []
		const it = workerToIterable<string>(w, () => acks.push(1))

		// Emit before iteration starts — eager listeners must not drop these.
		w.emit("message", { type: "batch", records: ["a", "b"] })
		w.emit("message", { type: "batch", records: ["c"] })
		w.emit("message", { type: "done" })

		const got: string[] = []
		for await (const r of it) got.push(r)
		expect(got).toEqual(["a", "b", "c"])
		expect(acks.length).toBe(2) // one ack per consumed batch
	})

	test("rejects on an error message", async () => {
		const w = fakeWorker()
		const it = workerToIterable<string>(w, () => {})
		w.emit("message", { type: "error", message: "boom" })

		await expect(
			(async () => {
				for await (const _ of it) void _
			})()
		).rejects.toThrow("boom")
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test --run test/workerToIterable.test.ts`
Expected: FAIL — module / `workerToIterable` not found.

- [ ] **Step 3: Implement `workerToIterable` + the subpath export**

```ts
// lib/segment-workers.ts
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
 * Drain a worker's batched messages into an async iterator. Listeners attach eagerly (messages
 * posted before iteration starts are not lost). `onBatchConsumed` fires once per batch after its
 * records are yielded — the ack hook for backpressure.
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
			if (error) throw error
			if (head < batches.length) {
				const batch = batches[head++]!
				for (const record of batch) yield record
				onBatchConsumed()
				continue
			}
			if (done) {
				if (error) throw error
				return
			}
			await new Promise<void>((resolve) => (wake = resolve))
		}
	}

	return drain()
}
```

Add to `package.json` `exports`:

```json
		"./segment-workers": "./out/lib/segment-workers.js",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test --run test/workerToIterable.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
yarn exec oxfmt lib/segment-workers.ts test/workerToIterable.test.ts
git add lib/segment-workers.ts package.json test/workerToIterable.test.ts
git commit -m "feat: workerToIterable eager-listener drain with ack hook"
```

---

### Task 8: Worker entry + `asManyWorkers` end-to-end

**Files:**

- Create: `lib/segment-worker-entry.ts` (the worker-thread runner)
- Modify: `lib/segment-workers.ts` (add `runSegmentWorkers`)
- Modify: `lib/AsyncSpliterator.ts` (add `asManyWorkers`)
- Create: `test/fixtures/segment-handlers/uppercase.js` (fixture handler, plain ESM)
- Create: `test/fixtures/segment-handlers/to-json-bytes.js` (transfer-path fixture)
- Create: `test/fixtures/segment-handlers/throws.js` (error fixture)
- Test: `test/asManyWorkers.test.ts` (create)

**Interfaces:**

- Consumes: `runSegment`, `workerToIterable`, `computeSegments`, `createChunkIterator`.
- Produces: `AsyncSpliterator.asManyWorkers<R>(source, options: AsManyWorkersOptions): AsyncIterableIterator<R>` where

  ```ts
  interface AsManyWorkersOptions {
  	worker: string | URL
  	delimiter?: CharacterSequenceInput
  	concurrency: number
  	probeSize?: number
  	batchSize?: number
  	maxInFlight?: number
  	workerData?: unknown
  }
  ```

  Throws `TypeError` if `source` is not a path string or URL. Spawns one Worker per segment, merges their `workerToIterable` streams, sends an `ack` after each consumed batch, and terminates all workers on completion / error / early `return()`.

- [ ] **Step 1: Write the failing test + fixtures**

```js
// test/fixtures/segment-handlers/uppercase.js
const dec = new TextDecoder()
export function handleRecord(bytes) {
	const s = dec.decode(bytes)
	return s.length ? s.toUpperCase() : undefined
}
```

```js
// test/fixtures/segment-handlers/to-json-bytes.js
const dec = new TextDecoder()
const enc = new TextEncoder()
export function handleRecord(bytes) {
	const s = dec.decode(bytes)
	if (!s.length) return undefined
	return enc.encode(JSON.stringify({ line: s }) + "\n") // Uint8Array → transferred
}
```

```js
// test/fixtures/segment-handlers/throws.js
export function handleRecord() {
	throw new Error("handler boom")
}
```

```ts
// test/asManyWorkers.test.ts
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { AsyncSpliterator } from "spliterator"
import { afterAll, describe, expect, test } from "vitest"

const dir = mkdtempSync(join(tmpdir(), "spliterator-workers-"))
afterAll(async () => (await import("node:fs/promises")).rm(dir, { recursive: true, force: true }))

const handlerDir = fileURLToPath(new URL("./fixtures/segment-handlers/", import.meta.url))
const text = Array.from({ length: 5000 }, (_, i) => `row-${i}`).join("\n") + "\n"
const file = join(dir, "rows.txt")
writeFileSync(file, text)

describe("asManyWorkers", () => {
	test("parity with the sequential transform (results back to main)", async () => {
		const oracle = text
			.split("\n")
			.filter(Boolean)
			.map((s) => s.toUpperCase())
			.sort()

		const got: string[] = []
		for await (const r of AsyncSpliterator.asManyWorkers<string>(file, {
			worker: join(handlerDir, "uppercase.js"),
			delimiter: "\n",
			concurrency: 4,
		})) {
			got.push(r)
		}
		expect(got.sort()).toEqual(oracle) // interleaved across segments → compare as sets
	})

	test("Uint8Array results survive the transfer path", async () => {
		const dec = new TextDecoder()
		const lines: string[] = []
		for await (const bytes of AsyncSpliterator.asManyWorkers<Uint8Array>(file, {
			worker: join(handlerDir, "to-json-bytes.js"),
			delimiter: "\n",
			concurrency: 4,
		})) {
			lines.push(dec.decode(bytes).trim())
		}
		expect(lines).toHaveLength(5000)
		expect(JSON.parse(lines[0]!)).toHaveProperty("line")
	})

	test("rejects on a non-path source", () => {
		expect(() =>
			AsyncSpliterator.asManyWorkers((async function* () {})() as never, { worker: "x", concurrency: 2 })
		).toThrow(TypeError)
	})

	test("a throwing handler rejects the iterator", async () => {
		await expect(
			(async () => {
				for await (const _ of AsyncSpliterator.asManyWorkers(file, {
					worker: join(handlerDir, "throws.js"),
					delimiter: "\n",
					concurrency: 2,
				}))
					void _
			})()
		).rejects.toThrow(/boom/)
	})
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test --run test/asManyWorkers.test.ts`
Expected: FAIL — `asManyWorkers` not defined.

- [ ] **Step 3: Implement the worker entry**

```ts
// lib/segment-worker-entry.ts
/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 *
 * Runs inside a worker thread (spawned by runSegmentWorkers). Reads its segment via its own handle,
 * runs the user handler per record, and posts batched results with ack backpressure.
 */

import { parentPort, workerData } from "node:worker_threads"

import { createChunkIterator } from "../node/fs/index.js"
import { AsyncSpliterator } from "./AsyncSpliterator.js"
import { runSegment, type SegmentHandler } from "./segment-runtime.js"

interface WorkerData {
	source: string
	handlerUrl: string
	start: number
	end: number
	delimiter: unknown
	segmentIndex: number
	batchSize: number
	maxInFlight: number
	userData: unknown
}

async function main(): Promise<void> {
	const data = workerData as WorkerData
	const port = parentPort!

	// Ack backpressure: main posts a number; we track outstanding (posted - acked) batches.
	let acked = 0
	let posted = 0
	let wakeAck: (() => void) | undefined
	port.on("message", (msg: unknown) => {
		if (msg === "ack") {
			acked++
			wakeAck?.()
			wakeAck = undefined
		}
	})

	const mod = (await import(data.handlerUrl)) as { handleRecord?: SegmentHandler; default?: SegmentHandler }
	const handleRecord = mod.handleRecord ?? mod.default
	if (typeof handleRecord !== "function") {
		port.postMessage({ type: "error", message: `Worker module ${data.handlerUrl} has no handleRecord export.` })
		return
	}

	const chunkIterator = await createChunkIterator(data.source, { start: data.start, end: data.end - 1 })
	const records = new AsyncSpliterator(chunkIterator, { delimiter: data.delimiter as never, autoDispose: true })

	try {
		await runSegment({
			records,
			handleRecord,
			segmentIndex: data.segmentIndex,
			batchSize: data.batchSize,
			maxInFlight: data.maxInFlight,
			post: (batch, transfer) => {
				posted++
				port.postMessage({ type: "batch", records: batch }, transfer)
			},
			waitForAck: () => new Promise<void>((resolve) => (wakeAck = resolve)),
			inFlight: () => posted - acked,
		})
		port.postMessage({ type: "done" })
	} catch (error) {
		port.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) })
	}
}

void main()
```

- [ ] **Step 4: Implement `runSegmentWorkers` and wire `asManyWorkers`**

Append to `lib/segment-workers.ts`:

```ts
import { Worker } from "node:worker_threads"

import { computeSegments } from "./segments.js"
import type { AsyncDataResource, ByteRange } from "./shared.js"
import type { CharacterSequenceInput } from "./CharacterSequence.js"

export interface AsManyWorkersOptions {
	worker: string | URL
	delimiter?: CharacterSequenceInput
	concurrency: number
	probeSize?: number
	batchSize?: number
	maxInFlight?: number
	workerData?: unknown
}

/**
 * Spawn one worker per delimiter-aligned segment, each running the `worker` handler module, and
 * merge their results into a single async iterator. Results interleave across segments. Sends an
 * `ack` per consumed batch (backpressure); terminates all workers on completion, error, or early
 * return.
 */
export async function* runSegmentWorkers<R>(
	source: AsyncDataResource,
	options: AsManyWorkersOptions
): AsyncIterableIterator<R> {
	if (typeof source !== "string" && !(source instanceof URL)) {
		throw new TypeError("asManyWorkers requires a file path or URL — file handles cannot cross threads.")
	}

	const handlerUrl = options.worker instanceof URL ? options.worker.href : new URL(options.worker, "file://").href
	const sourcePath = source instanceof URL ? source.href : source
	const segments: ByteRange[] = await computeSegments(source, {
		delimiter: options.delimiter,
		concurrency: options.concurrency,
		probeSize: options.probeSize,
	})

	const workers: Worker[] = []
	const entryUrl = new URL("./segment-worker-entry.js", import.meta.url)

	try {
		const iterables = segments.map(([start, end], segmentIndex) => {
			const worker = new Worker(entryUrl, {
				workerData: {
					source: sourcePath,
					handlerUrl,
					start,
					end,
					delimiter: options.delimiter ?? null,
					segmentIndex,
					batchSize: options.batchSize ?? 256,
					maxInFlight: options.maxInFlight ?? 4,
					userData: options.workerData,
				},
			})
			workers.push(worker)
			return workerToIterable<R>(worker, () => worker.postMessage("ack"))
		})

		// Drain each segment's iterator in turn. Each worker runs concurrently; consuming them
		// sequentially still interleaves wall-clock work because the workers fill ahead (bounded by
		// maxInFlight). Order across segments is not guaranteed (documented).
		for (const iterable of iterables) {
			yield* iterable
		}
	} finally {
		await Promise.all(workers.map((w) => w.terminate()))
	}
}
```

In `lib/AsyncSpliterator.ts`, add the static (import `runSegmentWorkers` + `AsManyWorkersOptions` from `./segment-workers.js`):

```ts
	/**
	 * Parse `source` across worker threads. Each worker owns a handle to a delimiter-aligned segment,
	 * runs the `worker` handler module per record, and streams results back to the main thread as one
	 * async iterator — for a single-thread writer. See the parallel-segment-parsing design.
	 *
	 * @param source A file path or URL (file handles cannot cross threads).
	 */
	public static asManyWorkers<R = unknown>(
		source: AsyncDataResource,
		options: AsManyWorkersOptions
	): AsyncIterableIterator<R> {
		return runSegmentWorkers<R>(source, options)
	}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `yarn test --run test/asManyWorkers.test.ts`
Expected: PASS (4 tests). The fixture `.js` handlers are plain ESM and are copied to `out/test/fixtures/...` only if compiled; since tests reference them by absolute path under `test/`, they load directly. Confirm `tsconfig` does not need them compiled (they're `.js`, referenced by filesystem path, not imported by TS).

Then run the full suite: `yarn test --run`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
yarn exec oxfmt lib/segment-worker-entry.ts lib/segment-workers.ts lib/AsyncSpliterator.ts test/asManyWorkers.test.ts
git add lib/segment-worker-entry.ts lib/segment-workers.ts lib/AsyncSpliterator.ts test/asManyWorkers.test.ts test/fixtures/segment-handlers
git commit -m "feat(async): asManyWorkers — threaded segment parsing to a single iterator"
```

---

### Task 9: Documentation — replace the fiction with the real API

**Files:**

- Modify: `AGENTS.md` (architecture `asMany`/`asManyWorkers` bullets; the `readBytes`/`end` gotcha line; the two stale `[x]` worker perf-issue items)
- Modify: `README.md` (add a parallel-parsing section)

**Interfaces:** none (docs).

- [ ] **Step 1: Update `AGENTS.md`**

Replace the architecture bullets that describe `asMany`/`asManyWorkers` (the ones referencing `SEGMENT_WORKER_CODE`, `workerToIterable`, the 8 MB worker test) with an accurate description:

```markdown
- **`AsyncSpliterator.segments(source, { delimiter, concurrency })`** — returns delimiter-aligned `[start, end)` byte ranges (`lib/segments.ts`). The boundary primitive for parallel parsing: hand each range to a worker.
- **`AsyncSpliterator.asMany(source, { delimiter, concurrency })`** — one `AsyncSpliterator` per segment, sharing the event loop.
- **`AsyncSpliterator.asManyWorkers<R>(source, { worker, concurrency, batchSize?, maxInFlight? })`** — one `worker_threads` Worker per segment, each owning a handle to its range and running the `worker` handler module per record (`lib/segment-worker-entry.ts` + `lib/segment-runtime.ts`). Results stream back through `workerToIterable` (`lib/segment-workers.ts`) as one merged async iterator for a single-thread writer. Chunked batches, zero-copy `Uint8Array` transfer, bounded in-flight ack backpressure. Requires a path/URL.
```

Fix the `node/fs` gotcha line so it matches reality: `node/fs` exports `createChunkIterator`, `createFileWritableStream`, `createReadStream`, `readFileSize`, and `readBytes`; `CreateChunkIteratorOptions.end` is inclusive.

In "Known Performance Issues", the two `[x]` `asManyWorkers` items (worker-pool startup; sequential boundary detection) describe a pre-existing implementation that never existed. Replace them with one accurate `[ ]` follow-up:

```markdown
- [ ] **`asManyWorkers` — persistent worker pool**
  - v1 spawns and terminates one Worker per segment per call (startup amortizes over a multi-GB file). A pre-warmed pool reused across calls would also make the many-small-files case (currently `asyncParallelIterator`) viable on threads. Boundary probes already fire in parallel (`Promise.all` in `lib/segments.ts`).
```

- [ ] **Step 2: Update `README.md`**

Add after the "SIMD acceleration" section:

````markdown
### Parallel parsing across threads

For one large file with a CPU-bound per-row transform, `AsyncSpliterator.asManyWorkers` splits the file into delimiter-aligned segments and runs a handler module across worker threads — each worker owns its own handle and reads only its segment. Results stream back to the main thread as a single async iterator, for a single-thread writer (a database, a JSONL file).

```ts
import { AsyncSpliterator } from "spliterator"

// transform.js (runs in each worker; top-level code is per-worker init):
//   const dec = new TextDecoder(), enc = new TextEncoder()
//   export function handleRecord(bytes) {
//     return enc.encode(JSON.stringify(parse(dec.decode(bytes))) + "\n") // Uint8Array → zero-copy
//   }

for await (const jsonLine of AsyncSpliterator.asManyWorkers<Uint8Array>("huge.csv", {
	worker: new URL("./transform.js", import.meta.url),
	delimiter: "\n",
	concurrency: 8,
})) {
	out.write(jsonLine) // single-thread writer on main
}
```
````

Need just the byte ranges to drive your own pool? `AsyncSpliterator.segments(path, { delimiter, concurrency })` returns them.

````

- [ ] **Step 3: Verify lint**

Run: `yarn lint`
Expected: green (Markdown isn't linted by oxlint/oxfmt, but run it to confirm no code drift).

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md README.md
git commit -m "docs: document the real segments/asMany/asManyWorkers API"
````

---

## Self-Review

**Spec coverage:**

- `end` bound → Task 1. `readBytes` → Task 2. fd-leak fix → Task 3. `computeSegments` + invariant + edge cases → Task 4. `segments` + `asMany` → Task 5. Batching/transfer/backpressure protocol → Task 6 (`runSegment`). Eager-listener drain + ack hook → Task 7. Worker entry + `asManyWorkers` + TypeError + transfer + error/termination → Task 8. Docs → Task 9. All spec sections covered.
- Backpressure: `runSegment` (Task 6) enforces the window via `inFlight()`/`waitForAck()`; the worker entry (Task 8) tracks `posted - acked`; main acks per consumed batch (Task 7/8). Consistent.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; tests are concrete.

**Type consistency:** `SegmentOptions` (Task 4) reused by `segments`/`asMany` (Task 5). `SegmentHandler` (Task 6) reused by the worker entry (Task 8). `WorkerMessage`/`{type:"batch"|"done"|"error"}` shape consistent between `workerToIterable` (Task 7) and `segment-worker-entry` (Task 8). `ByteRange` half-open throughout; inclusive `end` conversion (`end - 1`) applied at every `createChunkIterator` call (Tasks 5, 8). `asManyWorkers` returns `AsyncIterableIterator<R>` in both the static (Task 8) and `runSegmentWorkers`.

**Note for the implementer:** Tasks 1–7 are pure/main-thread and fast to verify. Task 8 spawns real worker threads; if a worker fails to import `spliterator` modules, confirm the `package.json` `exports` subpaths from Tasks 6–7 are present and that `yarn compile` ran (the worker loads `out/lib/segment-worker-entry.js`).
