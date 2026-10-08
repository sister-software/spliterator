/**
 * @license MIT
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 *
 * Oxlint configuration for spliterator.
 */

import { createOxlintConfig, DefaultIgnorePatterns } from "@sister.software/oxlint-config"

export default createOxlintConfig({
	copyrightHolder: "Sister Software",
	spdxLicenseIdentifier: "MIT",
	ignorePatterns: [...DefaultIgnorePatterns, ".claude/**/*"],
})
