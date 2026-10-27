/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 *
 * Frame boundaries of a zstd stream, found by walking frame and block headers without decompressing anything.
 *
 * A zstd stream may hold several frames back to back (`cat a.zst b.zst`, `pzstd`), and the format defines the result as
 * the concatenation of their contents. Node's `zstdDecompressSync` returns the first frame's content and drops the rest
 * without a word, and its streaming decompressor fails on the second frame. Each frame is therefore handed to a
 * decompressor of its own. Skippable frames carry no content and are dropped here.
 *
 * Layout per RFC 8878 §3.1: a 4-byte magic, a frame header whose length follows from its first byte, then blocks of a
 * 3-byte header plus content, the last block flagged, then an optional 4-byte checksum.
 */

const ZSTD_FRAME_MAGIC = 0xfd_2f_b5_28
const SKIPPABLE_MAGIC_MASK = 0xff_ff_ff_f0
const SKIPPABLE_MAGIC = 0x18_4d_2a_50

const DICTIONARY_ID_BYTES = [0, 1, 2, 4] as const
const CONTENT_SIZE_BYTES = [0, 2, 4, 8] as const

const BLOCK_TYPE_RLE = 1
const BLOCK_TYPE_RESERVED = 3

/**
 * A piece of the stream, in order. `final` marks the piece that ends its frame.
 */
export interface ZstdSegment {
	bytes: Uint8Array
	final: boolean
}

type ScanState = "magic" | "skippable-size" | "descriptor" | "header" | "block-header" | "skip" | "checksum"

function corrupt(reason: string): TypeError {
	return new TypeError(`The source is not a valid zstd stream: ${reason}.`)
}

/**
 * An incremental scanner: feed it the stream a chunk at a time and it returns the pieces of each data frame, with the
 * frame's last piece marked. Bytes of skippable frames are not returned.
 */
export class ZstdFrameScanner {
	#state: ScanState = "magic"
	/**
	 * Header bytes gathered so far for the current fixed-size field.
	 */
	readonly #field = new Uint8Array(16)
	#fieldLength = 0
	#need = 4
	/**
	 * Content bytes left to pass over in the current block or skippable frame.
	 */
	#skip = 0
	#skippable = false
	#lastBlock = false
	#hasChecksum = false

	/**
	 * Whether the stream so far ends exactly between frames.
	 */
	public get atBoundary(): boolean {
		return this.#state === "magic" && this.#fieldLength === 0
	}

