/* eslint-env node */
// R-27：接入 ESLint —— 类型 + React Hooks + 组件导出规范
module.exports = {
	root: true,
	env: { browser: true, es2021: true, node: true },
	parser: "@typescript-eslint/parser",
	parserOptions: {
		ecmaVersion: "latest",
		sourceType: "module",
		ecmaFeatures: { jsx: true },
	},
	plugins: ["@typescript-eslint", "react-hooks", "react-refresh"],
	extends: [
		"eslint:recommended",
		"plugin:@typescript-eslint/recommended",
		"plugin:react-hooks/recommended",
	],
	ignorePatterns: [
		"dist",
		"dist-test",
		"node_modules",
		"release",
		".npm-cache",
		"src-tauri",
	],
	rules: {
		"@typescript-eslint/no-unused-vars": [
			"warn",
			{ argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
		],
		"@typescript-eslint/no-empty-function": "off",
		"@typescript-eslint/no-explicit-any": "off",
		"@typescript-eslint/no-non-null-assertion": "off",
		"react-refresh/only-export-components": [
			"warn",
			{ allowConstantExport: true },
		],
	},
};
