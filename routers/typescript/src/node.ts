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

/** Cap on a buffered request body. Embed requests carry only ids + names, so
 *  1 MiB is generous; the cap stops a hostile/buggy client (behind host auth)
 *  from driving the bare-Node adapter to OOM. */
const MAX_BODY_BYTES = 1 << 20;

/** Thrown when a request body exceeds {@link MAX_BODY_BYTES}. */
class PayloadTooLargeError extends Error {}

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
	let size = 0;
	for await (const chunk of req) {
		const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
		size += buf.length;
		if (size > MAX_BODY_BYTES) {
			req.destroy();
			throw new PayloadTooLargeError();
		}
		chunks.push(buf);
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
		})().catch((err) => {
			if (res.headersSent) {
				res.end();
				return;
			}
			// A too-large body maps to the contract's 400 invalid_request (413 is
			// not a declared status); anything else is a generic 500.
			const tooLarge = err instanceof PayloadTooLargeError;
			res.statusCode = tooLarge ? 400 : 500;
			res.setHeader('content-type', 'application/json; charset=utf-8');
			res.end(
				JSON.stringify(
					tooLarge
						? { code: 'invalid_request', message: 'Request body exceeds the maximum size.' }
						: { code: 'internal_error', message: 'Request handling failed.' }
				)
			);
		});
	};
}
