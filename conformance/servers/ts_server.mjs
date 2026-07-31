// Boot the TypeScript router for conformance testing, pointed at the mock
// Monad. Imports the built standalone package (run `pnpm -C routers/typescript
// build` first).
import http from 'node:http';
import { createEmbedRouter } from '../../routers/typescript/dist/index.js';

const router = createEmbedRouter({
	apiKey: 'conf-key',
	apiBase: process.env.MONAD_API_BASE,
	frameOrigin: 'https://app.monad.com/embed',
	getCustomerOrgID: () => 'org_conf',
	getProvisionedComponents: () => ({
		destinationOutputId: 'out_store',
		sourceInputId: 'in_source'
	}),
	catalogAllow: ['aws-cloudtrail', 'okta-systemlog']
});

const port = Number(process.env.PORT || 8791);
http.createServer(router).listen(port, '127.0.0.1');
