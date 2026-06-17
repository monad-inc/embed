import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Flat config for a plain-TypeScript monorepo. Deliberately NOT the Svelte
// config the ui repo uses — nothing here is Svelte.
export default tseslint.config(
	{ ignores: ['**/dist/**', '**/node_modules/**', '**/*.config.*', '**/.changeset/**'] },
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ['**/*.ts'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname
			}
		}
	}
);
