/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

import { CharacterSequence, type CharacterSequenceInput } from "#core/CharacterSequence"
import { loadNodeFs } from "#internal/node-modules"
import { type AsyncDataResource, type ByteRange, isPathBuilderLike, toPathString } from "#internal/shared"
import { COMPRESSION_SNIFF_LENGTH, sniffCompression } from "#io/compression"

export interface SegmentOptions {
	/**
	 * The record delimiter. @default LineFeed
	 */
	delimiter?: CharacterSequenceInput
	/**
	 * Desired number of segments. The value is clamped to ≥ 1, and the result may contain fewer segments.
	 */
	concurrency: number
	/**
	 * Bytes read at each ideal boundary to find the next delimiter. @default 65536
	 */
	probeSize?: number
}

function describeSource(source: AsyncDataResource): string {
	if (isPathBuilderLike(source)) return toPathString(source)

	return source instanceof URL ? source.href : "The source"
}

/**
 * Divide `source` into up to `concurrency` delimiter-aligned byte ranges. Each internal boundary is placed immediately
 * after the first delimiter at or past the ideal boundary, so concatenating each segment's records reproduces the file
 * exactly — no record is split or duplicated.
 *
 * A probe window with no delimiter (a record longer than `probeSize`) collapses that boundary, so the result may have
 * fewer than `concurrency` segments. An empty file yields no segments.
 */
export async function computeSegments(source: AsyncDataResource, options: SegmentOptions): Promise<ByteRange[]> {
	const { readFileSize, readBytes } = await loadNodeFs()
	const needle = new CharacterSequence(options.delimiter)
	const probeSize = options.probeSize ?? 65_536
	const concurrency = Math.max(1, Math.floor(options.concurrency))

	const fileSize = await readFileSize(source)

	if (fileSize === 0) return []

	// A compressed stream has no record boundaries at byte offsets, so it cannot be cut into segments.
	const format = sniffCompression(await readBytes(source, 0, COMPRESSION_SNIFF_LENGTH))

	if (format) {
		throw new TypeError(
			`${describeSource(source)} is ${format}-compressed, and a compressed source cannot be segmented. ` +
				"Decompress it to disk first, or read it sequentially."
		)
	}

	if (concurrency === 1) return [[0, fileSize]]

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
		if (cut !== null && cut > 0 && cut < fileSize) {
			boundaries.add(cut)
		}
	}

	const sorted = Array.from(boundaries).toSorted((a, b) => a - b)
	const segments: ByteRange[] = []

	for (let i = 1; i < sorted.length; i++) {
		const start = sorted[i - 1]!
		const end = sorted[i]!

		if (end > start) {
			segments.push([start, end])
		}
	}

	return segments
}
