/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file oxlint configuration for spliterator.
 */

import { createOxlintConfig, DefaultIgnorePatterns } from "@sister.software/oxlint-config"

export default createOxlintConfig({
	copyrightHolder: "Sister Software",
	spdxLicenseIdentifier: "AGPL-3.0",
	ignorePatterns: [...DefaultIgnorePatterns, ".claude/**/*"],
})
