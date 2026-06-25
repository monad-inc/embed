# Connector icons

When you embed Monad's connector UI, you often want to render the matching
**vendor logo** in your own surrounding chrome — a connector picker, a list of
already-connected integrations, a header above the iframe, etc. The connector
form itself lives inside the Monad-hosted iframe, but the chrome _around_ it is
yours, so you need a way to fetch the right logo.

Monad serves each vendor icon as a static SVG from a public, cache-friendly
endpoint:

```
GET https://app.monad.com/external/icons/raw/{typeId}.svg
```

> **Why this endpoint exists.** Vendor icons used to be bundled in the
> `@monad-inc/form-core` package. That package is internal and is **no longer
> available to external integrators**. The raw SVG endpoint is the supported,
> public way to get connector logos.

---

## The endpoint

|                  |                                                                                |
| ---------------- | ------------------------------------------------------------------------------ |
| **Method**       | `GET`                                                                          |
| **Path**         | `/external/icons/raw/{typeId}.svg`                                             |
| **Auth**         | None — public, no session token or API key required                            |
| **Content-Type** | `image/svg+xml`                                                                |
| **CORS**         | `Access-Control-Allow-Origin: *` (safe to fetch from any origin)               |
| **Caching**      | `Cache-Control: max-age=604800` (7 days); responses are immutable per `typeId` |
| **Compression**  | gzip when the client sends `Accept-Encoding: gzip`                             |
| **Not found**    | `404` with body `not found` when the `typeId` maps to no known icon            |

The trailing `.svg` is optional — `/external/icons/raw/aws-cloudtrail` and
`/external/icons/raw/aws-cloudtrail.svg` return the same asset. Using the `.svg`
suffix is recommended so the URL reads as an image to browsers, CDNs, and
crawlers.

### Base URL per environment

The icon endpoint is served from the same host as the embed iframe:

| Environment | Base URL                     |
| ----------- | ---------------------------- |
| Production  | `https://app.monad.com`      |
| Staging     | `https://app.monad.security` |
| Local dev   | `http://localhost:5173`      |

In production you almost always want `https://app.monad.com`. The non-prod
hosts mirror the `frameOrigin` / `apiBase` overrides documented in
[`packages/embed/USAGE.md`](../packages/embed/USAGE.md).

---

## What is a `typeId`?

A `typeId` is the **connector type slug** — the stable identifier for a kind of
connector (e.g. `aws-cloudtrail`, `okta-systemlog`, `github`). Every connector
available in the embedded UI has a unique `typeId`, and it is the _same value_
you already pass to `createConnectorFrame`:

```ts
import { createConnectorFrame } from '@monad-inc/embed/connect';

createConnectorFrame({
	container: '#monad-connector-mount',
	sessionToken,
	organizationId,
	kind: 'input',
	typeId: 'aws-cloudtrail', // ← same slug used for the icon URL
	onSave: ({ id }) => {
		/* ... */
	}
});
```

So if you already know which connector you're mounting, you already have the
`typeId` needed to fetch its icon — no extra lookup required:

```
https://app.monad.com/external/icons/raw/aws-cloudtrail.svg
```

---

## How `typeId`s map to icons

Many connector `typeId`s share a single vendor logo. For example, every AWS
service connector — `aws-cloudtrail`, `aws-security-lake`, `s3`, and so on —
resolves to the **same** AWS icon. The mapping is resolved server-side by
**case-insensitive substring match** against the vendor name. A few
representative examples:

| `typeId` (examples)                                       | Resolved icon            |
| --------------------------------------------------------- | ------------------------ |
| `aws-cloudtrail`, `aws-security-lake`, `amazon-*`, `s3-*` | `aws`                    |
| `okta-systemlog`, `okta`                                  | `okta`                   |
| `github`, `gadb`                                          | `github`                 |
| `gitlab`                                                  | `gitlab`                 |
| `microsoft-*`, `endpoint-alerts`                          | `microsoft`              |
| `azure-*`                                                 | `azure`                  |
| `google-*`                                                | `google`                 |
| `crowdstrike-*`                                           | `crowdstrike`            |
| `datadog-*`                                               | `datadog`                |
| `snowflake-*`                                             | `snowflake`              |
| `splunk-*`                                                | `splunk`                 |
| `okta`, `jira`, `slack`, `sentinel`, `wiz`, …             | the matching vendor icon |

Practical implications:

- **You don't need to normalize the `typeId` yourself.** Pass the connector's
  full `typeId` and the endpoint resolves the right logo.
- **Two different connectors can return the same logo** (e.g. all AWS services).
  That's expected — the icon represents the _vendor_, not the specific service.
- **An unknown or unmapped `typeId` returns `404`.** Render a fallback icon when
  you get a non-200 response (see below).

> **Tip — check a mapping without downloading the SVG.** The companion endpoint
> `GET /external/icons/{typeId}` returns JSON describing how a `typeId` resolves:
>
> ```json
> {
> 	"typeId": "aws-cloudtrail",
> 	"iconName": "aws",
> 	"fileName": "https://app.monad.com/logos/vendor/aws.svg"
> }
> ```
>
> This is handy for debugging which logo a given connector will show.

---

## Using the icon

### As an `<img>` (simplest)

```html
<img
	src="https://app.monad.com/external/icons/raw/aws-cloudtrail.svg"
	alt="AWS CloudTrail"
	width="32"
	height="32"
/>
```

### In React, with a fallback for unmapped connectors

```tsx
function ConnectorIcon({ typeId, label }: { typeId: string; label: string }) {
	const [failed, setFailed] = useState(false);
	if (failed) return <DefaultConnectorIcon aria-label={label} />;

	return (
		<img
			src={`https://app.monad.com/external/icons/raw/${encodeURIComponent(typeId)}.svg`}
			alt={label}
			width={32}
			height={32}
			onError={() => setFailed(true)} // fires on 404 / unmapped typeId
		/>
	);
}
```

### As a CSS background

```css
.connector-aws {
	background-image: url('https://app.monad.com/external/icons/raw/aws-cloudtrail.svg');
	background-size: contain;
	background-repeat: no-repeat;
}
```

### Fetched and inlined (for recoloring / styling the SVG)

```ts
const res = await fetch('https://app.monad.com/external/icons/raw/okta-systemlog.svg');
if (res.ok) {
	el.innerHTML = await res.text(); // now you can style the inline <svg>
}
```

---

## Notes & best practices

- **Cache it.** Responses are immutable per `typeId` and carry a 7-day
  `Cache-Control`. The browser and any CDN in front of your app will cache them
  automatically — no need to bust the URL.
- **Always handle 404.** New or custom connectors may not have a dedicated logo
  yet. Treat a non-200 as "use my fallback icon."
- **No auth, but no PII either.** The endpoint is public and returns only static
  vendor artwork — it's safe to reference directly from browser code.
- **The icon is the vendor's, not the connector's.** If you need to distinguish
  two connectors that share a vendor (e.g. two AWS services), use the
  connector's display name alongside the logo.
