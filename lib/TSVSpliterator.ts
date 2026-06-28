/**
 * @copyright Sister Software
 * @license MIT
 * @author Teffen Ellis, et al.
 */

import { Delimiters } from "./CharacterSequence.js"
import { CSVSpliterator } from "./CSVSpliterator.js"

/**
 * A static class spliterator for tab-separated values.
 *
 * @see {@linkcode TSVSpliterator.from} for synchronous usage.
 * @see {@linkcode TSVSpliterator.fromAsync} for asynchronous usage.
 */
export abstract class TSVSpliterator extends CSVSpliterator {
	/**
	 * The column delimiter used by the spliterator.
	 *
	 * @default Delimiters.Tab
	 */
	public static override ColumnDelimiter: number = Delimiters.Tab
}
