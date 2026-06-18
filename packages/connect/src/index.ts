/**
 * @monad-inc/connect — host-side SDK for embedding Monad's connector-config
 * UI as a secure iframe.
 *
 * The customer's page calls `createConnectorFrame()`; this injects an
 * <iframe> pointing at a Monad-hosted page (@monad-inc/embed-frame). The
 * connector form — and every secret the user types into it — runs
 * inside that iframe on Monad's origin. Same-origin policy means the
 * customer's own JavaScript can never read those secrets. The customer
 * gets back only a connector id (a safe reference), the same way a
 * Stripe integration only ever sees a `pm_…` token.
 *
 * The host is still responsible for one thing: minting a short-lived
 * embed session token from its backend (POST /v1/embed/sessions, with
 * the long-lived API key) and handing it to `createConnectorFrame`.
 * That token travels into the iframe over postMessage, never the URL.
 */
import {
	PROTOCOL_SOURCE,
	PROTOCOL_VERSION,
	type Appearance,
	type ComponentKind,
	type FrameMessage,
	type HostMessage
} from './protocol';

export {
	PROTOCOL_SOURCE,
	PROTOCOL_VERSION,
	type Appearance,
	type ComponentKind,
	type FrameMessage,
	type HostMessage,
	type InitMessage
} from './protocol';

export {
	findIntegrationPipeline,
	setIntegrationEnabled,
	disableIntegration,
	enableIntegration,
	deleteIntegration,
	buildDevNullPipeline,
	CLEANUP_FULL,
	CLEANUP_KEEP_OUTPUT,
	CLEANUP_PIPELINE_ONLY,
	type MonadRequest,
	type ResolvedIntegration,
	type SetEnabledOptions,
	type DeleteIntegrationOptions,
	type CleanupPolicy,
	type BuildDevNullPipelineOptions,
	type BuiltPipeline
} from './lifecycle';

export interface ConnectorFrameOptions {
	/** DOM node (or selector) the iframe is appended to. */
	container: HTMLElement | string;
	/**
	 * URL of the Monad embed-frame page. Defaults to
	 * "https://app.monad.com/embed" (production). Override for staging
	 * ("https://app.monad.security/embed") or local testing
	 * ("http://localhost:5173/embed"). MUST be a different origin than
	 * the host page — that cross-origin boundary is what isolates the
	 * secrets. A path component is allowed (so the embed page can live
	 * at a sub-route of the main app); the postMessage security checks
	 * compare against the URL's origin, not its full href.
	 */
	frameOrigin?: string;
	/**
	 * Monad API base the iframe should call. Defaults to
	 * "https://app.monad.com/api" (production). Override for non-prod
	 * environments. Set this together with `frameOrigin` — mixing
	 * environments will not work.
	 */
	apiBase?: string;
	/** Connector type id, e.g. "runzero-findings". */
	typeId: string;
	kind: ComponentKind;
	/** Short-lived embed session token (host backend mints it). */
	sessionToken: string;
	/**
	 * Team org id the session is scoped to. The host backend already knows
	 * this — it's the same value passed to `/v1/embed/sessions` when minting
	 * the token. Forwarded into the iframe so it can build `/v1/<org>/*` and
	 * `/v2/<org>/*` URLs.
	 */
	organizationId: string;
	/** Display name shown in the frame header. */
	displayName?: string;
	/** Existing connector id — pass for edit mode, omit to create. */
	existingId?: string;
	/**
	 * Whether the synthetic-data toggle is exposed in the form. Defaults
	 * to `false` — production embed flows keep it hidden.
	 */
	synthetic?: boolean;
	/** Theming tokens applied as CSS variables inside the iframe. */
	appearance?: Appearance;
	/**
	 * Stylesheet URLs to apply inside the iframe. All-or-nothing: if
	 * any URL is provided, the iframe loads ONLY these and skips its
	 * built-in Monad UI defaults; if omitted/empty, the iframe loads
	 * the defaults and nothing else. URLs must be reachable from the
	 * iframe — typically served by the host page's own origin.
	 */
	stylesheets?: string[];
	/** Fired when the user saves successfully. */
	onSave?: (connector: { id: string; name?: string }) => void;
	/** Fired when the user cancels. */
	onCancel?: () => void;
	/** Fired on a save/test/load failure inside the iframe. */
	onError?: (message: string) => void;
}

export interface ConnectorFrame {
	/** Remove the iframe and stop listening for its messages. */
	destroy(): void;
}

/**
 * Production defaults. Customers integrating against prod don't pass
 * `frameOrigin`/`apiBase` at all; non-prod environments override both
 * together. Treat these as a public API contract — changing a hostname
 * is a breaking change for anyone on the default.
 */
