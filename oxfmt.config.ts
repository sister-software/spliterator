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
	ignorePatterns: [".yarn"],
}

export default config
