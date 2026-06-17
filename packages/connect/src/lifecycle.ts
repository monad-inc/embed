/**
 * Connector-lifecycle helpers — the "wiring harness" a host (Okta, in
 * the demo's fiction) drops into its own backend to power Disable /
 * Enable / Delete buttons in its own UI.
 *
 * Unlike createConnectorFrame (browser-only), these are isomorphic:
 * they just sequence Monad's standard `/v2/{org}/*` + `/v1/{org}/*`
 * API calls. They run wherever the host holds its API key — almost
 * always its backend.
 *
 * The host supplies a `MonadRequest` thunk that performs an
 * authenticated request and returns parsed JSON. The harness owns the
 * non-obvious parts: which endpoint + verb each action maps to, the
 * delete ordering (pipeline before the input/output it references),
 * and resolving an input id to its pipeline without the host having to
 * store that mapping.
 */

/**
 * Authenticated request against the Monad API, returning parsed JSON
 * (or undefined for empty responses). The host implements this with
 * its long-lived API key and base URL. Path is the full API path,
 * e.g. `/v2/{org}/pipelines/{id}`.
 */
export type MonadRequest = (path: string, init?: RequestInit) => Promise<any>;

/* ===== resolve ===== */

/**
 * Where an integration's resources live and their current state.
 * Returned by findIntegrationPipeline so the host can act on an
 * integration knowing only the input id.
 */
export interface ResolvedIntegration {
	org: string;
	pipelineId: string;
	/** Whether the pipeline is currently enabled. */
	enabled: boolean;
	inputId: string;
	/** Output id of the pipeline's destination node, if it has one. */
	outputId?: string;
}

interface PipelineNode {
	component_id?: string;
	component_type?: string;
}

/**
 * Find the pipeline an input feeds. Lets the host act on an integration
 * (disable/enable/delete) knowing only the input id — no need to
 * persist an input→pipeline map of its own.
 *
 * The pipelines list is slim (no node wiring), so this fetches each
 * pipeline's detail and scans for the input node. Fine for the modest
 * pipeline counts a single tenant team has; a host managing many
 * pipelines per team should instead persist the `pipelineId`
 * buildDevNullPipeline returns and skip the lookup.
 *
 * Returns null when the input has no pipeline.
 */
export async function findIntegrationPipeline(opts: {
	request: MonadRequest;
	org: string;
	inputId: string;
}): Promise<ResolvedIntegration | null> {
	const { request, org, inputId } = opts;
	const listed = await request(`/v2/${org}/pipelines/`);
	const pipelines: any[] = Array.isArray(listed)
		? listed
		: (listed?.pipelines ?? listed?.data ?? []);

	for (const summary of pipelines) {
		if (!summary?.id) continue;
		let detail: any;
		try {
			detail = await request(`/v2/${org}/pipelines/${summary.id}`);
		} catch {
			continue; // skip a pipeline we can't read rather than failing
		}
		const pipeline = detail?.config ?? detail;
		const nodes: PipelineNode[] = pipeline?.nodes ?? [];
		const inputNode = nodes.find((n) => n.component_type === 'input' && n.component_id === inputId);
		if (!inputNode) continue;
		const outputNode = nodes.find((n) => n.component_type === 'output');
		return {
			org,
			pipelineId: summary.id,
			enabled: Boolean(pipeline.enabled),
			inputId,
			outputId: outputNode?.component_id
		};
	}
	return null;
}

/* ===== enable / disable ===== */

export interface SetEnabledOptions {
	request: MonadRequest;
	org: string;
	pipelineId: string;
	/** true → resume processing, false → stop (config is kept either way). */
	enabled: boolean;
}

/**
 * Enable or disable an integration's pipeline. Disabling stops data
 * flowing but destroys nothing — the input, output, and pipeline
 * config all survive, so a later enable resumes it as it was.
 *
 * The pipeline PATCH endpoint replaces the whole config rather than
 * accepting a partial, so this reads the current pipeline and sends it
 * back with only the `enabled` flag flipped.
 *
 * Race warning: this is GET-then-PATCH on the same resource, so a
 * concurrent edit between the two requests gets clobbered. Fine for
 * human-driven toggles. If you call this from automation, fan-out, or
 * a retry loop, ask the API team for a server-side `{ enabled }`
 * partial PATCH instead — the round-trip we do here is only a
 * workaround for the current full-config replace semantics.
 */
