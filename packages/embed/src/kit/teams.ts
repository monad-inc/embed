/**
 * Step 0 — per-customer teams. Each of your customers gets its own Monad team
 * (a sub-organization) under your org: data isolation, per-tenant limits, and
 * clean billing/audit boundaries. One API key, many teams — the multi-tenant
 * foundation everything else is scoped to.
 */
import type { MonadConfig } from './client';
import { monadRequest } from './client';

/**
 * Create a team under your org and return its id. Store that id against your
 * own tenant record, then scope all of that customer's connectors, pipelines,
 * and sessions to it.
 */
export async function provisionTeam(
	cfg: MonadConfig,
	opts: { parentOrgId: string; name: string; friendlyName: string }
): Promise<{ id: string }> {
	return (await monadRequest(cfg)(`/v3/${opts.parentOrgId}/organizations`, {
		method: 'POST',
		body: JSON.stringify({ name: opts.name, friendly_name: opts.friendlyName })
	})) as { id: string };
}