	public scan(chunk: Uint8Array): ZstdSegment[] {
		const segments: ZstdSegment[] = []
		// Start of the run of this chunk that belongs to the current data frame and has not been emitted yet.
		let runStart = this.#state === "magic" || this.#skippable ? -1 : 0
		let index = 0

		const emit = (end: number, final: boolean) => {
			if (runStart >= 0 && (end > runStart || final)) {
				segments.push({ bytes: chunk.subarray(runStart, end), final })
			}

			runStart = final ? -1 : end
		}

		while (index < chunk.byteLength) {
			if (this.#state === "skip") {
				const take = Math.min(this.#skip, chunk.byteLength - index)

				index += take
				this.#skip -= take

				if (this.#skip === 0) {
					this.#afterContent(index, emit)
				}

				continue
			}

			const take = Math.min(this.#need - this.#fieldLength, chunk.byteLength - index)

			this.#field.set(chunk.subarray(index, index + take), this.#fieldLength)
			this.#fieldLength += take
			index += take

			if (this.#fieldLength < this.#need) break

			this.#fieldLength = 0

			switch (this.#state) {
				case "magic": {
					const magic = readUint32(this.#field)

					if (magic === ZSTD_FRAME_MAGIC) {
						// The magic may have straddled chunks, so the decompressor gets its own copy of it, and the rest of this
						// frame's bytes run on from here.
						segments.push({ bytes: this.#field.slice(0, 4), final: false })
						runStart = index
						this.#skippable = false
						this.#expect("descriptor", 1)
					} else if ((magic & SKIPPABLE_MAGIC_MASK) >>> 0 === SKIPPABLE_MAGIC) {
						this.#skippable = true
						this.#expect("skippable-size", 4)
					} else {
						throw corrupt("a frame does not begin with a zstd magic number")
					}

					break
				}
				case "skippable-size":
					this.#skip = readUint32(this.#field)

					if (this.#skip === 0) {
						this.#endFrame(index, emit)
					} else {
						this.#state = "skip"
					}

					break
				case "descriptor": {
					const descriptor = this.#field[0]!
					const contentSizeFlag = descriptor >> 6
					const singleSegment = (descriptor >> 5) & 1

					const headerLength =
						(singleSegment ? 0 : 1) +
						DICTIONARY_ID_BYTES[descriptor & 3]! +
						(contentSizeFlag === 0 ? singleSegment : CONTENT_SIZE_BYTES[contentSizeFlag]!)

					this.#hasChecksum = ((descriptor >> 2) & 1) === 1

					if (headerLength) {
						this.#expect("header", headerLength)
					} else {
						this.#expect("block-header", 3)
					}

					break
				}
				case "header":
					this.#expect("block-header", 3)

					break
				case "block-header": {
					const header = this.#field[0]! | (this.#field[1]! << 8) | (this.#field[2]! << 16)
					const type = (header >> 1) & 3

					if (type === BLOCK_TYPE_RESERVED) throw corrupt("a block has the reserved type")

					this.#lastBlock = (header & 1) === 1
					this.#skip = type === BLOCK_TYPE_RLE ? 1 : header >>> 3

					if (this.#skip) {
						this.#state = "skip"
					} else {
						this.#afterContent(index, emit)
					}

					break
				}
				case "checksum":
					this.#endFrame(index, emit)

					break
				default:
					break
			}
		}

		// Whatever of the current data frame this chunk held is passed on now; its frame continues in the next chunk.
		if (!this.#skippable && this.#state !== "magic") {
			emit(chunk.byteLength, false)
		}

		return segments
	}

	#expect(state: ScanState, length: number): void {
		this.#state = state
		this.#need = length
	}

	#afterContent(index: number, emit: (end: number, final: boolean) => void): void {
		if (this.#skippable) {
			this.#endFrame(index, emit)
		} else if (!this.#lastBlock) {
			this.#expect("block-header", 3)
		} else if (this.#hasChecksum) {
			this.#expect("checksum", 4)
		} else {
			this.#endFrame(index, emit)
		}
	}

	#endFrame(index: number, emit: (end: number, final: boolean) => void): void {
		if (!this.#skippable) {
			emit(index, true)
		}

		this.#skippable = false
		this.#expect("magic", 4)
	}
}

function readUint32(bytes: Uint8Array): number {
	return (bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24)) >>> 0
}

/**
 * The data frames of a whole zstd buffer, each as one contiguous view.
 */
export function splitZstdFrames(bytes: Uint8Array): Uint8Array[] {
	const scanner = new ZstdFrameScanner()
	const frames: Uint8Array[] = []
	let pieces: Uint8Array[] = []

	for (const segment of scanner.scan(bytes)) {
		pieces.push(segment.bytes)

		if (segment.final) {
			frames.push(joinPieces(pieces))
			pieces = []
		}
	}

	if (!scanner.atBoundary) throw corrupt("the stream ends inside a frame")

	return frames
}

/**
 * Concatenate byte arrays, without copying when there is only one.
 */
export function joinPieces(pieces: readonly Uint8Array[]): Uint8Array {
	if (pieces.length === 1) return pieces[0]!

	let length = 0

	for (const piece of pieces) {
		length += piece.byteLength
	}

	const joined = new Uint8Array(length)
	let offset = 0

	for (const piece of pieces) {
		joined.set(piece, offset)
		offset += piece.byteLength
	}

	return joined
}
