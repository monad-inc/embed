import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmbedHandler, type EmbedRequest, type EmbedServerConfig } from '../src';

const API_BASE = 'https://api.test/api';

/** Route mocked fetch by "METHOD /path" → a JSON body (function receives the parsed request body). */
function mockApi(routes: Record<string, unknown | ((body: unknown) => unknown)>) {
	const calls: { method: string; path: string; body?: unknown }[] = [];
	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		const method = (init?.method ?? 'GET').toUpperCase();
		const path = url.replace(API_BASE, '');
		const body = init?.body ? JSON.parse(init.body as string) : undefined;
		calls.push({ method, path, body });
		const key =
			Object.keys(routes).find((k) => k === `${method} ${path}`) ??
			Object.keys(routes).find((k) => {
				const [m, p] = k.split(' ');
				return m === method && p !== undefined && path.startsWith(p);
			});
		if (!key) throw new Error(`unmocked ${method} ${path}`);
		const val = routes[key];
		const resolved = typeof val === 'function' ? (val as (b: unknown) => unknown)(body) : val;
		return {
			ok: true,
			status: 200,
			text: async () => (resolved === undefined ? '' : JSON.stringify(resolved))
		} as Response;
	});
	vi.stubGlobal('fetch', fetchMock);
	return calls;
}

const baseConfig = (over: Partial<EmbedServerConfig> = {}): EmbedServerConfig => ({
	apiKey: 'k',
	apiBase: API_BASE,
	frameOrigin: 'https://app.monad.com/embed',
	getCustomerOrgID: () => 'org_1',
	...over
});

const req = (method: string, path: string, extra: Partial<EmbedRequest> = {}): EmbedRequest => ({
	method,
	path,
	query: {},
	headers: {},
	...extra
});

afterEach(() => vi.unstubAllGlobals());

