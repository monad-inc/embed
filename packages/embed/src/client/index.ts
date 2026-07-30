/**
 * @monad-inc/embed/client — the browser-side client for the `/embed` routes.
 *
 * This is the frontend counterpart to the backend routers (`@monad-inc/embed-server`
 * and the Go/Python ports): both speak the same `/embed` contract. Once you've
 * mounted a router on your backend, this client calls those routes from the
 * browser so you don't hand-roll `fetch('/embed/…')` calls or the
 * mint-session-then-mount-the-form dance.
 *
 *   import { createEmbedClient } from '@monad-inc/embed/client';
 *
 *   const monad = createEmbedClient();                 // defaults to your '/embed' base path
 *   const catalog = await monad.listCatalog('input');
 *
 *   // one call: mint a session, fetch the frame origin, mount the form
 *   card.onclick = () =>
 *     monad.openConnectorForm({
 *       container: '#connector-modal',
 *       kind: 'input',
 *       typeId: type.typeId,
 *       onSave: ({ id, name }) => monad.buildIngress(id, name ?? type.name),
 *     });
 *
 * The low-level iframe primitive (`createConnectorFrame`) lives in
 * `@monad-inc/embed/connect`; this client wraps it. It never sees your API key —
 * that stays behind your `/embed` routes.
 */
import {
	createConnectorFrame,
	type Appearance,
	type ComponentKind,
	type ConnectorFrame
} from '../connect';

export type { Appearance, ComponentKind, ConnectorFrame } from '../connect';

/* ===== contract response shapes (camelCase, mirroring the /embed spec) ===== */

export interface EmbedConfigResponse {
	frameOrigin: string;
	apiBase: string;
}

export interface EmbedSession {
	sessionToken: string;
	organizationId: string;
	expiresAt: string;
}

export interface CatalogType {
	typeId: string;
	name: string;
}

export interface ConfiguredConnector {
	id: string;
	typeId: string;
	name: string;
}

export interface BuiltPipeline {
	pipelineId: string;
	outputId: string;
	status: string;
	active: boolean;
}

export interface PipelineStatus {
	hasPipeline: boolean;
	enabled: boolean;
	pipelineId?: string;
	inputId?: string;
	outputId?: string;
}

/** Thrown on a non-2xx from an `/embed` route, carrying the contract's error model. */
export class EmbedRequestError extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string,
		message: string
	) {
		super(message);
		this.name = 'EmbedRequestError';
	}
}

export interface EmbedClientOptions {
	/** Where your backend mounted the routes. Defaults to `/embed`. */
	basePath?: string;
	/** Passed to every `fetch`. Defaults to `'same-origin'` (sends your cookies). */
	credentials?: RequestCredentials;
	/** Extra headers on every request — e.g. a CSRF token. */
	headers?: Record<string, string>;
}

export interface OpenConnectorFormOptions {
	/** DOM node (or selector) the iframe is appended to. */
	container: HTMLElement | string;
	/** `'input'` (a source) or `'output'` (a destination). */
	kind: ComponentKind;
	/** Connector type slug, e.g. `'aws-cloudtrail'`. */
	typeId: string;
	/**
	 * Name for the created connector. Omit and the form appends a unique suffix
	 * to the type name, so two connectors of the same type don't collide.
	 */
	name?: string;
	/** Title shown in the iframe header. */
	displayName?: string;
	/** Description for the created connector (create only). */
	description?: string;
	/** Let the end user edit the name inside the iframe (default off). */
	isNameEditable?: boolean;
	/** Let the end user edit the description inside the iframe (default off). */
	isDescriptionEditable?: boolean;
	/** Pass to edit an existing connector; omit to create a new one. */
	existingId?: string;
	/** Exposes Monad's internal synthetic-data toggle. Keep off in production. */
	synthetic?: boolean;
	/** Theming tokens applied inside the iframe. */
	appearance?: Appearance;
	/** Full-CSS escape hatch (all-or-nothing). */
	stylesheets?: string[];
	/**
	 * Destroy the iframe automatically when the user saves or cancels. Default
	 * `true` — your `onSave`/`onCancel` run after teardown. Set `false` to manage
	 * the returned handle's lifecycle yourself.
	 */
	autoDestroy?: boolean;
	/**
	 * After a successful save, build the pipeline too — the direction follows
	 * `kind` (input → ingress, output → egress). Collapses "open the form" and
	 * "turn the connector into a running pipeline" into one declaration. Default
	 * `false`. Handle the result with `onConnected` / `onBuildError`.
	 *
	 * Important: the form can save while the *build* fails, leaving a connector
	 * with no pipeline behind it. That failure goes to `onBuildError` (with a
	 * ready-made `retry`), never swallowed — so you can offer a "finish setup".
	 */
	autoBuild?: boolean;
	/** Fired with the running pipeline when `autoBuild` succeeds. */
	onConnected?: (pipeline: BuiltPipeline) => void;
	/**
	 * Fired when `autoBuild`'s build fails. `retry` re-attempts the same build
	 * (same connector) and again resolves to `onConnected` / `onBuildError`.
	 */
	onBuildError?: (error: EmbedRequestError, retry: () => Promise<void>) => void;
	/** Fired when the user saves successfully. */
	onSave?: (connector: { id: string; name?: string }) => void;
	/** Fired when the user cancels. */
	onCancel?: () => void;
	/** Fired on a save/test/load failure inside the iframe. */
	onError?: (message: string) => void;
}

