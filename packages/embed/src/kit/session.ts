/**
 * Session minting — trade your long-lived API key for a short-lived,
 * team-scoped token. The token (never the key) is what reaches the browser,
 * and from there the iframe over postMessage — so it stays out of history and
 * the Referer header.
 */
import type { MonadConfig } from './client';
import { monadRequest } from './client';

/**
 * A minted embed session, shaped to drop straight into `createConnectorFrame`
 * / `mountConnector` with no field remapping.
 *
 * Monad's `POST /v3/sessions` returns snake_case (`session_token`,
 * `expires_at`), but the iframe SDK expects `sessionToken` +
 * `organizationId`. Every host was remapping this by hand at the mount site
 * (see EMBED-GAPS #4). The kit does it once, here.
 */
export interface EmbedSession {
	/** Pass straight to `createConnectorFrame({ sessionToken })`. */
	sessionToken: string;
	/** The org the token is scoped to — pass to `createConnectorFrame({ organizationId })`. */
	organizationId: string;
	/** ISO-8601 expiry, so you can decide whether to re-mint before rendering. */
	expiresAt: string;
}

interface RawSession {
	session_token: string;
	expires_at: string;
}

/**
 * Mint an embed session scoped to one team (org). Call from your backend right
 * before rendering the form, mapping your own tenant → its Monad team. Default
 * TTL is 30 minutes.
 */
export async function mintSession(
	cfg: MonadConfig,
	organizationId: string,
	ttlSeconds = 1800
): Promise<EmbedSession> {
	const raw = (await monadRequest(cfg)('/v3/sessions', {
		method: 'POST',
		body: JSON.stringify({ ttl_seconds: ttlSeconds, organization_id: organizationId })
	})) as RawSession;
	return {
		sessionToken: raw.session_token,
		organizationId,
		expiresAt: raw.expires_at
	};
}
