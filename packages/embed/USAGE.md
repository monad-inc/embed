# Using `@monad-inc/embed/connect`

Host-side SDK for embedding Monad's connector-config UI into your own
product. The form runs inside a Monad-hosted iframe — every secret a
user types (AWS keys, OAuth tokens, etc.) stays on Monad's origin and
is never visible to your application's JavaScript. Same isolation
model as Stripe Elements and Plaid Link.

---

## Install

```bash
npm install @monad-inc/embed
```

ESM and CJS builds ship side-by-side, with full TypeScript types.
Zero runtime dependencies.

---

## How it works

Two pieces of code: a **session-mint endpoint on your backend** mints
a short-lived, team-scoped token from your long-lived Monad API key,
and a **`createConnectorFrame()` call on your frontend** mounts the
iframe using that token. Both shown below.

---

## Step 1 — Mint a session token from your backend

Your backend exchanges its long-lived Monad API key for a short-lived,
team-scoped session token, then hands that token to your frontend.

Example (any HTTP framework — shown here as a Next.js Route Handler):

```ts
// app/api/monad/session/route.ts
export async function POST(req: Request) {
	const { teamId } = await req.json(); // your tenant → Monad team mapping

	const r = await fetch('https://app.monad.com/api/v3/sessions', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `ApiKey ${process.env.MONAD_API_KEY}`
		},
		body: JSON.stringify({
			organization_id: teamId,
			ttl_seconds: 1800
		})
	});
	const { session_token, expires_at } = await r.json();
	return Response.json({ session_token, expires_at, organizationId: teamId });
}
```

Returns:

```json
{
	"session_token": "eyJhbGc…",
	"expires_at": "2026-05-26T18:30:00Z",
	"organizationId": "7f93b302-fdb8-40e9-83c5-f9e555b91477"
}
```

The `session_token` is what your frontend hands to `createConnectorFrame`.
**Never put your long-lived `MONAD_API_KEY` in browser code.**

---

## Step 2 — Mount the iframe on your frontend

```ts
import { createConnectorFrame } from '@monad-inc/embed/connect';

// Fetch a fresh session from your own backend.
const { session_token, organizationId } = await fetch('/api/monad/session', {
	method: 'POST',
	body: JSON.stringify({ teamId: currentUser.teamId })
}).then((r) => r.json());

const frame = createConnectorFrame({
	container: '#monad-connector-mount',
	sessionToken: session_token,
	organizationId,
	kind: 'input', // 'input' or 'output'
	typeId: 'aws-cloudtrail', // see the connector catalog
	onSave: ({ id }) => {
		console.log('connector created', id);
		frame.destroy();
	},
	onCancel: () => frame.destroy()
});
```

That's it. The form renders inside the iframe; the user fills it in
and clicks Save; you get a connector `id` back. The iframe handles
its own Save / Test connection / Cancel buttons — your page only
controls the surrounding chrome.

---

## `createConnectorFrame` options

| Option           | Type                         | Required | Default                       | Description                                                                          |
| ---------------- | ---------------------------- | -------- | ----------------------------- | ------------------------------------------------------------------------------------ |
| `container`      | `HTMLElement \| string`      | ✅       | —                             | Element (or CSS selector) the iframe is appended to.                                 |
| `sessionToken`   | `string`                     | ✅       | —                             | Short-lived token from `POST /v3/sessions` (your backend mints this).                |
| `organizationId` | `string`                     | ✅       | —                             | Monad team org id the session is scoped to. Same value you passed to `/v3/sessions`. |
| `kind`           | `'input' \| 'output'`        | ✅       | —                             | Which catalog the connector belongs to.                                              |
| `typeId`         | `string`                     | ✅       | —                             | Connector type slug, e.g. `'aws-cloudtrail'`, `'okta-systemlog'`.                    |
| `existingId`     | `string`                     | ⛔       | —                             | Pass to edit an existing connector. Omit to create a new one.                        |
| `displayName`    | `string`                     | ⛔       | the connector type's name     | Title shown in the iframe header.                                                    |
| `appearance`     | `Appearance`                 | ⛔       | Monad defaults                | Theming tokens (see below).                                                          |
| `synthetic`      | `boolean`                    | ⛔       | `false`                       | Exposes Monad's internal synthetic-data toggle. Keep off in production.              |
| `frameOrigin`    | `string`                     | ⛔       | `https://app.monad.com/embed` | Override only for non-prod testing.                                                  |
| `apiBase`        | `string`                     | ⛔       | `https://app.monad.com/api`   | Override only for non-prod testing.                                                  |
| `onSave`         | `(c: { id, name? }) => void` | ⛔       | —                             | Fired when the user saves successfully.                                              |
| `onCancel`       | `() => void`                 | ⛔       | —                             | Fired when the user cancels.                                                         |
| `onError`        | `(message: string) => void`  | ⛔       | —                             | Fired on a save / test / load failure.                                               |

Returns a handle:

```ts
const frame = createConnectorFrame({ ... });
frame.destroy();   // remove the iframe + listeners
```

---

## Theming with `appearance`

Six tokens, applied as CSS custom properties inside the iframe.

```ts
createConnectorFrame({
  ...,
  appearance: {
    colorPrimary:    '#10b981',   // primary buttons, focus rings
    colorText:       '#0d1b2a',   // body text + derived muted/faint shades
    colorBackground: '#ffffff',
    colorBorder:     '#d4d9e0',
    fontFamily:      "'Inter', system-ui, sans-serif",
    borderRadius:    '8px',
  },
});
```

These are the only theming knobs. The iframe runs cross-origin, so
your stylesheets cannot bleed in — by design. If you need more
control than these six tokens give, file an issue.

---

## Security model

- **Cross-origin iframe.** The form runs on `app.monad.com`, not
  on your domain. Browser same-origin policy means your JavaScript
  cannot read the iframe's DOM or any value the user types.
- **Session tokens are short-lived.** Default 30 min, scoped to a
  single team. Compromise of a session token is bounded; compromise
  of the long-lived API key is not — keep it on your backend.
- **postMessage with strict origin checks.** Every message between
  your page and the iframe is validated against the expected origin
  in both directions.
- **`SameSite=Lax` cookies.** Any cookies you set on your own domain
  do not travel into the Monad iframe regardless of origin sharing.
- **No host JavaScript in the iframe.** You cannot inject script or
  CSS; the only customization channel is the six `appearance`
  tokens.
