import { defineConfig } from 'tsup';

// Named entry so output lands at dist/connect/index.* (a bare single
// entry would flatten to dist/index.*). The package.json `exports`
// map points "./connect" at these files. Add sibling entries here as
// new subpath modules land (e.g. a future top-level "." aggregate).
export default defineConfig({
	entry: { 'connect/index': 'src/connect/index.ts' },
	format: ['esm', 'cjs'],
	dts: true,
	sourcemap: true,
	clean: true
});
