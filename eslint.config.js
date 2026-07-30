import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Flat config for a plain-TypeScript monorepo. Deliberately NOT the Svelte
// config the ui repo uses — nothing here is Svelte.
export default tseslint.config(
	{
		ignores: [
			'**/dist/**',
			'**/node_modules/**',
			'**/*.config.*',
			'**/.changeset/**',
			// Python virtualenvs (conformance harness, python router) ship vendored
			// JS assets we don't lint.
			'**/.venv/**'
		]
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		// Plain Node scripts (e.g. conformance boot scripts) — grant Node globals.
		files: ['**/*.mjs', '**/*.cjs'],
		languageOptions: {
			globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly' }
		}
	},
	{
		files: ['**/*.ts'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname
			}
		},
		rules: {
			// The SDK deliberately treats Monad API responses as untyped JSON
			// (see MonadRequest in lifecycle.ts). Surface but don't block on it.
			'@typescript-eslint/no-explicit-any': 'warn',
			// Allow intentionally-unused `_`-prefixed args (e.g. typed mock params).
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
			]
		}
	}
);
