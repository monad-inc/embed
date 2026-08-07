/**
 * @monad-inc/embed-server — the backend `/embed` router, framework-agnostic core.
 *
 * A standalone, self-contained implementation of the `/embed` route contract
 * (see the repo's `packages/embed/openapi/embed.openapi.yaml`). It depends on
 * nothing but its own inlined Monad client (`./monad`), so this package stands
 * on its own — lift it and go.
 *
 * `createEmbedHandler` returns a plain `(EmbedRequest) => EmbedResponse` with
 * ZERO runtime dependencies. A framework adapter (`./node`) turns it into a
 * mountable router.
 */
import { MonadApi, UpstreamError, type ComponentKind } from './monad';

/** What the host pre-provisions per tenant — resolved server-side, never sent by the browser. */
export interface Provision {
	/** Ingress target: the tenant's destination output. Omit to send ingress to a dev/null sink. */
	destinationOutputId?: string;
	/** Egress source: the tenant's pre-provisioned input. Required to build an egress pipeline. */
	sourceInputId?: string;
}

/** A request normalized to the shape the core dispatches on. */
export interface EmbedRequest {
	method: string;
	/** Path within the `/embed` mount, e.g. `/session`, `/pipelines/ingress`. */
	path: string;
	query: Record<string, string | undefined>;
	headers: Record<string, string | undefined>;
	body?: unknown;
	/** The native framework request, passed to `getCustomerOrgID` so it can read the host's auth. */
	raw?: unknown;
}

/** A response the adapter serializes as JSON (or an empty 204). */
export interface EmbedResponse {
	status: number;
	body?: unknown;
}

/** Configuration shared by every language's router. */
export interface EmbedServerConfig {
	/** Long-lived Monad API key. Server-side only. */
	apiKey: string;
	/** Monad API base. Defaults to `https://app.monad.com/api` (production); set only for non-prod. */
	apiBase?: string;
	/**
	 * Iframe origin returned by `GET /embed/config`. Defaults to
	 * `https://app.monad.com/embed` (production); set only for non-prod.
	 */
	frameOrigin?: string;
	/**
	 * Map the authenticated request to the caller's Monad team id. The one seam
	 * only the host can fill. Throw an {@link EmbedError} (or any error → 401) to
	 * reject an unauthenticated/unauthorized caller.
	 */
	getCustomerOrgID: (req: EmbedRequest) => string | Promise<string>;
	/** Per-tenant pre-provisioned resources. Omit → ingress uses dev/null and egress is unavailable. */
	getProvisionedComponents?: (org: string) => Provision | Promise<Provision>;
	/** Restrict the catalog to these connector type ids. Omit → expose everything. */
	catalogAllow?: string[];
}

/** An error carrying the HTTP status + stable code from the contract's error model. */
export class EmbedError extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string,
		message: string
	) {
		super(message);
		this.name = 'EmbedError';
	}
}

const json = (status: number, body: unknown): EmbedResponse => ({ status, body });
const noContent = (): EmbedResponse => ({ status: 204 });

function requireString(body: unknown, field: string): string {
	const v = (body as Record<string, unknown> | undefined)?.[field];
	if (typeof v !== 'string' || v.length === 0) {
		throw new EmbedError(400, 'invalid_request', `Field '${field}' is required.`);
	}
	return v;
}

function requireBoolean(body: unknown, field: string): boolean {
	const v = (body as Record<string, unknown> | undefined)?.[field];
	if (typeof v !== 'boolean') {
		throw new EmbedError(400, 'invalid_request', `Field '${field}' must be a boolean.`);
	}
	return v;
}

function requireKind(value: string | undefined, where: string): ComponentKind {
	if (value !== 'input' && value !== 'output') {
		throw new EmbedError(400, 'invalid_request', `${where} must be 'input' or 'output'.`);
	}
	return value;
}

/** Wrap a Monad call so any failure surfaces as the contract's `502 upstream_error`. */
async function upstream<T>(p: Promise<T>): Promise<T> {
	try {
		return await p;
	} catch (e) {
		// Translate Monad's own status codes into the contract's error model.
		if (e instanceof UpstreamError) {
			if (e.status === 404) {
				throw new EmbedError(
					404,
					'not_found',
					'The referenced connector or pipeline does not exist.'
				);
			}
			if (e.status === 409) {
				throw new EmbedError(409, 'conflict', 'The request conflicts with existing state.');
			}
		}
		// Anything else: log the detail server-side, return a generic 502.
		console.error('[embed] upstream Monad API call failed:', e);
		throw new EmbedError(502, 'upstream_error', 'The upstream Monad API request failed.');
	}
}

