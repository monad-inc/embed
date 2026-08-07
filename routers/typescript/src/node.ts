/**
 * Node adapter — turns the framework-agnostic core into a mountable router.
 *
 * `import type` from `node:http` is erased at build time, so this keeps the
 * package's zero-runtime-dependency guarantee. The returned `(req, res)`
 * function works with bare Node `http` and with Express (Express's req/res
 * extend Node's):
 *
 *   app.use('/embed', createEmbedRouter(config));        // Express
 *   http.createServer(createEmbedRouter(config));        // bare Node (routes under /embed)
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createEmbedHandler, type EmbedRequest, type EmbedServerConfig } from './core';

export interface EmbedRouterOptions {
	/**
	 * Path prefix to strip from the incoming URL before matching. Defaults to
	 * `/embed`. When mounted with `app.use('/embed', …)` Express has already
	 * stripped it; when used as a raw Node handler the full `/embed/...` path
	 * arrives and this removes the prefix.
	 */
	mountPath?: string;
}

function headerRecord(headers: IncomingMessage['headers']): Record<string, string | undefined> {
	const out: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(headers)) {
		out[k] = Array.isArray(v) ? v[0] : v;
	}
	return out;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	const parsed = (req as { body?: unknown }).body;
	if (parsed !== undefined) return parsed;

	const method = (req.method ?? 'GET').toUpperCase();
	if (method === 'GET' || method === 'HEAD') return undefined;

	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
	}
	if (chunks.length === 0) return undefined;
	const text = Buffer.concat(chunks).toString('utf8').trim();
	if (!text) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** Build a `(req, res)` router that serves the `/embed` routes. */
export function createEmbedRouter(config: EmbedServerConfig, options: EmbedRouterOptions = {}) {
	const handle = createEmbedHandler(config);
	const mountPath = options.mountPath ?? '/embed';

	return function embedRouter(req: IncomingMessage, res: ServerResponse): void {
		void (async () => {
			const url = new URL(req.url ?? '/', 'http://embed.local');
			let path = url.pathname;
			if (path === mountPath) path = '/';
			else if (path.startsWith(mountPath + '/')) path = path.slice(mountPath.length);

			const query: Record<string, string | undefined> = {};
			for (const [k, v] of url.searchParams) query[k] = v;

			const embedReq: EmbedRequest = {
				method: req.method ?? 'GET',
				path,
				query,
				headers: headerRecord(req.headers),
				body: await readJsonBody(req),
				raw: req
			};

			const result = await handle(embedReq);
			res.statusCode = result.status;
			if (result.body === undefined) {
				res.end();
				return;
			}
			res.setHeader('content-type', 'application/json; charset=utf-8');
			res.end(JSON.stringify(result.body));
		})().catch(() => {
			if (!res.headersSent) {
				res.statusCode = 500;
				res.setHeader('content-type', 'application/json; charset=utf-8');
				res.end(JSON.stringify({ code: 'internal_error', message: 'Request handling failed.' }));
			} else {
				res.end();
			}
		});
	};
}
