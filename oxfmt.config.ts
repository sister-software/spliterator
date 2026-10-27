/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 *
 * Oxfmt configuration for spliterator.
 */

import { sisterSoftwareOxfmtConfig } from "@sister.software/oxfmt-config"
import type { OxfmtConfig } from "oxfmt"

const config: OxfmtConfig = {
	...sisterSoftwareOxfmtConfig,
	// The conformance fixtures keep invisible characters (BOMs, NBSPs, U+FFFD) as escapes, which formatting would
	// rewrite into literal characters.
	ignorePatterns: [".yarn", "conformance"],
}

export default config
