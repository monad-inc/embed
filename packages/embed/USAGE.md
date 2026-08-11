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

| Option                  | Type                         | Required | Default                          | Description                                                                                                                                 |
| ----------------------- | ---------------------------- | -------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `container`             | `HTMLElement \| string`      | ✅       | —                                | Element (or CSS selector) the iframe is appended to.                                                                                        |
| `sessionToken`          | `string`                     | ✅       | —                                | Short-lived token from `POST /v3/sessions` (your backend mints this).                                                                       |
| `organizationId`        | `string`                     | ✅       | —                                | Monad team org id the session is scoped to. Same value you passed to `/v3/sessions`.                                                        |
| `kind`                  | `'input' \| 'output'`        | ✅       | —                                | Which catalog the connector belongs to.                                                                                                     |
| `typeId`                | `string`                     | ✅       | —                                | Connector type slug, e.g. `'aws-cloudtrail'`, `'okta-systemlog'`.                                                                           |
| `existingId`            | `string`                     | ⛔       | —                                | Pass to edit an existing connector. Omit to create a new one.                                                                               |
| `displayName`           | `string`                     | ⛔       | the connector type's name        | Title shown in the iframe header.                                                                                                           |
| `name`                  | `string`                     | ⛔       | type name + unique suffix        | Name for the created connector. On edit, omit to keep the existing name.                                                                    |
| `description`           | `string`                     | ⛔       | the connector type's description | Description for the created connector. On edit, omit to keep the existing description.                                                      |
| `isNameEditable`        | `boolean`                    | ⛔       | `false`                          | Show an editable name input in the iframe (prefilled with `name` if provided, else the type name). A non-empty name is required when shown. |
| `isDescriptionEditable` | `boolean`                    | ⛔       | `false`                          | Show an editable description input in the iframe (prefilled with `description` if provided).                                                |
| `appearance`            | `Appearance`                 | ⛔       | Monad defaults                   | Theming tokens (see below).                                                                                                                 |
| `stylesheets`           | `string[]`                   | ⛔       | Monad's built-in stylesheet      | Your own stylesheet URLs. All-or-nothing: if set, Monad's defaults are not loaded (see below).                                              |
| `configMetaOverrides`   | `ConfigMetaOverrides`        | ⛔       | the connector's own copy         | Per-field label / description / placeholder overrides (see below).                                                                          |
| `synthetic`             | `boolean`                    | ⛔       | `false`                          | Exposes Monad's internal synthetic-data toggle. Keep off in production.                                                                     |
| `frameOrigin`           | `string`                     | ⛔       | `https://app.monad.com/embed`    | Override only for non-prod testing.                                                                                                         |
| `apiBase`               | `string`                     | ⛔       | `https://app.monad.com/api`      | Override only for non-prod testing.                                                                                                         |
| `onSave`                | `(c: { id, name? }) => void` | ⛔       | —                                | Fired when the user saves successfully.                                                                                                     |
| `onCancel`              | `() => void`                 | ⛔       | —                                | Fired when the user cancels.                                                                                                                |
| `onError`               | `(message: string) => void`  | ⛔       | —                                | Fired on a save / test / load failure.                                                                                                      |

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

## Customizing field copy with `configMetaOverrides`

Every connector ships its own field labels, descriptions, and
placeholders. `configMetaOverrides` lets you replace that copy with
wording that fits your product, without changing how the form behaves.

```ts
createConnectorFrame({
  ...,
  typeId: 'datadog',
  kind: 'output',
  configMetaOverrides: {
    settings: {
      ddsource: { placeholder: 'northstar' },
      service: { name: 'Service name', placeholder: 'northstar-web' },
    },
  },
});
```

**Keys are the connector's own field keys.** They come from the
connector-type response, not from the labels shown in the form, so check
that response rather than guessing — the Datadog output's source field is
`ddsource`, and its tags field is `ddtags`. A key that doesn't match the
connector is ignored, so a typo is silent: the form renders with Monad's
original copy.

**`placeholder` is a hint, not a default.** It shows as grey text and
disappears as soon as the user types. A field the user never touches
still submits an empty value. There is no option to pre-fill a real
value, because that would change the data your connector is configured
with.

### What you can override

Per field: `name`, `description`, `placeholder`.

Nested fields are reached with `children`, and the variants of a
multiple-choice field with `discriminator.one_of`:

```ts
configMetaOverrides: {
  secrets: {
    api_key: { children: { value: { placeholder: 'Datadog API key' } } },
  },
  settings: {
    auth: {
      discriminator: {
        name: 'Auth method',
        one_of: { basic: { children: { username: { name: 'Login' } } } },
      },
    },
  },
}
```

A field's type, whether it is required, its allowed values, and its
default are fixed by the connector and cannot be overridden. Some
controls have nowhere to show a placeholder — dropdowns, checkboxes, and
code editors ignore it. If you need a field to _behave_ differently,
that's a change to the connector itself; file an issue.

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
