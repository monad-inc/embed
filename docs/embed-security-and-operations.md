# Embed: security & operational model

This applies to every backend router (`@monad-inc/embed-server`, and the Go and
Python routers) — they share one contract and one trust model.

## Tenant isolation: one dedicated Monad org per tenant

The host maps each incoming request to a Monad organization through the
`getCustomerOrgID` callback, and every Monad call the router makes is scoped to
that org. **Each embed tenant must get its own dedicated Monad org.**

The router mounts _behind_ the host's authentication and treats the resolved org
as the whole authorization boundary: within that org, an embed user can list,
build, pause, and **remove** connectors and pipelines by id. There is no
per-object "was this created by embed?" check — that is deliberate, and it is
safe **only** because the org is dedicated to the tenant.

> **Do not share an embed tenant's org with non-embed resources.** If a tenant's
> org also holds production inputs/outputs/pipelines created outside embed, an
> embed user could enumerate (`GET /embed/connectors`) and delete
> (`POST /embed/pipelines/remove`) them. Provision a separate org per embed
> tenant and keep host-managed infrastructure in a different org.

Tenant-to-tenant isolation is never at risk: the org is resolved server-side, so
a browser cannot address another tenant's org.

## Resource lifecycle is non-atomic — monitor for orphans

Building or removing a connector is several Monad API calls in sequence
(create output → create pipeline → poll status; or delete pipeline → delete
connector → delete output). Monad exposes **no transaction and no idempotency
key**, so a failure part-way through can leave a resource behind:

- **Create path** — if wiring the pipeline fails after a dev/null sink was
  created, the router makes a **best-effort delete** of that sink. If the
  compensating delete also fails, the sink is orphaned.
- **Delete path** — `remove` deletes in dependency order: **pipeline first**
  (it references the others), then the connector, then the peer output. A
  failure after the first delete leaves the remaining resources orphaned, and
  because the pipeline that linked them is already gone, a retry cannot rediscover
  them through the embed API.

A transient failure while polling a freshly-created pipeline's status does **not**
orphan it: the pipeline already exists, so the router returns it as built (with
its last-known status) rather than failing and inviting a duplicate on retry.

**Recommendation:** set up alerting/monitoring in each embed tenant's org for
orphaned resources — pipelines stuck non-running, and inputs/outputs that belong
to no pipeline — and reconcile them (delete or re-wire) out of band. This is the
backstop for the non-atomic delete path above.
