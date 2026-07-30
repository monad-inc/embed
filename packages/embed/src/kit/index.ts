/**
 * @monad-inc/embed/kit — the backend companion to `@monad-inc/embed/connect`.
 *
 * `connect` mounts the secure iframe and exposes low-level lifecycle helpers.
 * `kit` is the ergonomic layer on top: bind your API key + base ONCE with
 * `createEmbedClient`, then call plain methods. Scope to a tenant with
 * `.team(org)` and the org drops out of every subsequent call.
 *
 *   import { createEmbedClient } from '@monad-inc/embed/kit';
 *
 *   const monad = createEmbedClient({ apiKey: process.env.MONAD_API_KEY!, apiBase });
 *   const team = monad.team(tenant.orgId);
 *
 *   // backend route: hand a session to the browser
 *   const session = await team.mintSession();           // → { sessionToken, organizationId, expiresAt }
 *
 *   // backend route: the iframe returned an input id — make data flow
 *   const built = await team.connectSource({ inputId, name: 'AWS CloudTrail' });
 *
 * Every function is also exported standalone (taking an explicit `cfg` +
 * `org`) if you'd rather not hold a client. The types are exported too, so you
 * import them instead of copying a mini-library out of a demo.
 */
import type { MonadRequest, BuiltPipeline, CleanupPolicy, ComponentKind } from '../connect';
import type { MonadConfig } from './client';
import { monadRequest } from './client';
import { mintSession, type EmbedSession } from './session';
import { listCatalog, listConnectors, type CatalogType, type ConfiguredConnector } from './catalog';
import {
	wirePipeline,
	connectSource,
	connectDestination,
	pipelineStatus,
	findPipelineByOutput,
	setEnabled,
	remove,
	removeIngress,
	removeEgress,
	type ResolvedEgress
} from './pipeline';
import { provisionTeam } from './teams';

/* ===== re-exports: config-free functions + all types ===== */

export type { MonadConfig } from './client';
export { monadRequest } from './client';
export type { EmbedSession } from './session';
export { mintSession } from './session';
export type { CatalogType, ConfiguredConnector } from './catalog';
export { listCatalog, listConnectors } from './catalog';
export type { ResolvedEgress } from './pipeline';
export {
	wirePipeline,
	connectSource,
	connectDestination,
	pipelineStatus,
	findPipelineByOutput,
	setEnabled,
	remove,
	removeIngress,
	removeEgress
} from './pipeline';
export { provisionTeam } from './teams';

// Convenience re-exports so a kit user gets the pipeline result type + cleanup
// presets without also reaching into '@monad-inc/embed/connect'.
export {
	CLEANUP_FULL,
	CLEANUP_KEEP_OUTPUT,
	CLEANUP_PIPELINE_ONLY,
	type BuiltPipeline,
	type CleanupPolicy,
	type ComponentKind,
	type MonadRequest
} from '../connect';

/* ===== org-scoped client (the common case) ===== */

type PipelineStatus = Awaited<ReturnType<typeof pipelineStatus>>;

/**
 * A client bound to one tenant's team (org). Every method that needed an `org`
 * has it baked in — the shape a backend request handler actually wants, since
 * a request is always in one tenant's context.
 */
export interface TeamClient {
	/** The org this handle is scoped to. */
	readonly org: string;
	mintSession(ttlSeconds?: number): Promise<EmbedSession>;
	listConnectors(kind: ComponentKind): Promise<ConfiguredConnector[]>;
	wirePipeline(opts: { inputId: string; outputId: string; name: string }): Promise<BuiltPipeline>;
	/** Ingress: user configured an input → wire to your store, or dev/null if omitted. */
	connectSource(opts: {
		inputId: string;
		name: string;
		toOutputId?: string;
	}): Promise<BuiltPipeline>;
	/** Egress: user configured an output → wire your pre-provisioned source to it. */
	connectDestination(opts: {
		outputId: string;
		name: string;
		fromInputId: string;
	}): Promise<BuiltPipeline>;
	/** Resolve a pipeline + enabled state from an input id. */
	pipelineStatus(inputId: string): Promise<PipelineStatus>;
	/** Resolve an egress pipeline from an output id. */
	findPipelineByOutput(outputId: string): Promise<ResolvedEgress | null>;
	setEnabled(opts: { pipelineId: string; enabled: boolean }): Promise<void>;
	remove(opts: {
		pipelineId?: string;
		inputId?: string;
		outputId?: string;
		cleanup?: CleanupPolicy;
	}): Promise<void>;
	removeIngress(opts: {
		pipelineId?: string;
		inputId?: string;
		outputId?: string;
		keepStore: boolean;
	}): Promise<void>;
	removeEgress(opts: { pipelineId?: string; outputId?: string }): Promise<void>;
}

/** A client bound to your Monad config. `.team(org)` scopes it to a tenant. */
export interface EmbedClient {
	readonly config: MonadConfig;
	/** The raw authenticated request thunk, for calls the kit doesn't wrap yet. */
	readonly request: MonadRequest;
	/** Step 0: create a new tenant's team under your org. */
	provisionTeam(opts: { parentOrgId: string; name: string; friendlyName: string }): Promise<{
		id: string;
	}>;
	/** The connector catalog for a kind, optionally filtered to your allow-list. */
	listCatalog(kind: ComponentKind, allow?: string[]): Promise<CatalogType[]>;
	/** Mint a session scoped to `org`. */
	mintSession(org: string, ttlSeconds?: number): Promise<EmbedSession>;
	/** Bind every org-scoped method to one tenant. */
	team(org: string): TeamClient;
}

/**
 * Create a client bound to your Monad config. Hold one per process (your API
 * key doesn't change) and call `.team(org)` per request.
 */
export function createEmbedClient(config: MonadConfig): EmbedClient {
	return {
		config,
		request: monadRequest(config),
		provisionTeam: (opts) => provisionTeam(config, opts),
		listCatalog: (kind, allow) => listCatalog(config, kind, allow),
		mintSession: (org, ttlSeconds) => mintSession(config, org, ttlSeconds),
		team: (org) => ({
			org,
			mintSession: (ttlSeconds) => mintSession(config, org, ttlSeconds),
			listConnectors: (kind) => listConnectors(config, org, kind),
			wirePipeline: (opts) => wirePipeline(config, { org, ...opts }),
			connectSource: (opts) => connectSource(config, { org, ...opts }),
			connectDestination: (opts) => connectDestination(config, { org, ...opts }),
			pipelineStatus: (inputId) => pipelineStatus(config, { org, inputId }),
			findPipelineByOutput: (outputId) => findPipelineByOutput(config, { org, outputId }),
			setEnabled: (opts) => setEnabled(config, { org, ...opts }),
			remove: (opts) => remove(config, { org, ...opts }),
			removeIngress: (opts) => removeIngress(config, { org, ...opts }),
			removeEgress: (opts) => removeEgress(config, { org, ...opts })
		})
	};
}
