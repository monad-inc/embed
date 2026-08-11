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
			// The conformance suite's Python virtualenv vendors JS that has
			// nothing to do with us; without this, a local `pnpm lint` drowns in
			// errors from site-packages (CI never sees it, it checks out clean).
			'**/.venv/**'
		]
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ['**/*.ts'],
		languageOptions: {
			parserOptions: {
				projectService: {
					// Test files sit outside the build tsconfig (it sets rootDir to
					// src and excludes test/), so the project service finds no
					// project for them and refuses to parse. They're typechecked
					// separately via tsconfig.test.json.
					allowDefaultProject: ['packages/embed/test/*.ts']
				},
				tsconfigRootDir: import.meta.dirname
			}
		},
		rules: {
			// The SDK deliberately treats Monad API responses as untyped JSON
			// (see MonadRequest in lifecycle.ts). Surface but don't block on it.
			'@typescript-eslint/no-explicit-any': 'warn'
		}
	}
);
