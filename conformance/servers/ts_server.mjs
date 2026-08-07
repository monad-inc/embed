// Boot the TypeScript router for conformance testing. In the default (mock)
// mode the harness points it at the in-memory mock via MONAD_API_BASE; in live
// mode the same knobs are set to real Monad staging credentials. Every value
// falls back to the mock fixture default, so `node ts_server.mjs` with only
// MONAD_API_BASE set behaves exactly as before.
//
// Build the standalone package first: `pnpm -C routers/typescript build`.
import http from 'node:http';
import { createEmbedRouter } from '../../routers/typescript/dist/index.js';

const env = (name, fallback) => process.env[name] ?? fallback;
// A provisioned id may be intentionally empty (live tenant with no store) → treat
// "" as "not provisioned" so the router falls back to a dev/null sink.
const store = env('MONAD_STORE_ID', 'out_store') || undefined;
const source = env('MONAD_SOURCE_ID', 'in_source') || undefined;
// Empty allow-list → expose the whole catalog (undefined), never the empty set.
const allow = env('MONAD_CATALOG_ALLOW', 'aws-cloudtrail,okta-systemlog')
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean);

const router = createEmbedRouter({
	apiKey: env('MONAD_API_KEY', 'conf-key'),
	apiBase: process.env.MONAD_API_BASE,
	frameOrigin: env('MONAD_FRAME_ORIGIN', 'https://app.monad.com/embed'),
	getCustomerOrgID: () => env('MONAD_ORG_ID', 'org_conf'),
	getProvisionedComponents: () => ({ destinationOutputId: store, sourceInputId: source }),
	catalogAllow: allow.length ? allow : undefined
});

const port = Number(process.env.PORT || 8791);
http.createServer(router).listen(port, '127.0.0.1');
