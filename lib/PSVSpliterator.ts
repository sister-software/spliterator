/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { Delimiters } from "./CharacterSequence.js"
import { CSVSpliterator } from "./CSVSpliterator.js"

/**
 * A static class spliterator for pipe-separated values.
 *
 * @see {@linkcode PSVSpliterator.from} for synchronous usage.
 * @see {@linkcode PSVSpliterator.fromAsync} for asynchronous usage.
 */
export abstract class PSVSpliterator extends CSVSpliterator {
	/**
	 * The column delimiter used by the spliterator.
	 *
	 * @default Delimiters.Pipe
	 */
	public static override ColumnDelimiter: number = Delimiters.Pipe
}
