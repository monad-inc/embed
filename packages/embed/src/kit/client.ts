/**
 * @monad-inc/embed/kit — the backend glue every embed integration needs
 * beyond the iframe + lifecycle helpers in `@monad-inc/embed/connect`.
 *
 * The connect module gives you two things: `createConnectorFrame()` (mount
 * the secure form) and a set of loose lifecycle helpers that each re-take a
 * `{ request, org, … }` bag. The kit closes the remaining gap: it binds your
 * API key + base ONCE into a small client, then exposes plain methods —
 * `mintSession`, `listCatalog`, `connectSource`, `connectDestination`,
 * status/enable/remove — so your route handlers read like the operation they
 * perform, not like plumbing.
 *
 * Everything here is backend-only: it carries your long-lived API key, so it
 * must never run in the browser. The one browser-side call (mounting the
 * iframe) still lives in `@monad-inc/embed/connect`.
 */
import type { MonadRequest } from '../connect';

/** Everything the backend half needs to talk to Monad. */
export interface MonadConfig {
	/** Long-lived Monad API key (JWT). Server-side only — never ship to the browser. */
	apiKey: string;
	/** Monad API base. Defaults to "https://app.monad.com/api" (production); set only for non-prod. */
	apiBase?: string;
}

/**
 * Build the authenticated request thunk the connect lifecycle helpers expect.
 * Every call carries your API key, so this only ever runs on your backend.
 * Exposed so you can drop down to a raw Monad call the kit doesn't wrap yet:
 * `monad.request('/v2/{org}/…', { method: 'POST', body })`.
 */
export function monadRequest(cfg: MonadConfig): MonadRequest {
	const apiBase = cfg.apiBase ?? 'https://app.monad.com/api';
	return async (path, init) => {
		const r = await fetch(`${apiBase}${path}`, {
			...init,
			headers: {
				'Content-Type': 'application/json',
				Authorization: `ApiKey ${cfg.apiKey}`,
				...(init?.headers ?? {})
			}
		});
		if (!r.ok) {
			throw new Error(`${r.status} ${path}: ${(await r.text()).slice(0, 300)}`);
		}
		const text = await r.text();
		return text ? JSON.parse(text) : undefined;
	};
}
