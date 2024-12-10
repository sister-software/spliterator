/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { createESLintPackageConfig } from "@sister.software/eslint-config"

// @ts-check

/**
 * ESLint configuration for the Typed Path Builder package.
 */
const ESLintConfig = createESLintPackageConfig({
	copyrightHolder: "Sister Software",
	packageTitle: "Typed Path Builder",
	spdxLicenseIdentifier: "AGPL-3.0",
})

export default ESLintConfig