/** A browser client bound to your `/embed` routes. */
export interface EmbedClient {
	/** `GET /embed/config` — the iframe origin + API base (cached after first call). */
	getConfig(): Promise<EmbedConfigResponse>;
	/** `POST /embed/session` — a fresh short-lived, team-scoped token. */
	mintSession(): Promise<EmbedSession>;
	/** `GET /embed/catalog` — the connector types you offer for a kind. */
	listCatalog(kind: ComponentKind): Promise<CatalogType[]>;
	/** `GET /embed/connectors` — the connectors this tenant has configured. */
	listConnectors(kind: ComponentKind): Promise<ConfiguredConnector[]>;
	/**
	 * Mint a session, resolve the frame origin, and mount the connector form —
	 * the whole "open the form" flow in one call. Returns the frame handle.
	 */
	openConnectorForm(opts: OpenConnectorFormOptions): Promise<ConnectorFrame>;
	/**
	 * Build the pipeline for a configured connector — direction follows `kind`
	 * (input → ingress, output → egress), so you don't pick a route. Sugar over
	 * `buildIngress` / `buildEgress`.
	 */
	buildPipeline(opts: {
		connectorId: string;
		kind: ComponentKind;
		name: string;
	}): Promise<BuiltPipeline>;
	/** `POST /embed/pipelines/ingress` — wire a configured input into a running pipeline. */
	buildIngress(inputId: string, name: string): Promise<BuiltPipeline>;
	/** `POST /embed/pipelines/egress` — wire your source into the configured output. */
	buildEgress(outputId: string, name: string): Promise<BuiltPipeline>;
	/** `GET /embed/pipelines` — resolve a connector's pipeline + enabled state. */
	pipelineStatus(connectorId: string, kind: ComponentKind): Promise<PipelineStatus>;
	/** `POST /embed/pipelines/state` — enable or disable without deleting config. */
	setPipelineState(pipelineId: string, enabled: boolean): Promise<void>;
	/** `POST /embed/pipelines/remove` — tear down the integration behind a connector. */
	removeIntegration(connectorId: string, kind: ComponentKind): Promise<void>;
	/** The vendor logo URL for a connector type, from Monad's icon endpoint. */
	iconUrl(typeId: string): Promise<string>;
}

const enc = encodeURIComponent;

