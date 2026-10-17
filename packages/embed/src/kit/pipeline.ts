/**
 * Pipeline bootstrap + management — what happens after a user configures a
 * connector in the iframe, and how you manage the integration afterward.
 *
 * The iframe hands your backend only an id: an INPUT id when the user
 * configured a source, an OUTPUT id when they configured a destination. A bare
 * connector moves no data — it needs a pipeline. These helpers stand that
 * pipeline up and manage it, so a customer never has to hand-assemble a
 * nodes/edges payload.
 *
 * Two directions, one primitive:
 *   • Ingress  — the user configured an INPUT; wire it → your store (or a
 *                throwaway dev/null sink).      → connectSource()
 *   • Egress   — the user configured an OUTPUT; wire your pre-provisioned
 *                source → it.                    → connectDestination()
 * Both are `wirePipeline` with the pre-provisioned side flipped.
 */
import {
	buildDevNullPipeline,
	findIntegrationPipeline,
	setIntegrationEnabled,
	deleteIntegration,
	CLEANUP_FULL,
	CLEANUP_KEEP_OUTPUT,
	type BuiltPipeline,
	type CleanupPolicy
} from '../connect';
import type { MonadConfig } from './client';
import { monadRequest } from './client';

/** How long `wirePipeline` waits for a new pipeline to report Running. */
const POLL_ATTEMPTS = 15;
const POLL_INTERVAL_MS = 2000;

/**
 * Wire one input → one output and poll until it reports Running. The shared
 * primitive behind both directions. The connect module's `buildDevNullPipeline`
 * is the special case that also creates a throwaway sink; this is the general
 * "wire two existing connectors" case the package otherwise lacks.
 */
