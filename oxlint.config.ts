/**
 * @license MIT
 * @file Oxlint configuration for spliterator.
 * @author Teffen Ellis, et al.
 * @copyright Sister Software
 */

import { createOxlintConfig, DefaultIgnorePatterns } from "@sister.software/oxlint-config"

export default createOxlintConfig({
	copyrightHolder: "Sister Software",
	spdxLicenseIdentifier: "MIT",
	ignorePatterns: [...DefaultIgnorePatterns, ".claude/**/*"],
})
