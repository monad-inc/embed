/**
 * A self-contained Monad API client — the TypeScript equivalent of the Go and
 * Python routers' inlined clients. This package stands on its own: it does NOT
 * depend on `@monad-inc/embed`. It sequences Monad's /v1 + /v2 + /v3 calls and
 * returns values already shaped to the `/embed` contract (camelCase).
 *
 * A failed Monad call throws; the router maps that to `502 upstream_error`.
 */

export type ComponentKind = 'input' | 'output';

export interface Session {
	sessionToken: string;
	organizationId: string;
	expiresAt: string;
}

export interface CatalogType {
	typeId: string;
	name: string;
}

export interface ConfiguredConnector {
	id: string;
	typeId: string;
	name: string;
}

export interface BuiltPipeline {
	pipelineId: string;
	outputId: string;
	status: string;
	active: boolean;
}

export interface PipelineStatus {
	hasPipeline: boolean;
	enabled: boolean;
	pipelineId?: string;
	inputId?: string;
	outputId?: string;
}

/** Which resources a delete removes. A flag left undefined defaults to true. */
export interface CleanupPolicy {
	pipeline?: boolean;
	input?: boolean;
	output?: boolean;
}

const POLL_ATTEMPTS = 15;
const POLL_INTERVAL_MS = 2000;

/** URL-encode a single path segment so browser-supplied ids can't inject query
 *  params or traverse the path (`/`, `?`, `#` are neutralised). */
const seg = (s: string): string => encodeURIComponent(s);

/**
 * Thrown when a Monad API call fails. Carries the status + internal detail for
 * server-side logging; the router surfaces only the generic super() message to
 * the browser, so upstream response bodies never cross the trust boundary.
 */
export class UpstreamError extends Error {
	constructor(
		readonly status: number,
		readonly detail: string
	) {
		super('The upstream Monad API request failed.');
		this.name = 'UpstreamError';
	}
}

/* eslint-disable @typescript-eslint/no-explicit-any -- Monad responses are untyped JSON */

/** The Monad API client. Bind your key + base once; call plain methods. */
export class MonadApi {
	private readonly apiBase: string;
	private readonly apiKey: string;

	constructor(apiKey: string, apiBase: string) {
		this.apiKey = apiKey;
		this.apiBase = apiBase;
	}

	private async req(path: string, init?: RequestInit): Promise<any> {
		const r = await fetch(`${this.apiBase}${path}`, {
			...init,
			headers: {
				'Content-Type': 'application/json',
				Authorization: `ApiKey ${this.apiKey}`,
				...(init?.headers ?? {})
			}
		});
		if (!r.ok) {
			// Keep the upstream body server-side only — never surface it to the browser.
			throw new UpstreamError(r.status, `${r.status} ${path}: ${(await r.text()).slice(0, 300)}`);
		}
		const text = await r.text();
		return text ? JSON.parse(text) : undefined;
	}

	async mintSession(org: string): Promise<Session> {
		const raw = await this.req('/v3/sessions', {
			method: 'POST',
			body: JSON.stringify({ ttl_seconds: 1800, organization_id: org })
		});
		return { sessionToken: raw.session_token, organizationId: org, expiresAt: raw.expires_at };
	}

	async listCatalog(kind: ComponentKind, allow?: string[]): Promise<CatalogType[]> {
		const types = (await this.req(`/v1/${kind}s`)) as { type_id: string; name: string }[];
		const list = types.map((t) => ({ typeId: t.type_id, name: t.name }));
		if (!allow || allow.length === 0) return list;
		const set = new Set(allow);
		return list.filter((t) => set.has(t.typeId));
	}

	async listConnectors(org: string, kind: ComponentKind): Promise<ConfiguredConnector[]> {
		const page = (await this.req(`/v1/${seg(org)}/${kind}s?limit=1000&offset=0`)) as Record<
			string,
			{ id: string; type: string; name: string }[]
		>;
		const rows = page?.[`${kind}s`] ?? [];
		return rows.map((r) => ({ id: r.id, typeId: r.type, name: r.name }));
	}

