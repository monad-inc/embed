// @vitest-environment jsdom
//
// The package default is `environment: 'node'`; createConnectorFrame needs a
// DOM to append its iframe to and a window to listen for messages on.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createConnectorFrame,
	PROTOCOL_SOURCE,
	PROTOCOL_VERSION,
	type ConfigMetaOverrides,
	type ConnectorFrame,
	type InitMessage
} from '../src/connect';

const FRAME_ORIGIN = 'https://frame.example.com/embed';
const API_BASE = 'https://api.example.com';

let container: HTMLElement;
let frame: ConnectorFrame | undefined;

beforeEach(() => {
	container = document.createElement('div');
	document.body.appendChild(container);
});

afterEach(() => {
	frame?.destroy();
	frame = undefined;
	container.remove();
	vi.restoreAllMocks();
});

/**
 * Mount a frame, play the iframe's half of the handshake, and return the
 * `init` message the host sent back.
 *
 * The host only replies to a `ready` whose origin AND source both match the
 * iframe it created, so the synthetic event has to carry the real
 * contentWindow — a plain `window.postMessage` would be dropped.
 */
function captureInit(
	overrides?: ConfigMetaOverrides
): { init: InitMessage; postSpy: ReturnType<typeof vi.fn> } {
	frame = createConnectorFrame({
		container,
		frameOrigin: FRAME_ORIGIN,
		apiBase: API_BASE,
		typeId: 'datadog',
		kind: 'output',
		sessionToken: 'session-token',
		organizationId: 'org-1',
		configMetaOverrides: overrides
	});

	const iframe = container.querySelector('iframe');
	if (!iframe?.contentWindow) throw new Error('iframe has no contentWindow');

	const postSpy = vi.fn();
	// The host posts `init` through iframe.contentWindow.postMessage.
	vi.spyOn(iframe.contentWindow, 'postMessage').mockImplementation(
		postSpy as unknown as typeof iframe.contentWindow.postMessage
	);

	window.dispatchEvent(
		new MessageEvent('message', {
			origin: new URL(FRAME_ORIGIN).origin,
			source: iframe.contentWindow,
			data: { source: PROTOCOL_SOURCE, type: 'ready', version: PROTOCOL_VERSION }
		})
	);

	expect(postSpy).toHaveBeenCalledTimes(1);
	return { init: postSpy.mock.calls[0][0] as InitMessage, postSpy };
}

describe('createConnectorFrame init payload', () => {
	it('forwards configMetaOverrides verbatim', () => {
		const overrides: ConfigMetaOverrides = {
			settings: {
				ddsource: { placeholder: 'northstar' },
				service: { placeholder: 'northstar-web', name: 'Service name' }
			},
			secrets: {
				api_key: { children: { value: { placeholder: 'Datadog API key' } } }
			}
		};

		const { init } = captureInit(overrides);

		expect(init.configMetaOverrides).toEqual(overrides);
	});

	it('forwards nested discriminator overrides verbatim', () => {
		const overrides: ConfigMetaOverrides = {
			settings: {
				auth: {
					discriminator: {
						name: 'Auth method',
						one_of: { basic: { children: { username: { name: 'Login' } } } }
					}
				}
			}
		};

		const { init } = captureInit(overrides);

		expect(init.configMetaOverrides).toEqual(overrides);
	});

	it('leaves configMetaOverrides undefined when the option is omitted', () => {
		// Not `{}`: the iframe short-circuits on an absent override object, and
		// an empty-object default would defeat that.
		const { init } = captureInit();

		expect(init.configMetaOverrides).toBeUndefined();
	});

	it('still forwards the options it already supported', () => {
		const { init } = captureInit();

		expect(init).toMatchObject({
			source: PROTOCOL_SOURCE,
			type: 'init',
			version: PROTOCOL_VERSION,
			sessionToken: 'session-token',
			apiBase: API_BASE,
			organizationId: 'org-1',
			typeId: 'datadog',
			kind: 'output'
		});
	});

	it('ignores a ready message from a foreign origin', () => {
		frame = createConnectorFrame({
			container,
			frameOrigin: FRAME_ORIGIN,
			apiBase: API_BASE,
			typeId: 'datadog',
			kind: 'output',
			sessionToken: 'session-token',
			organizationId: 'org-1'
		});

		const iframe = container.querySelector('iframe');
		if (!iframe?.contentWindow) throw new Error('iframe has no contentWindow');
		const postSpy = vi.fn();
		vi.spyOn(iframe.contentWindow, 'postMessage').mockImplementation(
			postSpy as unknown as typeof iframe.contentWindow.postMessage
		);

		window.dispatchEvent(
			new MessageEvent('message', {
				origin: 'https://evil.example.com',
				source: iframe.contentWindow,
				data: { source: PROTOCOL_SOURCE, type: 'ready', version: PROTOCOL_VERSION }
			})
		);

		expect(postSpy).not.toHaveBeenCalled();
	});

	it('stops responding after destroy', () => {
		const { postSpy } = captureInit();
		const iframe = container.querySelector('iframe');

		frame?.destroy();
		frame = undefined;

		expect(iframe?.isConnected).toBe(false);
		expect(postSpy).toHaveBeenCalledTimes(1);
	});
});
