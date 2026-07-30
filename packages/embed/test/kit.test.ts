import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmbedClient } from '../src/kit';

const CFG = { apiKey: 'test-key', apiBase: 'https://api.test/api' };

/** Route mocked fetch by "METHOD /path" → a JSON body (or a function of the request). */
function mockApi(routes: Record<string, unknown | ((body: any) => unknown)>) {
	const calls: { method: string; path: string; body?: any }[] = [];
	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		const method = (init?.method ?? 'GET').toUpperCase();
		const path = url.replace(CFG.apiBase, '');
		const body = init?.body ? JSON.parse(init.body as string) : undefined;
		calls.push({ method, path, body });
		// Match on "METHOD /exact/path", falling back to a path prefix match so
		// query strings and ids don't have to be spelled out in every route key.
		const key =
			Object.keys(routes).find((k) => k === `${method} ${path}`) ??
			Object.keys(routes).find((k) => {
				const [m, p] = k.split(' ');
				return m === method && p !== undefined && path.startsWith(p);
			});
		if (!key) throw new Error(`unmocked ${method} ${path}`);
		const val = routes[key];
		const resolved = typeof val === 'function' ? (val as (b: any) => unknown)(body) : val;
		return {
			ok: true,
			status: 200,
			text: async () => (resolved === undefined ? '' : JSON.stringify(resolved))
		} as Response;
	});
	vi.stubGlobal('fetch', fetchMock);
	return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('createEmbedClient', () => {
	it('mints a session and remaps snake_case → the camelCase the iframe wants', async () => {
		mockApi({
			'POST /v3/sessions': { session_token: 'tok_abc', expires_at: '2026-01-01T00:00:00Z' }
		});
		const monad = createEmbedClient(CFG);
		const session = await monad.team('org_1').mintSession(900);
		expect(session).toEqual({
			sessionToken: 'tok_abc',
			organizationId: 'org_1',
			expiresAt: '2026-01-01T00:00:00Z'
		});
	});

	it('passes ttl + org through to the session mint', async () => {
		const calls = mockApi({ 'POST /v3/sessions': { session_token: 't', expires_at: 'x' } });
		await createEmbedClient(CFG).mintSession('org_9', 600);
		expect(calls[0]?.body).toEqual({ ttl_seconds: 600, organization_id: 'org_9' });
	});

	it('connectSource wires input → your store when toOutputId is given', async () => {
		const calls = mockApi({
			'POST /v2/org_1/pipelines/': { id: 'pipe_1' },
			'GET /v2/org_1/pipelines/pipe_1/status': { status: 'Running' }
		});
		const built = await createEmbedClient(CFG)
			.team('org_1')
			.connectSource({ inputId: 'in_1', name: 'CloudTrail', toOutputId: 'out_store' });

		expect(built).toEqual({
			pipelineId: 'pipe_1',
			outputId: 'out_store',
			status: 'Running',
			active: true
		});
		const post = calls.find((c) => c.method === 'POST' && c.path === '/v2/org_1/pipelines/');
		const nodes = post!.body.nodes;
		expect(nodes).toContainEqual(
			expect.objectContaining({ component_id: 'in_1', component_type: 'input' })
		);
		expect(nodes).toContainEqual(
			expect.objectContaining({ component_id: 'out_store', component_type: 'output' })
		);
	});

	it('connectSource creates a dev/null sink when no store is given', async () => {
		const calls = mockApi({
			'POST /v2/org_1/outputs': { id: 'out_devnull' },
			'POST /v2/org_1/pipelines/': { id: 'pipe_2' },
			'GET /v2/org_1/pipelines/pipe_2/status': { status: 'Running' }
		});
		const built = await createEmbedClient(CFG)
			.team('org_1')
			.connectSource({ inputId: 'in_1', name: 'CloudTrail' });

		expect(built.outputId).toBe('out_devnull');
		const outPost = calls.find((c) => c.path === '/v2/org_1/outputs');
		expect(outPost!.body.output_type).toBe('dev-null');
	});

	it('connectDestination wires your source → the user output (egress)', async () => {
		const calls = mockApi({
			'POST /v2/org_1/pipelines/': { id: 'pipe_3' },
			'GET /v2/org_1/pipelines/pipe_3/status': { status: 'Running' }
		});
		await createEmbedClient(CFG)
			.team('org_1')
			.connectDestination({ outputId: 'out_user', name: 'Egress', fromInputId: 'in_source' });

		const post = calls.find((c) => c.method === 'POST' && c.path === '/v2/org_1/pipelines/');
		const nodes = post!.body.nodes;
		expect(nodes).toContainEqual(
			expect.objectContaining({ component_id: 'in_source', component_type: 'input' })
		);
		expect(nodes).toContainEqual(
			expect.objectContaining({ component_id: 'out_user', component_type: 'output' })
		);
	});

	it('listConnectors normalizes the API `type` field to `type_id`', async () => {
		mockApi({
			'GET /v1/org_1/inputs': {
				inputs: [{ id: 'in_1', type: 'aws-cloudtrail', name: 'Audit Logs' }]
			}
		});
		const rows = await createEmbedClient(CFG).team('org_1').listConnectors('input');
		expect(rows).toEqual([{ id: 'in_1', type_id: 'aws-cloudtrail', name: 'Audit Logs' }]);
	});

	it('listCatalog filters to the host allow-list', async () => {
		mockApi({
			'GET /v1/inputs': [
				{ type_id: 'aws-cloudtrail', name: 'AWS CloudTrail' },
				{ type_id: 'okta-systemlog', name: 'Okta' },
				{ type_id: 'secret-thing', name: 'Hidden' }
			]
		});
		const rows = await createEmbedClient(CFG).listCatalog('input', [
			'aws-cloudtrail',
			'okta-systemlog'
		]);
		expect(rows.map((r) => r.type_id)).toEqual(['aws-cloudtrail', 'okta-systemlog']);
	});
});