/** Create a client for the `/embed` routes your backend mounted. */
export function createEmbedClient(options: EmbedClientOptions = {}): EmbedClient {
	const basePath = (options.basePath ?? '/embed').replace(/\/$/, '');
	const credentials = options.credentials ?? 'same-origin';
	const baseHeaders = options.headers ?? {};
	let configPromise: Promise<EmbedConfigResponse> | undefined;

	async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
		const headers: Record<string, string> = { ...baseHeaders };
		const init: RequestInit = { method, credentials, headers };
		if (body !== undefined) {
			headers['Content-Type'] = 'application/json';
			init.body = JSON.stringify(body);
		}
		const r = await fetch(`${basePath}${path}`, init);
		if (!r.ok) {
			let payload: { code?: string; message?: string } | undefined;
			try {
				payload = await r.json();
			} catch {
				// non-JSON error body — fall back to a generic message
			}
			throw new EmbedRequestError(
				r.status,
				payload?.code ?? 'request_failed',
				payload?.message ?? `${method} ${path} failed with ${r.status}`
			);
		}
		if (r.status === 204) return undefined as T;
		const text = await r.text();
		if (!text) return undefined as T;
		try {
			return JSON.parse(text) as T;
		} catch {
			// A 2xx with a non-JSON body — typically an auth redirect / login HTML
			// page served because the host session expired. Surface it as a
			// branded EmbedRequestError instead of a raw SyntaxError.
			throw new EmbedRequestError(
				r.status,
				'invalid_response',
				`${method} ${path} returned a non-JSON response (status ${r.status}); the host session may have expired.`
			);
		}
	}

	const client: EmbedClient = {
		getConfig() {
			return (configPromise ??= req<EmbedConfigResponse>('GET', '/config'));
		},
		mintSession() {
			return req<EmbedSession>('POST', '/session');
		},
		listCatalog(kind) {
			return req<CatalogType[]>('GET', `/catalog?kind=${enc(kind)}`);
		},
		listConnectors(kind) {
			return req<ConfiguredConnector[]>('GET', `/connectors?kind=${enc(kind)}`);
		},
		buildPipeline({ connectorId, kind, name }) {
			return kind === 'input'
				? client.buildIngress(connectorId, name)
				: client.buildEgress(connectorId, name);
		},
		buildIngress(inputId, name) {
			return req<BuiltPipeline>('POST', '/pipelines/ingress', { inputId, name });
		},
		buildEgress(outputId, name) {
			return req<BuiltPipeline>('POST', '/pipelines/egress', { outputId, name });
		},
		pipelineStatus(connectorId, kind) {
			return req<PipelineStatus>(
				'GET',
				`/pipelines?connectorId=${enc(connectorId)}&kind=${enc(kind)}`
			);
		},
		setPipelineState(pipelineId, enabled) {
			return req<void>('POST', '/pipelines/state', { pipelineId, enabled });
		},
		removeIntegration(connectorId, kind) {
			return req<void>('POST', '/pipelines/remove', { connectorId, kind });
		},
		async iconUrl(typeId) {
			const { frameOrigin } = await client.getConfig();
			return `${new URL(frameOrigin).origin}/external/icons/raw/${enc(typeId)}.svg`;
		},
		async openConnectorForm(opts) {
			const [config, session] = await Promise.all([client.getConfig(), client.mintSession()]);
			const autoDestroy = opts.autoDestroy ?? true;
			const frame: ConnectorFrame = createConnectorFrame({
				container: opts.container,
				frameOrigin: config.frameOrigin,
				apiBase: config.apiBase,
				sessionToken: session.sessionToken,
				organizationId: session.organizationId,
				kind: opts.kind,
				typeId: opts.typeId,
				name: opts.name,
				displayName: opts.displayName,
				description: opts.description,
				isNameEditable: opts.isNameEditable,
				isDescriptionEditable: opts.isDescriptionEditable,
				existingId: opts.existingId,
				synthetic: opts.synthetic,
				appearance: opts.appearance,
				stylesheets: opts.stylesheets,
				onSave: (connector) => {
					if (autoDestroy) frame.destroy();
					opts.onSave?.(connector);
					if (opts.autoBuild) {
						const name = connector.name ?? opts.name ?? opts.typeId;
						const runBuild = async (): Promise<void> => {
							try {
								const pipeline = await client.buildPipeline({
									connectorId: connector.id,
									kind: opts.kind,
									name
								});
								opts.onConnected?.(pipeline);
							} catch (e) {
								const err =
									e instanceof EmbedRequestError
										? e
										: new EmbedRequestError(
												0,
												'build_failed',
												e instanceof Error ? e.message : 'Pipeline build failed.'
											);
								// Never swallow a build failure — the connector exists with no
								// pipeline. Route it to onBuildError (with retry), else onError.
								if (opts.onBuildError) opts.onBuildError(err, runBuild);
								else opts.onError?.(err.message);
							}
						};
						void runBuild();
					}
				},
				onCancel: () => {
					if (autoDestroy) frame.destroy();
					opts.onCancel?.();
				},
				onError: opts.onError
			});
			return frame;
		}
	};
	return client;
}
