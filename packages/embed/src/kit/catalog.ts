/**
 * The catalog: what connector types you can offer, and what a tenant has
 * already configured. Both are plain Monad API reads behind your backend.
 */
import type { ComponentKind } from '../connect';
import type { MonadConfig } from './client';
import { monadRequest } from './client';

/** A connector type available to embed, e.g. `{ type_id: 'aws-cloudtrail', name: 'AWS CloudTrail' }`. */
export interface CatalogType {
	type_id: string;
	name: string;
}

/** A connector a tenant has already configured. */
export interface ConfiguredConnector {
	id: string;
	/** Connector type slug. Normalized from the API's `type` field (see listConnectors). */
	type_id: string;
	name: string;
}

/**
 * The connector types available for a kind ('input' | 'output'). Pass `allow`
 * to expose only the type_ids your product supports — the host-curated
 * allow-list. A real product rarely surfaces all 300+ connectors, and that
 * decision is yours to make server-side, not the end user's.
 */
export async function listCatalog(
	cfg: MonadConfig,
	kind: ComponentKind,
	allow?: string[]
): Promise<CatalogType[]> {
	const types = (await monadRequest(cfg)(`/v1/${kind}s`)) as CatalogType[];
	if (!allow || allow.length === 0) return types;
	const allowed = new Set(allow);
	return types.filter((t) => allowed.has(t.type_id));
}

/** The connectors a tenant has already configured, so you can show + manage them. */
export async function listConnectors(
	cfg: MonadConfig,
	org: string,
	kind: ComponentKind
): Promise<ConfiguredConnector[]> {
	// Configured rows come back wrapped as { inputs: [...] } / { outputs: [...] },
	// and carry the type slug as `type` — NOT `type_id`, which the catalog uses.
	// Normalize to `type_id` so the rest of your app has one consistent field.
	const page = (await monadRequest(cfg)(`/v1/${org}/${kind}s?limit=1000&offset=0`)) as Record<
		string,
		{ id: string; type: string; name: string }[]
	>;
	const rows = page[`${kind}s`] ?? [];
	return rows.map((r) => ({ id: r.id, type_id: r.type, name: r.name }));
}
