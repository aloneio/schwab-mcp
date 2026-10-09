import defaultConfig from '@epic-web/config/eslint'

/** @type {import("eslint").Linter.Config} */
export default [
	...defaultConfig,
	{
		ignores: ['./.wrangler/**'],
	},
	{
		files: ['tests/**/*.ts'],
		rules: { 'vitest/no-import-node-test': 'off' },
	},
]