export async function setIntegrationEnabled(opts: SetEnabledOptions): Promise<void> {
	const { request, org, pipelineId, enabled } = opts;
	const detail = await request(`/v2/${org}/pipelines/${pipelineId}`);
	const pipeline = detail?.config ?? detail;
	await request(`/v2/${org}/pipelines/${pipelineId}`, {
		method: 'PATCH',
		body: JSON.stringify({
			name: pipeline.name,
			description: pipeline.description ?? '',
			enabled,
			nodes: (pipeline.nodes ?? []).map((n: any) => ({
				id: n.id,
				slug: n.slug,
				component_id: n.component_id,
				component_type: n.component_type,
				enabled: n.enabled ?? true
			})),
			edges: (pipeline.edges ?? []).map((e: any) => ({
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

/** Convenience: disable the pipeline (stop without deleting). */
export function disableIntegration(opts: Omit<SetEnabledOptions, 'enabled'>): Promise<void> {
	return setIntegrationEnabled({ ...opts, enabled: false });
}

/** Convenience: re-enable a disabled pipeline. */
export function enableIntegration(opts: Omit<SetEnabledOptions, 'enabled'>): Promise<void> {
	return setIntegrationEnabled({ ...opts, enabled: true });
}

/* ===== delete ===== */

/**
 * Which resources a delete removes. An embed integration is a pipeline
 * + an input + (in the dev/null flow) an output — but hosts provision
 * and own tenant resources differently. Some keep a shared output,
 * some keep the input so it can be re-wired later, some only ever tear
 * down the pipeline. Choose the policy that matches how you provision;
 * a flag left undefined defaults to `true` (delete it).
 *
 * Three ready-made policies are exported — CLEANUP_FULL,
 * CLEANUP_KEEP_OUTPUT, CLEANUP_PIPELINE_ONLY — or pass your own.
 */
export interface CleanupPolicy {
	/** Delete the pipeline. Default: true. */
	pipeline?: boolean;
	/** Delete the input connector. Default: true. */
	input?: boolean;
	/** Delete the output connector. Default: true. */
	output?: boolean;
}

/** Tear down everything — pipeline, input, and output. */
export const CLEANUP_FULL: CleanupPolicy = { pipeline: true, input: true, output: true };

/** Remove the pipeline and input but keep the output (e.g. a shared sink). */
export const CLEANUP_KEEP_OUTPUT: CleanupPolicy = {
	pipeline: true,
	input: true,
	output: false
};

/** Remove only the pipeline; keep the input so it can be re-wired. */
export const CLEANUP_PIPELINE_ONLY: CleanupPolicy = {
	pipeline: true,
	input: false,
	output: false
};

export interface DeleteIntegrationOptions {
	request: MonadRequest;
	org: string;
	/** Pipeline to remove. Omit when the input has no pipeline. */
	pipelineId?: string;
	/** Input to remove. Omit to leave it. */
	inputId?: string;
	/** Output to remove (the auto-created dev/null sink). Omit to leave it. */
	outputId?: string;
	/**
	 * What to actually delete. Defaults to everything supplied
	 * (CLEANUP_FULL). Set a flag false to keep that resource even when
	 * its id is provided.
	 */
	cleanup?: CleanupPolicy;
}

/**
 * Delete an integration per a cleanup policy. Order matters: the
 * pipeline references the input and output, so it goes first. Only
 * resources whose id is supplied AND whose policy flag is true are
 * removed — so nothing the host wants to keep is touched, and nothing
 * it wants gone is left orphaned.
 */
export async function deleteIntegration(opts: DeleteIntegrationOptions): Promise<void> {
	const { request, org, pipelineId, inputId, outputId } = opts;
	const policy: Required<CleanupPolicy> = {
		pipeline: true,
		input: true,
		output: true,
		...opts.cleanup
	};
	if (pipelineId && policy.pipeline) {
		await request(`/v2/${org}/pipelines/${pipelineId}`, { method: 'DELETE' });
	}
	if (inputId && policy.input) {
		await request(`/v1/${org}/inputs/${inputId}`, { method: 'DELETE' });
	}
	if (outputId && policy.output) {
		await request(`/v1/${org}/outputs/${outputId}`, { method: 'DELETE' });
	}
}

/* ===== build ===== */

export interface BuildDevNullPipelineOptions {
	request: MonadRequest;
	org: string;
	inputId: string;
	/** Used to name the auto-created output and pipeline. */
	inputName: string;
	/** Status polls before giving up (default 15, ~2s apart). */
	pollAttempts?: number;
}

export interface BuiltPipeline {
	pipelineId: string;
	outputId: string;
	status: string;
	/** True once the pipeline reports Running. */
	active: boolean;
}

/**
 * Stand up a dev/null pipeline for a freshly-configured input: create a
 * dev/null output, create an enabled pipeline wiring input → output,
 * then poll until it reports Running. The POC's "what happens after an
 * input is configured" path, packaged as a reusable harness call.
 */
export async function buildDevNullPipeline(
	opts: BuildDevNullPipelineOptions
): Promise<BuiltPipeline> {
	const { request, org, inputId, inputName, pollAttempts = 15 } = opts;
	const label = inputName || 'Input';

	const output = await request(`/v2/${org}/outputs`, {
		method: 'POST',
		body: JSON.stringify({
			output_type: 'dev-null',
			name: `${label} → /dev/null`,
			description: 'Auto-created sink for embed pipeline',
			promise_id: '',
			config: { settings: {}, secrets: {} }
		})
	});

	const pipeline = await request(`/v2/${org}/pipelines/`, {
		method: 'POST',
		body: JSON.stringify({
			name: `${label} pipeline`,
			description: 'Auto-created when the input was configured via embed',
			enabled: true,
			nodes: [
				{ slug: 'in', component_id: inputId, component_type: 'input', enabled: true },
				{ slug: 'out', component_id: output.id, component_type: 'output', enabled: true }
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
	});

	let status = 'Pending';
	for (let attempt = 0; attempt < pollAttempts; attempt++) {
		const s = await request(`/v2/${org}/pipelines/${pipeline.id}/status`);
		status = s?.status ?? 'Unknown';
		if (status === 'Running' || status === 'Erroring') break;
		await new Promise((r) => setTimeout(r, 2000));
	}

	return {
		pipelineId: pipeline.id,
		outputId: output.id,
		status,
		active: status === 'Running'
	};
}
