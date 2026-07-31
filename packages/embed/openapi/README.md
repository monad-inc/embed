# The `/embed` route contract

`embed.openapi.yaml` is the **contract** between a host application's browser
code and its own backend for a Monad embed integration. It is the single shared
artifact every implementation conforms to.

The host mounts these nine routes under `/embed` in whatever framework and
language it already uses. The Monad-provided **frontend client** calls them; each
**backend** implements them. Because the browser only ever holds a short-lived
session token and the backend holds the long-lived Monad API key, this contract
is the seam between the two trust zones.

## This spec is a contract, not a server generator

Backends are written by hand to be idiomatic in their language (Go/chi, TS,
FastAPI, axum, Spring — they each mount differently). This spec is **not** used
to scaffold servers. It is used to:

- **generate the frontend client** (client generation is mature and low-risk), and
- **drive a conformance suite** (property-based, e.g. Schemathesis) that proves
  every hand-written backend agrees with the contract — including status codes
  and the error model.

## Conventions baked in

- **camelCase everywhere.** Backends normalize the Monad API's mixed casing at
  their boundary so this host-facing contract stays uniform.
- **Auth is the host's.** Routes run inside the host app behind its existing
  auth. The backend derives the Monad team (`organizationId`) from the request
  via its own `getCustomerOrgID` hook; the browser never sends a tenant id.
- **The pre-provisioned side is server-resolved.** Ingress's store output,
  egress's source input, and the delete cleanup policy are decided server-side,
  never sent by the browser.
- **One error model.** Every non-2xx returns `{ code, message, details? }` with a
  stable `code` (`invalid_request`, `unauthenticated`, `forbidden`, `not_found`,
  `conflict`, `upstream_error`, `internal_error`).

## The routes

| Method · path                   | operationId            | Purpose                                         |
| ------------------------------- | ---------------------- | ----------------------------------------------- |
| `GET /embed/config`             | `getConfig`            | Non-secret iframe config (public).              |
| `POST /embed/session`           | `createSession`        | Mint a short-lived, team-scoped token.          |
| `GET /embed/catalog`            | `listCatalog`          | Offered connector types for a kind.             |
| `GET /embed/connectors`         | `listConnectors`       | A tenant's configured connectors.               |
| `POST /embed/pipelines/ingress` | `buildIngressPipeline` | Wire a configured input → the tenant's store.   |
| `POST /embed/pipelines/egress`  | `buildEgressPipeline`  | Wire the tenant's source → a configured output. |
| `GET /embed/pipelines`          | `getPipelineStatus`    | Resolve a connector's pipeline + enabled state. |
| `POST /embed/pipelines/state`   | `setPipelineState`     | Enable / disable without deleting config.       |
| `POST /embed/pipelines/remove`  | `removeIntegration`    | Tear down per the host's cleanup policy.        |

## Lint

`.spectral.yaml` extends Spectral's OpenAPI ruleset. CI runs:

```sh
npx @stoplight/spectral-cli lint embed.openapi.yaml --fail-severity=warn
```

Add [oasdiff](https://github.com/oasdiff/oasdiff) as a breaking-change gate
against the previous version before publishing.
