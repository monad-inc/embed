/**
 * postMessage contract between the host page (@monad-inc/embed/connect) and
 * the Monad-hosted iframe (@monad-inc/embed-frame).
 *
 * Why a protocol module: both sides must agree on message shapes, and a
 * drifting contract is a silent failure (a message just gets ignored).
 * @monad-inc/embed/connect owns it because it's the public-facing SDK; the
 * iframe app imports these types from here.
 *
 * Security model:
 *  - Origin is the real boundary. Every listener validates
 *    `event.origin` against an expected value before trusting a
 *    message. The iframe knows its parent's origin (passed as a URL
 *    param); the host knows the frame's origin (it chose it).
 *  - `event.source` is also checked host-side so a sibling iframe on
 *    the same origin can't impersonate ours.
 *  - The `source: 'monad-embed'` tag is NOT security — it's just a
 *    cheap filter so unrelated postMessage traffic (analytics SDKs,
 *    devtools, wallet extensions) is ignored without parsing.
 *  - The session token travels in the `init` message body, never in
 *    the iframe URL, so it stays out of browser history and Referer.
 */

export const PROTOCOL_SOURCE = 'monad-embed' as const;
export const PROTOCOL_VERSION = 1 as const;

export type ComponentKind = 'input' | 'output';

/**
 * Appearance tokens the host may pass to theme the iframe. The iframe
 * applies each as a `--monad-{token}` CSS variable. The host cannot
 * style across the iframe boundary directly (same-origin policy), so
 * this is the only theming channel — same idea as Stripe's `appearance`.
 */
export interface Appearance {
	colorPrimary?: string;
	colorText?: string;
	colorBackground?: string;
	colorBorder?: string;
	fontFamily?: string;
	borderRadius?: string;
}

/* ===== iframe -> host ===== */

export interface ReadyMessage {
	source: typeof PROTOCOL_SOURCE;
	type: 'ready';
	version: number;
}

export interface ResizeMessage {
	source: typeof PROTOCOL_SOURCE;
	type: 'resize';
	/** Content height in CSS pixels — the host sizes the <iframe> to this. */
	height: number;
}

export interface SavedMessage {
	source: typeof PROTOCOL_SOURCE;
	type: 'saved';
	/** Safe reference to the created/updated connector — no secret material. */
	connector: { id: string; name?: string };
}

export interface ErrorMessage {
	source: typeof PROTOCOL_SOURCE;
	type: 'error';
	message: string;
}

export interface CancelMessage {
	source: typeof PROTOCOL_SOURCE;
	type: 'cancel';
}

export type FrameMessage =
	| ReadyMessage
	| ResizeMessage
	| SavedMessage
	| ErrorMessage
	| CancelMessage;

/* ===== host -> iframe ===== */

export interface InitMessage {
	source: typeof PROTOCOL_SOURCE;
	type: 'init';
	version: number;
	/** Short-lived embed session token minted by the host's backend. */
	sessionToken: string;
	/** Monad API base, e.g. "https://api.monad.com" or dev "http://localhost/api". */
	apiBase: string;
	/**
	 * Team org id the session token is scoped to. The iframe uses this to
	 * build `/v1/<org>/*` and `/v2/<org>/*` URLs. Must match the token's
	 * `org` claim — server-side `org_access.Middleware` will 403 if not.
	 */
	organizationId: string;
	/** Connector type id, e.g. "runzero-findings". */
	typeId: string;
	kind: ComponentKind;
	/** Display name shown in the frame header. */
	displayName?: string;
	/** Existing connector id — present for edit mode, absent for create. */
	existingId?: string;
	/**
	 * Whether the synthetic-data toggle is exposed in the form. Defaults
	 * to `false` (toggle hidden). Production embed customers keep this
	 * off — synthetic mode is a Monad-internal testing affordance.
	 */
	synthetic?: boolean;
	/** Theming tokens applied as CSS variables inside the iframe. */
	appearance?: Appearance;
	/**
	 * Stylesheet URLs the host wants to apply to the iframe page. The
	 * iframe loads these as `<link rel="stylesheet">` tags before
	 * rendering the form.
	 *
	 * All-or-nothing: if this array is present and non-empty, the
	 * iframe loads ONLY these stylesheets and does NOT load its
	 * built-in Monad UI defaults. If it's absent or empty, the iframe
	 * loads the built-in defaults and nothing else. Mixing host CSS
	 * with the defaults is intentionally not supported — partial
	 * styling tends to produce confusing half-themed forms.
	 *
	 * URLs MUST be reachable from the iframe origin (typically by
	 * being served from the host page's own origin, which the browser
	 * permits for stylesheet `<link>` loads even cross-origin).
	 */
	stylesheets?: string[];
}

export type HostMessage = InitMessage;