/** Build the framework-agnostic `/embed` handler. Hold one per process. */
export function createEmbedHandler(
	config: EmbedServerConfig
): (req: EmbedRequest) => Promise<EmbedResponse> {
	// Production defaults — override apiBase/frameOrigin only for non-prod.
	const apiBase = config.apiBase ?? 'https://app.monad.com/api';
	const frameOrigin = config.frameOrigin ?? 'https://app.monad.com/embed';
	const monad = new MonadApi(config.apiKey, apiBase);

	async function resolve(req: EmbedRequest): Promise<string> {
		try {
			const org = await config.getCustomerOrgID(req);
			if (!org) {
				throw new EmbedError(401, 'unauthenticated', 'Could not resolve a tenant for the request.');
			}
			return org;
		} catch (e) {
			if (e instanceof EmbedError) throw e;
			throw new EmbedError(
				401,
				'unauthenticated',
				e instanceof Error ? e.message : 'Tenant resolution failed.'
			);
		}
	}

	async function provision(org: string): Promise<Provision> {
		return config.getProvisionedComponents ? await config.getProvisionedComponents(org) : {};
	}

	async function dispatch(req: EmbedRequest): Promise<EmbedResponse> {
		const method = req.method.toUpperCase();
		const path = req.path || '/';

		if (method === 'GET' && path === '/config') {
			return json(200, { frameOrigin, apiBase });
		}

		if (method === 'POST' && path === '/session') {
			const org = await resolve(req);
			return json(200, await upstream(monad.mintSession(org)));
		}

		if (method === 'GET' && path === '/catalog') {
			await resolve(req);
			const kind = requireKind(req.query.kind, "Query 'kind'");
			return json(200, await upstream(monad.listCatalog(kind, config.catalogAllow)));
		}

		if (method === 'GET' && path === '/connectors') {
			const org = await resolve(req);
			const kind = requireKind(req.query.kind, "Query 'kind'");
			return json(200, await upstream(monad.listConnectors(org, kind)));
		}

		if (method === 'POST' && path === '/pipelines/ingress') {
			const org = await resolve(req);
			const inputId = requireString(req.body, 'inputId');
			const name = requireString(req.body, 'name');
			const prov = await provision(org);
			const built = await upstream(
				monad.connectSource(org, { inputId, name, toOutputId: prov.destinationOutputId })
			);
			return json(201, built);
		}

		if (method === 'POST' && path === '/pipelines/egress') {
			const org = await resolve(req);
			const outputId = requireString(req.body, 'outputId');
			const name = requireString(req.body, 'name');
			const prov = await provision(org);
			if (!prov.sourceInputId) {
				throw new EmbedError(
					500,
					'internal_error',
					'No source input is provisioned for this tenant; egress cannot be built.'
				);
			}
			const built = await upstream(
				monad.connectDestination(org, { outputId, name, fromInputId: prov.sourceInputId })
			);
			return json(201, built);
		}

		if (method === 'GET' && path === '/pipelines') {
			const org = await resolve(req);
			const connectorId = req.query.connectorId;
			if (!connectorId) {
				throw new EmbedError(400, 'invalid_request', "Query 'connectorId' is required.");
			}
			const kind = requireKind(req.query.kind, "Query 'kind'");
			return json(200, await upstream(monad.pipelineFor(org, kind, connectorId)));
		}

		if (method === 'POST' && path === '/pipelines/state') {
			const org = await resolve(req);
			const pipelineId = requireString(req.body, 'pipelineId');
			const enabled = requireBoolean(req.body, 'enabled');
			await upstream(monad.setEnabled(org, pipelineId, enabled));
			return noContent();
		}

		if (method === 'POST' && path === '/pipelines/remove') {
			const org = await resolve(req);
			const connectorId = requireString(req.body, 'connectorId');
			const kind = requireKind(
				(req.body as Record<string, unknown> | undefined)?.kind as string | undefined,
				"Field 'kind'"
			);
			const status = await upstream(monad.pipelineFor(org, kind, connectorId));
			if (kind === 'input') {
				const prov = await provision(org);
				const keepStore = Boolean(
					prov.destinationOutputId &&
					status.outputId &&
					prov.destinationOutputId === status.outputId
				);
				await upstream(
					monad.remove(
						org,
						{ pipelineId: status.pipelineId, inputId: connectorId, outputId: status.outputId },
						{ output: !keepStore }
					)
				);
			} else {
				// Keep the shared source input; remove only the pipeline + output.
				await upstream(
					monad.remove(
						org,
						{ pipelineId: status.pipelineId, outputId: connectorId },
						{ input: false }
					)
				);
			}
			return noContent();
		}

		return json(404, { code: 'not_found', message: `No route for ${method} ${path}.` });
	}

	return async (req: EmbedRequest): Promise<EmbedResponse> => {
		try {
			return await dispatch(req);
		} catch (e) {
			if (e instanceof EmbedError) {
				return json(e.status, { code: e.code, message: e.message });
			}
			console.error('[embed] unexpected error handling request:', e);
			return json(500, {
				code: 'internal_error',
				message: 'An unexpected error occurred.'
			});
		}
	};
}
