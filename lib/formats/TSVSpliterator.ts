/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

import { Delimiters } from "#core/CharacterSequence"
import { CSVSpliterator } from "#formats/CSVSpliterator"

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

	/**
	 * Off since 10.0.0. The TSV format has no quoting, and a `"` in a tab-separated source (a GeoNames place name such as
	 * `Ovrag Kyzylak"on`) is data. A quote-aware reader would join every line from one such quote to the next into a
	 * single record. Pass `enableQuoteHandling: true` for a source that does quote its fields.
	 *
	 * @default false
	 */
	public static override EnableQuoteHandling = false
}
