# Monad Embed — TypeScript router

A standalone, mountable `/embed` backend router for a Monad embed integration.
Implements the [`/embed` route contract](../../packages/embed/openapi/embed.openapi.yaml).
**Zero runtime dependencies** and no dependency on any other Monad package —
lift it and go. Mounts into **Express, Fastify, Koa, and bare Node `http`** via a
Node adapter, and into **Next.js, SvelteKit, and edge runtimes** via a
framework-agnostic core.

```ts
import express from 'express';
import { createEmbedRouter } from '@monad-inc/embed-server';

const app = express();
app.use(
	'/embed',
	createEmbedRouter({
		apiKey: process.env.MONAD_API_KEY!,
		// your auth → the tenant's Monad team id (sync or async)
		getCustomerOrgID: (req) => sessionOrg(req.raw),
		// server-side lookup of a tenant's pre-provisioned components
		getProvisionedComponents: (org) => ({ destinationOutputId: stores[org] })
	})
);
```

Mounted with `app.use('/embed', …)`, the router serves `/embed/session`,
`/embed/pipelines/ingress`, etc. The browser holds only a session token; this
router holds the API key and is the seam to the Monad API.

The router has two entry points, and which you use depends on your server —
**not** your frontend framework (React/Svelte are frontend; this is backend):

- **`createEmbedRouter(cfg)`** — a Node `(req, res)` handler (it strips the
  `/embed` prefix itself). Use it with **Express, Fastify, Koa, bare Node
  `http`, Vite** — anything that speaks Node's req/res.
- **`createEmbedHandler(cfg)`** — the framework-agnostic core, a plain
  `(EmbedRequest) => EmbedResponse` with no framework and no deps. Use it with
  **Web-standard** servers — **Next.js, SvelteKit**, Hono, Bun, Deno, Cloudflare
  Workers — which hand you a Fetch `Request` and take a `Response`.

Most full-stack apps mount this in their meta-framework's own server layer
(Next.js route handlers, SvelteKit `+server.ts`), not a separate Express server.

## Node frameworks — `createEmbedRouter`

**Express** — [expressjs](https://expressjs.com)

```ts
app.use('/embed', createEmbedRouter(cfg));
```

**Fastify** — [fastify](https://fastify.dev) via [`@fastify/middie`](https://github.com/fastify/middie)

```ts
import middie from '@fastify/middie';

await fastify.register(middie);
fastify.use('/embed', createEmbedRouter(cfg));
```

**Koa** — [koajs](https://koajs.com)

```ts
const embed = createEmbedRouter(cfg);

app.use((ctx, next) => {
	if (!ctx.path.startsWith('/embed')) return next();
	ctx.respond = false; // hand the raw res to the embed router
	embed(ctx.req, ctx.res);
});
```

**Bare Node `http`** — a dedicated server (routes served under `/embed`)

```ts
import http from 'node:http';

http.createServer(createEmbedRouter(cfg)).listen(8080);
```

## Web-standard frameworks — `createEmbedHandler`

Next.js, SvelteKit, and edge runtimes call handlers with a Fetch `Request` and
expect a `Response`. One small adapter bridges that to the core — write it once:

```ts
import { createEmbedHandler, type EmbedRequest } from '@monad-inc/embed-server';

const handle = createEmbedHandler(cfg);

// Web `Request` → `EmbedRequest` → `Response`. `subpath` is the part after
// /embed (e.g. "session", "pipelines/ingress"); `raw` is whatever your
// getCustomerOrgID reads auth from (the Request, or a framework event).
async function serve(request: Request, subpath: string, raw: unknown = request) {
	const query: Record<string, string> = {};
	new URL(request.url).searchParams.forEach((v, k) => (query[k] = v));

	const res = await handle({
		method: request.method,
		path: '/' + subpath,
		query,
		headers: Object.fromEntries(request.headers),
		body: request.body ? await request.json().catch(() => undefined) : undefined,
		raw
	} satisfies EmbedRequest);

	return res.body === undefined
		? new Response(null, { status: res.status })
		: Response.json(res.body, { status: res.status });
}
```

**Next.js** (App Router) — `app/embed/[...path]/route.ts`

```ts
// `params` is a Promise in Next 15+; awaiting it also works on older versions.
export async function GET(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
	return serve(request, (await ctx.params).path.join('/'));
}
export const POST = GET;
```

**SvelteKit** — `src/routes/embed/[...path]/+server.ts`

```ts
import type { RequestHandler } from './$types';

// Pass the whole `event` as `raw` so getCustomerOrgID can read event.locals / cookies.
const handler: RequestHandler = (event) => serve(event.request, event.params.path, event);

export const GET = handler;
export const POST = handler;
```

The same adapter works on Hono, `Bun.serve`, `Deno.serve`, and Cloudflare
Workers — they all hand you a `Request` and take a `Response`.

## Config

| Field                      | Purpose                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| `apiKey`                   | Long-lived Monad API key (server-side only).                                                        |
| `apiBase`                  | Monad API base. Optional — defaults to `https://app.monad.com/api` (production).                    |
| `frameOrigin`              | Iframe origin returned by `GET /embed/config`. Optional — defaults to production.                   |
| `getCustomerOrgID`         | `EmbedRequest → org id`, sync or async. Return `""` / throw to reject (→ 401).                      |
| `getProvisionedComponents` | `org → { destinationOutputId?, sourceInputId? }`. Omit → ingress uses dev/null, egress unavailable. |
| `catalogAllow`             | Restrict the catalog to these connector type ids. Omit → all.                                       |

## Relationship to `@monad-inc/embed`

This router is self-contained — it inlines its own Monad client. If instead you
are writing your _own_ backend routes (not mounting a prebuilt router), the
ergonomic Monad client lives in `@monad-inc/embed/kit`.

## Develop

```sh
pnpm install
pnpm build      # tsup → dist (ESM + CJS + d.ts)
pnpm typecheck
pnpm test       # vitest
```
