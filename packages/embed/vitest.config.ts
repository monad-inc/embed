import { defineConfig } from 'vitest/config';

// Local config so vitest doesn't walk up the tree and pick up
// ui-svelte's vite.config.ts (which expects SvelteKit sources).
// `css.postcss: { plugins: [] }` short-circuits PostCSS's upward
// search for postcss.config.* — the parent ui has a .ts variant
// that needs ts-node we don't ship here.
export default defineConfig({
	css: { postcss: { plugins: [] } },
	test: {
		include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
		environment: 'node',
		passWithNoTests: true
	}
});