const DEFAULT_FRAME_ORIGIN = 'https://app.monad.com/embed';
const DEFAULT_API_BASE = 'https://app.monad.com/api';

/**
 * Inject the Monad connector iframe into `container` and wire the
 * postMessage channel. Returns a handle whose `destroy()` tears it all
 * down.
 *
 * Handshake:
 *  1. iframe loads, posts `ready`;
 *  2. host replies with `init` (session token, type, appearance);
 *  3. iframe mounts the form and streams `resize` as content grows;
 *  4. on save, iframe posts `saved {connector}`; on cancel, `cancel`.
 */
export function createConnectorFrame(opts: ConnectorFrameOptions): ConnectorFrame {
	const container =
		typeof opts.container === 'string'
			? document.querySelector<HTMLElement>(opts.container)
			: opts.container;
	if (!container) {
		throw new Error('[monad-inc/connect] container element not found');
	}

	const frameInput = opts.frameOrigin ?? DEFAULT_FRAME_ORIGIN;
	const apiBase = opts.apiBase ?? DEFAULT_API_BASE;

	// Split the input URL into two pieces:
	//   * `frameUrl` keeps the path (e.g. /embed) — used as iframe.src.
	//   * `frameOrigin` is the bare origin — used for the postMessage
	//     security checks below, which must compare against the value
	//     the browser surfaces on MessageEvent.origin (always a bare
	//     origin, never a path).
	// Previously these were collapsed into one `new URL(...).href`,
	// which silently broke any frameOrigin with a path — the equality
	// check `event.origin !== frameOrigin` would always fail and `init`
	// never made it back to the iframe.
	const frameUrl = new URL(frameInput);
	const frameOrigin = frameUrl.origin;
	const framePath = frameUrl.pathname.replace(/\/$/, '');

	const iframe = document.createElement('iframe');
	iframe.className = 'monad-connect-frame';
	iframe.title = 'Monad connector configuration';
	iframe.style.width = '100%';
	iframe.style.border = '0';
	iframe.style.display = 'block';
	// The iframe needs its own scripts and same-origin access to the
	// Monad API; it must NOT get same-origin access to the host. A
	// cross-origin iframe already can't reach the host — no sandbox
	// attribute is needed for isolation, and adding one would block the
	// form's own scripts. Forms/popups stay enabled for OAuth-style
	// connectors that may open a window.
	iframe.allow = 'clipboard-write';
	// parentOrigin lets the iframe scope its postMessage target + sender
	// check. It is NOT a secret and NOT a capability — lying about it
	// only breaks the liar's own embed (see protocol.ts).
	iframe.src = `${frameOrigin}${framePath}/?parentOrigin=${encodeURIComponent(window.location.origin)}`;

	let destroyed = false;

	function postToFrame(msg: HostMessage): void {
		iframe.contentWindow?.postMessage(msg, frameOrigin);
	}

	function onMessage(event: MessageEvent): void {
		if (destroyed) return;
		// --- security boundary: validate before trusting anything ---
		if (event.origin !== frameOrigin) return;
		if (event.source !== iframe.contentWindow) return;
		const msg = event.data as FrameMessage | undefined;
		if (!msg || msg.source !== PROTOCOL_SOURCE) return;

		switch (msg.type) {
			case 'ready':
				postToFrame({
					source: PROTOCOL_SOURCE,
					type: 'init',
					version: PROTOCOL_VERSION,
					sessionToken: opts.sessionToken,
					apiBase,
					organizationId: opts.organizationId,
					typeId: opts.typeId,
					kind: opts.kind,
					displayName: opts.displayName,
					existingId: opts.existingId,
					synthetic: opts.synthetic,
					appearance: opts.appearance,
					stylesheets: opts.stylesheets
				});
				break;
			case 'resize': {
				// Clamp to a sane range so a renderer bug in the iframe
				// can't blow up the host layout with a multi-million-px
				// height. The origin check above already gates who can
				// send this — clamping is defense in depth. Number.isFinite
				// guards against non-numeric heights that would otherwise
				// produce "NaNpx" and leave the iframe collapsed.
				const h = Number.isFinite(msg.height) ? msg.height : 0;
				iframe.style.height = `${Math.min(Math.max(h, 0), 20000)}px`;
				break;
			}
			case 'saved':
				opts.onSave?.(msg.connector);
				break;
			case 'error':
				opts.onError?.(msg.message);
				break;
			case 'cancel':
				opts.onCancel?.();
				break;
		}
	}

	window.addEventListener('message', onMessage);
	container.appendChild(iframe);

	return {
		destroy(): void {
			destroyed = true;
			window.removeEventListener('message', onMessage);
			iframe.remove();
		}
	};
}
