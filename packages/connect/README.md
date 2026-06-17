# @monad-inc/connect

Host-side SDK for embedding Monad's connector-config UI as a secure
cross-origin iframe. The customer's page calls `createConnectorFrame()`;
the form and every secret typed into it run inside a Monad-hosted
iframe, so the host's JavaScript never sees credential material — only
a connector id reference comes back. The isolation model is analogous
to Stripe Elements and Plaid Link.

The package also ships a small lifecycle harness — isomorphic helpers
for the host's backend to build, enable, disable, and delete a
connector's pipeline against Monad's REST API.

Zero runtime dependencies.

## Installation

```sh
npm install @monad-inc/connect
```

## Quick start

The session token travels in a `postMessage` after a `ready` handshake,
never in the iframe URL, so it stays out of browser history and the
`Referer` header. Mint it from the host's backend (`POST
/v1/embed/sessions` with the long-lived API key) and hand it to the
browser as `sessionToken`:

```ts
import { createConnectorFrame } from '@monad-inc/connect';

const frame = createConnectorFrame({
	container: '#connector-modal-body',
	frameOrigin: 'https://embed.monad.com', // a Monad-controlled origin
	apiBase: 'https://api.monad.com',
	organizationId: 'org_abc123',
	typeId: 'aws-cloudtrail',
	kind: 'input',
	sessionToken,
	appearance: { colorPrimary: '#007dc1' },
	onSave: ({ id }) => {
		/* connector created — id is safe to keep */
	},
	onCancel: () => frame.destroy(),
	onError: (msg) => showError(msg)
});
```

## API reference

### Iframe embedder

- `createConnectorFrame(options: ConnectorFrameOptions): ConnectorFrame`
  — mounts the iframe inside `options.container` and returns a handle
  with `destroy()`.
- Types: `ConnectorFrameOptions`, `ConnectorFrame`, `Appearance`,
  `ComponentKind`.
- Protocol exports: `PROTOCOL_SOURCE`, `PROTOCOL_VERSION`,
  `FrameMessage`, `HostMessage`, `InitMessage`.

### Lifecycle harness

Each helper takes a `MonadRequest` thunk the host implements once,
wrapping its API key and base URL:

```ts
import {
	buildDevNullPipeline,
	findIntegrationPipeline,
	disableIntegration,
	enableIntegration,
	deleteIntegration,
	CLEANUP_FULL,
	type MonadRequest
} from '@monad-inc/connect';

const request: MonadRequest = (path, init) =>
	fetch(`${API_BASE}${path}`, {
		...init,
		headers: {
			Authorization: `ApiKey ${apiKey}`,
			'Content-Type': 'application/json',
			...init?.headers
		}
	}).then(async (r) => {
		if (!r.ok) throw new Error(await r.text());
		const text = await r.text();
		return text ? JSON.parse(text) : undefined;
	});

const built = await buildDevNullPipeline({ request, org, inputId, inputName });
const resolved = await findIntegrationPipeline({ request, org, inputId });

await disableIntegration({ request, org, pipelineId: resolved.pipelineId });
await enableIntegration({ request, org, pipelineId: resolved.pipelineId });
await deleteIntegration({
	request,
	org,
	pipelineId: resolved.pipelineId,
	inputId,
	outputId: resolved.outputId,
	cleanup: CLEANUP_FULL
});
```

Exports: `buildDevNullPipeline`, `findIntegrationPipeline`,
`setIntegrationEnabled`, `disableIntegration`, `enableIntegration`,
`deleteIntegration`. Cleanup presets: `CLEANUP_FULL`,
`CLEANUP_KEEP_OUTPUT`, `CLEANUP_PIPELINE_ONLY`. Types: `MonadRequest`,
`ResolvedIntegration`, `CleanupPolicy`, `BuiltPipeline`, and the
per-helper option types.

#### Cleanup policies

| Policy                  | Pipeline | Input  | Output |
| ----------------------- | -------- | ------ | ------ |
| `CLEANUP_FULL`          | delete   | delete | delete |
| `CLEANUP_KEEP_OUTPUT`   | delete   | delete | keep   |
| `CLEANUP_PIPELINE_ONLY` | delete   | keep   | keep   |

Or pass your own `{ pipeline?, input?, output? }`. A flag left
undefined defaults to delete.

## Theming

The iframe accepts an `appearance` object of design tokens (e.g.
`colorPrimary`, `colorBackground`, `borderRadius`) that the embedded
form applies to its own styles. For deeper customization, pass
`stylesheets: [url, …]`; the iframe loads them in order. The list is
all-or-nothing — providing any URL replaces Monad's default stylesheet
rather than layering on top of it, so include the full token set you
want.

## Browser support

Modern evergreen browsers (Chrome, Edge, Firefox, Safari). The package
ships both ESM and CJS builds plus `.d.ts` types. `createConnectorFrame`
is browser-only — it injects an `<iframe>` and uses `postMessage`.
The lifecycle helpers are isomorphic and run wherever the host holds
its API key (almost always its backend). Importing the package in
Node is safe; the browser code only touches `window`/`document` when
`createConnectorFrame` is called.

## Versioning

`0.x` is pre-stable. Minor releases may include breaking API changes.
The package will move to `1.0.0` once the API is committed to long-term
compatibility. See `CHANGELOG.md` for release notes.

## License

Proprietary. © Monad Inc. All rights reserved. See `LICENSE.md`.