export async function wirePipeline(
	cfg: MonadConfig,
	opts: { org: string; inputId: string; outputId: string; name: string }
): Promise<BuiltPipeline> {
	const { org, inputId, outputId, name } = opts;
	const req = monadRequest(cfg);
	const pipeline = (await req(`/v2/${org}/pipelines/`, {
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
		const s = (await req(`/v2/${org}/pipelines/${pipeline.id}/status`)) as { status?: string };
		status = s?.status ?? 'Unknown';
		if (status === 'Running' || status === 'Erroring') break;
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
	}
	return { pipelineId: pipeline.id, outputId, status, active: status === 'Running' };
}

/**
 * Ingress. After a user configures an INPUT, stand up a pipeline so data flows.
 * Pass `toOutputId` (a destination you pre-provisioned, one per tenant) to send
 * to your real store; omit it and a throwaway dev/null sink is created — the
 * zero-setup default that lets you demo end-to-end before you have a store.
 */
export function connectSource(
	cfg: MonadConfig,
	opts: { org: string; inputId: string; name: string; toOutputId?: string }
): Promise<BuiltPipeline> {
	const { org, inputId, name, toOutputId } = opts;
	if (toOutputId) return wirePipeline(cfg, { org, inputId, outputId: toOutputId, name });
	return buildDevNullPipeline({ request: monadRequest(cfg), org, inputId, inputName: name });
}

/**
 * Egress — the mirror of connectSource. After a user configures an OUTPUT, wire
 * your PRE-PROVISIONED source (your product, one per tenant team) → it. One
 * source fans out to many destinations. `fromInputId` is required: unlike
 * ingress there's no throwaway default, because egress by definition needs a
 * real source to read from.
 */
export function connectDestination(
	cfg: MonadConfig,
	opts: { org: string; outputId: string; name: string; fromInputId: string }
): Promise<BuiltPipeline> {
	const { org, outputId, name, fromInputId } = opts;
	return wirePipeline(cfg, { org, inputId: fromInputId, outputId, name });
}

/** Resolve an integration's pipeline + enabled state, knowing only the input id. */
export async function pipelineStatus(
	cfg: MonadConfig,
	opts: { org: string; inputId: string }
): Promise<{ hasPipeline: boolean; enabled: boolean; pipelineId?: string; outputId?: string }> {
	const resolved = await findIntegrationPipeline({
		request: monadRequest(cfg),
		org: opts.org,
		inputId: opts.inputId
	});
	return {
		hasPipeline: resolved !== null,
		enabled: resolved?.enabled ?? false,
		pipelineId: resolved?.pipelineId,
		outputId: resolved?.outputId
	};
}

interface PipelineNode {
	component_type: string;
	component_id: string;
}
interface PipelineSummary {
	id: string;
	enabled?: boolean;
}

/** Where an egress destination's pipeline lives and its current state. */
export interface ResolvedEgress {
	pipelineId: string;
	enabled: boolean;
	outputId: string;
	inputId?: string;
}

/**
 * Resolve the pipeline feeding a given OUTPUT — the egress counterpart to the
 * connect module's `findIntegrationPipeline` (which keys on input id). Walks
 * the org's pipelines and matches the output node, so you can manage a
 * destination knowing only its output id. Returns null when nothing feeds it.
 */
export async function findPipelineByOutput(
	cfg: MonadConfig,
	opts: { org: string; outputId: string }
): Promise<ResolvedEgress | null> {
	const { org, outputId } = opts;
	const req = monadRequest(cfg);
	const listed = await req(`/v2/${org}/pipelines/`);
	const pipelines: PipelineSummary[] = Array.isArray(listed)
		? listed
		: (listed?.pipelines ?? listed?.data ?? []);
	for (const summary of pipelines) {
		if (!summary?.id) continue;
		let detail;
		try {
			detail = await req(`/v2/${org}/pipelines/${summary.id}`);
		} catch {
			continue; // skip a pipeline we can't read rather than failing the whole scan
		}
		const p = detail?.config ?? detail?.pipeline ?? detail ?? {};
		const nodes: PipelineNode[] = p.nodes ?? [];
		const out = nodes.find((n) => n.component_type === 'output' && n.component_id === outputId);
		if (!out) continue;
		const input = nodes.find((n) => n.component_type === 'input');
		return {
			pipelineId: summary.id,
			enabled: Boolean(p.enabled ?? summary.enabled),
			outputId,
			inputId: input?.component_id
		};
	}
	return null;
}

/** Stop / resume data flow without deleting any config. */
export function setEnabled(
	cfg: MonadConfig,
	opts: { org: string; pipelineId: string; enabled: boolean }
): Promise<void> {
	return setIntegrationEnabled({ request: monadRequest(cfg), ...opts });
}

/**
 * Remove an integration. `cleanup` decides what's torn down vs kept — pass a
 * connect-module preset (CLEANUP_FULL, CLEANUP_KEEP_OUTPUT, …) or your own
 * `{ pipeline?, input?, output? }`. Only ids you supply are ever touched.
 */
export function remove(
	cfg: MonadConfig,
	opts: {
		org: string;
		pipelineId?: string;
		inputId?: string;
		outputId?: string;
		cleanup?: CleanupPolicy;
	}
): Promise<void> {
	const { org, pipelineId, inputId, outputId, cleanup = CLEANUP_FULL } = opts;
	return deleteIntegration({
		request: monadRequest(cfg),
		org,
		pipelineId,
		inputId,
		outputId,
		cleanup
	});
}

/**
 * Remove an INGRESS integration with the right cleanup baked in. If the output
 * is your pre-provisioned shared store, keep it (other inputs still feed it);
 * if it's the auto-created dev/null sink, tear it down too.
 */
export function removeIngress(
	cfg: MonadConfig,
	opts: {
		org: string;
		pipelineId?: string;
		inputId?: string;
		outputId?: string;
		/** True when the pipeline's output is your shared store (keep it). */
		keepStore: boolean;
	}
): Promise<void> {
	const { keepStore, ...ids } = opts;
	return remove(cfg, { ...ids, cleanup: keepStore ? CLEANUP_KEEP_OUTPUT : CLEANUP_FULL });
}

/**
 * Remove an EGRESS destination: delete its pipeline + the output, but keep the
 * shared source — other destinations still feed from it.
 */
export function removeEgress(
	cfg: MonadConfig,
	opts: { org: string; pipelineId?: string; outputId?: string }
): Promise<void> {
	return remove(cfg, { ...opts, cleanup: { pipeline: true, input: false, output: true } });
}