describe('createEmbedHandler (standalone)', () => {
	it('GET /config returns frame + api config without auth', async () => {
		const handle = createEmbedHandler(
			baseConfig({
				getCustomerOrgID: () => {
					throw new Error('should not be called');
				}
			})
		);
		const res = await handle(req('GET', '/config'));
		expect(res).toEqual({
			status: 200,
			body: { frameOrigin: 'https://app.monad.com/embed', apiBase: API_BASE }
		});
	});

	it('defaults apiBase + frameOrigin to production when omitted', async () => {
		const res = await createEmbedHandler({ apiKey: 'k', getCustomerOrgID: () => 'org_1' })(
			req('GET', '/config')
		);
		expect(res.body).toEqual({
			frameOrigin: 'https://app.monad.com/embed',
			apiBase: 'https://app.monad.com/api'
		});
	});

	it('POST /session mints a token for the resolved tenant', async () => {
		mockApi({ 'POST /v3/sessions': { session_token: 'tok', expires_at: '2026-01-01T00:00:00Z' } });
		const res = await createEmbedHandler(baseConfig())(req('POST', '/session'));
		expect(res.status).toBe(200);
		expect(res.body).toEqual({
			sessionToken: 'tok',
			organizationId: 'org_1',
			expiresAt: '2026-01-01T00:00:00Z'
		});
	});

	it('GET /catalog returns the contract camelCase (typeId), filtered to the allow-list', async () => {
		mockApi({
			'GET /v1/inputs': [
				{ type_id: 'aws-cloudtrail', name: 'AWS' },
				{ type_id: 'secret', name: 'Hidden' }
			]
		});
		const handle = createEmbedHandler(baseConfig({ catalogAllow: ['aws-cloudtrail'] }));
		const res = await handle(req('GET', '/catalog', { query: { kind: 'input' } }));
		expect(res.status).toBe(200);
		expect(res.body).toEqual([{ typeId: 'aws-cloudtrail', name: 'AWS' }]);
	});

	it('GET /connectors normalizes the API `type` field to camelCase `typeId`', async () => {
		mockApi({
			'GET /v1/org_1/inputs': {
				inputs: [{ id: 'in_1', type: 'aws-cloudtrail', name: 'Audit Logs' }]
			}
		});
		const res = await createEmbedHandler(baseConfig())(
			req('GET', '/connectors', { query: { kind: 'input' } })
		);
		expect(res.body).toEqual([{ id: 'in_1', typeId: 'aws-cloudtrail', name: 'Audit Logs' }]);
	});

	it('POST /pipelines/ingress wires to the provisioned store', async () => {
		const calls = mockApi({
			'POST /v2/org_1/pipelines/': { id: 'pipe_1' },
			'GET /v2/org_1/pipelines/pipe_1/status': { status: 'Running' }
		});
		const handle = createEmbedHandler(
			baseConfig({ getProvisionedComponents: () => ({ destinationOutputId: 'out_store' }) })
		);
		const res = await handle(
			req('POST', '/pipelines/ingress', { body: { inputId: 'in_1', name: 'CT' } })
		);
		expect(res.status).toBe(201);
		expect((res.body as { outputId: string }).outputId).toBe('out_store');
		const post = calls.find((c) => c.method === 'POST' && c.path === '/v2/org_1/pipelines/');
		expect((post!.body as { nodes: unknown[] }).nodes).toContainEqual(
			expect.objectContaining({ component_id: 'out_store', component_type: 'output' })
		);
	});

	it('POST /pipelines/ingress falls back to a dev/null sink without a store', async () => {
		mockApi({
			'POST /v2/org_1/outputs': { id: 'out_devnull' },
			'POST /v2/org_1/pipelines/': { id: 'pipe_2' },
			'GET /v2/org_1/pipelines/pipe_2/status': { status: 'Running' }
		});
		const res = await createEmbedHandler(baseConfig())(
			req('POST', '/pipelines/ingress', { body: { inputId: 'in_1', name: 'CT' } })
		);
		expect(res.status).toBe(201);
		expect((res.body as { outputId: string }).outputId).toBe('out_devnull');
	});

	it('POST /pipelines/egress 500s when no source is provisioned', async () => {
		const res = await createEmbedHandler(baseConfig())(
			req('POST', '/pipelines/egress', { body: { outputId: 'out_1', name: 'Splunk' } })
		);
		expect(res.status).toBe(500);
		expect((res.body as { code: string }).code).toBe('internal_error');
	});

	it('POST /pipelines/state disables and returns 204', async () => {
		mockApi({
			'GET /v2/org_1/pipelines/pipe_1': {
				config: { name: 'p', nodes: [], edges: [], enabled: true }
			},
			'PATCH /v2/org_1/pipelines/pipe_1': undefined
		});
		const res = await createEmbedHandler(baseConfig())(
			req('POST', '/pipelines/state', { body: { pipelineId: 'pipe_1', enabled: false } })
		);
		expect(res).toEqual({ status: 204 });
	});

	it('rejects an unauthenticated caller with 401', async () => {
		const handle = createEmbedHandler(
			baseConfig({
				getCustomerOrgID: () => {
					throw new Error('no session');
				}
			})
		);
		const res = await handle(req('POST', '/session'));
		expect(res.status).toBe(401);
		expect((res.body as { code: string }).code).toBe('unauthenticated');
	});

	it('400s on an invalid kind and on a missing body field', async () => {
		const handle = createEmbedHandler(baseConfig());
		const bad = await handle(req('GET', '/catalog', { query: { kind: 'nope' } }));
		expect(bad.status).toBe(400);
		const missing = await handle(req('POST', '/pipelines/ingress', { body: { name: 'x' } }));
		expect(missing.status).toBe(400);
	});

	it('maps a Monad API failure to 502 upstream_error', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('connection refused');
			})
		);
		const res = await createEmbedHandler(baseConfig())(req('POST', '/session'));
		expect(res.status).toBe(502);
		expect((res.body as { code: string }).code).toBe('upstream_error');
	});

	it('404s an unknown route', async () => {
		const res = await createEmbedHandler(baseConfig())(req('GET', '/nope'));
		expect(res.status).toBe(404);
		expect((res.body as { code: string }).code).toBe('not_found');
	});
});
