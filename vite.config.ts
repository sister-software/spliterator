/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/// <reference types="vitest/config" />

import { defineConfig } from "vite"

export default defineConfig({
	test: {
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			"**/out/**",
			"**/cypress/**",
			"**/.{idea,git,cache,output,temp}/**",
			"**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
		],
	},
})
