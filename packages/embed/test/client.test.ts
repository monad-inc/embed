import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorFrameOptions } from '../src/connect';

// Mock the low-level iframe primitive so we can assert how the client wires it,
// without needing a DOM. (The type-only import above is unaffected by the mock.)
const { createConnectorFrame, destroy } = vi.hoisted(() => {
	const destroy = vi.fn();
	const createConnectorFrame = vi.fn((_opts: ConnectorFrameOptions) => ({ destroy }));
	return { destroy, createConnectorFrame };
});
vi.mock('../src/connect', () => ({ createConnectorFrame }));

import { createEmbedClient, EmbedRequestError } from '../src/client';

/** Route mocked fetch by "METHOD /path" → { status?, body }. Default 200. */
function mockApi(routes: Record<string, { status?: number; body?: unknown }>) {
	const calls: { method: string; path: string; body?: unknown }[] = [];
	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		const method = (init?.method ?? 'GET').toUpperCase();
		const body = init?.body ? JSON.parse(init.body as string) : undefined;
		calls.push({ method, path: url, body });
		const route = routes[`${method} ${url}`];
		if (!route) throw new Error(`unmocked ${method} ${url}`);
		const status = route.status ?? 200;
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => route.body,
			text: async () => (route.body === undefined ? '' : JSON.stringify(route.body))
		} as Response;
	});
	vi.stubGlobal('fetch', fetchMock);
	return calls;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe('createEmbedClient', () => {
	it('listCatalog calls the /embed route and returns the typed list', async () => {
		mockApi({
			'GET /embed/catalog?kind=input': {
				body: [{ typeId: 'aws-cloudtrail', name: 'AWS' }]
			}
		});
		const rows = await createEmbedClient().listCatalog('input');
		expect(rows).toEqual([{ typeId: 'aws-cloudtrail', name: 'AWS' }]);
	});

	it('buildIngress POSTs { inputId, name }', async () => {
		const calls = mockApi({
			'POST /embed/pipelines/ingress': {
				status: 201,
				body: { pipelineId: 'p1', outputId: 'o1', status: 'Running', active: true }
			}
		});
		const built = await createEmbedClient().buildIngress('in_1', 'CloudTrail');
		expect(built.active).toBe(true);
		expect(calls[0]?.body).toEqual({ inputId: 'in_1', name: 'CloudTrail' });
	});

	it('buildPipeline routes by kind (input → ingress, output → egress)', async () => {
		const pipe = { pipelineId: 'p', outputId: 'o', status: 'Running', active: true };
		const calls = mockApi({
			'POST /embed/pipelines/ingress': { status: 201, body: pipe },
			'POST /embed/pipelines/egress': { status: 201, body: pipe }
		});
		const monad = createEmbedClient();
		await monad.buildPipeline({ connectorId: 'in_1', kind: 'input', name: 'CT' });
		await monad.buildPipeline({ connectorId: 'out_1', kind: 'output', name: 'Splunk' });
		expect(calls.map((c) => c.path)).toEqual([
			'/embed/pipelines/ingress',
			'/embed/pipelines/egress'
		]);
		expect(calls[0]?.body).toEqual({ inputId: 'in_1', name: 'CT' });
		expect(calls[1]?.body).toEqual({ outputId: 'out_1', name: 'Splunk' });
	});

	it('honors a custom basePath', async () => {
		const calls = mockApi({ 'POST /api/monad/session': { body: {} } });
		await createEmbedClient({ basePath: '/api/monad' }).mintSession();
		expect(calls[0]?.path).toBe('/api/monad/session');
	});

	it('caches getConfig across calls', async () => {
		const calls = mockApi({
			'GET /embed/config': { body: { frameOrigin: 'https://app.monad.com/embed', apiBase: 'x' } }
		});
		const monad = createEmbedClient();
		await monad.getConfig();
		await monad.getConfig();
		expect(calls.filter((c) => c.path === '/embed/config')).toHaveLength(1);
	});

	it('iconUrl derives the icon endpoint from the frame origin', async () => {
		mockApi({
			'GET /embed/config': {
				body: { frameOrigin: 'https://app.monad.com/embed', apiBase: 'x' }
			}
		});
		const url = await createEmbedClient().iconUrl('aws-cloudtrail');
		expect(url).toBe('https://app.monad.com/external/icons/raw/aws-cloudtrail.svg');
	});

	it('throws EmbedRequestError carrying the contract error model', async () => {
		mockApi({
			'POST /embed/pipelines/ingress': {
				status: 502,
				body: { code: 'upstream_error', message: 'Monad API returned 503' }
			}
		});
		await expect(createEmbedClient().buildIngress('in_1', 'x')).rejects.toMatchObject({
			name: 'EmbedRequestError',
			status: 502,
			code: 'upstream_error'
		});
		expect(EmbedRequestError).toBeDefined();
	});

	describe('openConnectorForm', () => {
		function mockConfigAndSession() {
			return mockApi({
				'GET /embed/config': {
					body: { frameOrigin: 'https://app.monad.com/embed', apiBase: 'https://app.monad.com/api' }
				},
				'POST /embed/session': {
					body: { sessionToken: 'tok', organizationId: 'org_1', expiresAt: '2026-01-01T00:00:00Z' }
				}
			});
		}

		it('mints a session, resolves the frame origin, and mounts the form', async () => {
			mockConfigAndSession();
			await createEmbedClient().openConnectorForm({
				container: '#modal',
				kind: 'input',
				typeId: 'aws-cloudtrail'
			});
			expect(createConnectorFrame).toHaveBeenCalledWith(
				expect.objectContaining({
					container: '#modal',
					frameOrigin: 'https://app.monad.com/embed',
					apiBase: 'https://app.monad.com/api',
					sessionToken: 'tok',
					organizationId: 'org_1',
					kind: 'input',
					typeId: 'aws-cloudtrail'
				})
			);
		});

		it('auto-destroys on save and forwards the connector to onSave', async () => {
			mockConfigAndSession();
			const onSave = vi.fn();
			await createEmbedClient().openConnectorForm({
				container: '#modal',
				kind: 'input',
				typeId: 'aws-cloudtrail',
				onSave
			});
			const passed = createConnectorFrame.mock.calls[0]![0];
			passed.onSave!({ id: 'in_1', name: 'X' });
			expect(destroy).toHaveBeenCalledOnce();
			expect(onSave).toHaveBeenCalledWith({ id: 'in_1', name: 'X' });
		});

		it('leaves teardown to the caller when autoDestroy is false', async () => {
			mockConfigAndSession();
			await createEmbedClient().openConnectorForm({
				container: '#modal',
				kind: 'input',
				typeId: 'aws-cloudtrail',
				autoDestroy: false
			});
			createConnectorFrame.mock.calls[0]![0].onSave!({ id: 'in_1' });
			expect(destroy).not.toHaveBeenCalled();
		});

		it('autoBuild builds the pipeline on save and fires onConnected', async () => {
			mockApi({
				'GET /embed/config': {
					body: { frameOrigin: 'https://app.monad.com/embed', apiBase: 'https://app.monad.com/api' }
				},
				'POST /embed/session': {
					body: { sessionToken: 'tok', organizationId: 'org_1', expiresAt: 'x' }
				},
				'POST /embed/pipelines/ingress': {
					status: 201,
					body: { pipelineId: 'p1', outputId: 'out_store', status: 'Running', active: true }
				}
			});
			const onConnected = vi.fn();
			await createEmbedClient().openConnectorForm({
				container: '#modal',
				kind: 'input',
				typeId: 'aws-cloudtrail',
				autoBuild: true,
				onConnected
			});
			createConnectorFrame.mock.calls[0]![0].onSave!({ id: 'in_1', name: 'CT' });
			await vi.waitFor(() => expect(onConnected).toHaveBeenCalled());
			expect(onConnected).toHaveBeenCalledWith(
				expect.objectContaining({ pipelineId: 'p1', active: true })
			);
		});

		it('autoBuild routes a build failure to onBuildError with a working retry', async () => {
			const resp = (status: number, body: unknown) =>
				({
					ok: status >= 200 && status < 300,
					status,
					json: async () => body,
					text: async () => JSON.stringify(body)
				}) as Response;

			let ingressCalls = 0;
			vi.stubGlobal(
				'fetch',
				vi.fn(async (url: string, init?: RequestInit) => {
					const method = (init?.method ?? 'GET').toUpperCase();
					if (url === '/embed/config')
						return resp(200, { frameOrigin: 'https://app.monad.com/embed', apiBase: 'x' });
					if (method === 'POST' && url === '/embed/session')
						return resp(200, { sessionToken: 'tok', organizationId: 'org_1', expiresAt: 'x' });
					if (method === 'POST' && url === '/embed/pipelines/ingress') {
						ingressCalls += 1;
						return ingressCalls === 1
							? resp(502, { code: 'upstream_error', message: 'boom' })
							: resp(201, { pipelineId: 'p1', outputId: 'o', status: 'Running', active: true });
					}
					throw new Error(`unmocked ${method} ${url}`);
				})
			);

			const onConnected = vi.fn();
			const onBuildError = vi.fn();
			await createEmbedClient().openConnectorForm({
				container: '#modal',
				kind: 'input',
				typeId: 'aws-cloudtrail',
				autoBuild: true,
				onConnected,
				onBuildError
			});
			createConnectorFrame.mock.calls[0]![0].onSave!({ id: 'in_1', name: 'CT' });

			await vi.waitFor(() => expect(onBuildError).toHaveBeenCalled());
			const [err, retry] = onBuildError.mock.calls[0]!;
			expect(err).toMatchObject({ name: 'EmbedRequestError', status: 502, code: 'upstream_error' });
			expect(onConnected).not.toHaveBeenCalled();

			await retry();
			expect(onConnected).toHaveBeenCalledWith(expect.objectContaining({ pipelineId: 'p1' }));
		});
	});
});