	private async wire(
		org: string,
		inputId: string,
		outputId: string,
		name: string
	): Promise<BuiltPipeline> {
		const pipeline = (await this.req(`/v2/${seg(org)}/pipelines/`, {
			method: 'POST',
			body: JSON.stringify({
				name,
				description: 'Created when the connector was configured via embed',
				enabled: true,
				nodes: [
					{ slug: 'in', component_id: inputId, component_type: 'input', enabled: true },
					{ slug: 'out', component_id: outputId, component_type: 'output', enabled: true }
				],
				edges: [
					{
						from_node_instance_id: 'in',
						to_node_instance_id: 'out',
						description: 'all records',
						conditions: { operator: 'always' }
					}
				]
			})
		})) as { id: string };

		let status = 'Pending';
		for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
			const s = (await this.req(`/v2/${seg(org)}/pipelines/${seg(pipeline.id)}/status`)) as {
				status?: string;
			};
			status = s?.status ?? status;
			if (status === 'Running' || status === 'Erroring') break;
			await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
		}
		return { pipelineId: pipeline.id, outputId, status, active: status === 'Running' };
	}

	private async buildDevNull(org: string, inputId: string, name: string): Promise<BuiltPipeline> {
		const output = (await this.req(`/v2/${seg(org)}/outputs`, {
			method: 'POST',
			body: JSON.stringify({
				output_type: 'dev-null',
				name: `${name} → /dev/null`,
				description: 'Auto-created sink for embed pipeline',
				promise_id: '',
				config: { settings: {}, secrets: {} }
			})
		})) as { id: string };
		return this.wire(org, inputId, output.id, name);
	}

	/** Ingress: wire a configured input → the store, or a dev/null sink if none. */
	connectSource(
		org: string,
		opts: { inputId: string; name: string; toOutputId?: string }
	): Promise<BuiltPipeline> {
		if (opts.toOutputId) return this.wire(org, opts.inputId, opts.toOutputId, opts.name);
		return this.buildDevNull(org, opts.inputId, opts.name);
	}

	/** Egress: wire the pre-provisioned source → a configured output. */
	connectDestination(
		org: string,
		opts: { outputId: string; name: string; fromInputId: string }
	): Promise<BuiltPipeline> {
		return this.wire(org, opts.fromInputId, opts.outputId, opts.name);
	}

	private async pipelines(org: string): Promise<any[]> {
		const listed = await this.req(`/v2/${seg(org)}/pipelines/`);
		return Array.isArray(listed) ? listed : (listed?.pipelines ?? listed?.data ?? []);
	}

	private async detail(org: string, id: string): Promise<any> {
		const d = await this.req(`/v2/${seg(org)}/pipelines/${seg(id)}`);
		return d?.config ?? d ?? {};
	}

	async pipelineStatus(org: string, inputId: string): Promise<PipelineStatus> {
		for (const summary of await this.pipelines(org)) {
			if (!summary?.id) continue;
			let p: any;
			try {
				p = await this.detail(org, summary.id);
			} catch {
				continue;
			}
			const nodes: any[] = p.nodes ?? [];
			const inNode = nodes.find((n) => n.component_type === 'input' && n.component_id === inputId);
			if (!inNode) continue;
			const outNode = nodes.find((n) => n.component_type === 'output');
			return {
				hasPipeline: true,
				enabled: Boolean(p.enabled),
				pipelineId: summary.id,
				outputId: outNode?.component_id
			};
		}
		return { hasPipeline: false, enabled: false };
	}

	async findPipelineByOutput(org: string, outputId: string): Promise<PipelineStatus | null> {
		for (const summary of await this.pipelines(org)) {
			if (!summary?.id) continue;
			let p: any;
			try {
				p = await this.detail(org, summary.id);
			} catch {
				continue;
			}
			const nodes: any[] = p.nodes ?? [];
			const outNode = nodes.find(
				(n) => n.component_type === 'output' && n.component_id === outputId
			);
			if (!outNode) continue;
			const inNode = nodes.find((n) => n.component_type === 'input');
			return {
				hasPipeline: true,
				enabled: Boolean(p.enabled),
				pipelineId: summary.id,
				inputId: inNode?.component_id
			};
		}
		return null;
	}

	async setEnabled(org: string, pipelineId: string, enabled: boolean): Promise<void> {
		const p = await this.detail(org, pipelineId);
		await this.req(`/v2/${seg(org)}/pipelines/${seg(pipelineId)}`, {
			method: 'PATCH',
			body: JSON.stringify({
				name: p.name,
				description: p.description ?? '',
				enabled,
				nodes: (p.nodes ?? []).map((n: any) => ({
					id: n.id,
					slug: n.slug,
					component_id: n.component_id,
					component_type: n.component_type,
					enabled: n.enabled ?? true
				})),
				edges: (p.edges ?? []).map((e: any) => ({
					name: e.name,
					description: e.description ?? '',
					from_node_instance_id: e.from_node_instance_id,
					to_node_instance_id: e.to_node_instance_id,
					disabled: e.disabled ?? false,
					conditions: e.conditions
				}))
			})
		});
	}

	/** Delete resources per a cleanup policy. Order: pipeline (references the rest) first. */
	async remove(
		org: string,
		ids: { pipelineId?: string; inputId?: string; outputId?: string },
		cleanup: CleanupPolicy = {}
	): Promise<void> {
		const policy = { pipeline: true, input: true, output: true, ...cleanup };
		if (ids.pipelineId && policy.pipeline) {
			await this.req(`/v2/${seg(org)}/pipelines/${seg(ids.pipelineId)}`, { method: 'DELETE' });
		}
		if (ids.inputId && policy.input) {
			await this.req(`/v1/${seg(org)}/inputs/${seg(ids.inputId)}`, { method: 'DELETE' });
		}
		if (ids.outputId && policy.output) {
			await this.req(`/v1/${seg(org)}/outputs/${seg(ids.outputId)}`, { method: 'DELETE' });
		}
	}
}
/* eslint-enable @typescript-eslint/no-explicit-any */
