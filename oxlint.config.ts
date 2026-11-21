// SPDX-FileCopyrightText: Sister Software
// SPDX-License-Identifier: MIT

/**
 * Oxlint configuration for spliterator.
 */

import { createOxlintConfig, DefaultIgnorePatterns } from "@sister.software/oxlint-config"

export default createOxlintConfig({
	copyrightText: "Sister Software",
	spdxLicenseIdentifier: "MIT",
	ignorePatterns: [...DefaultIgnorePatterns, ".claude/**/*"],
})
