/**
 * @monad-inc/embed-server — a standalone, mountable `/embed` backend router.
 *
 * Implements the `/embed` route contract for a Monad embed integration. The
 * host mounts this behind its own auth; the browser holds only a session token,
 * this router holds the API key and is the seam to the Monad API. Depends on
 * nothing but Node — lift it and go.
 *
 *   import { createEmbedRouter } from '@monad-inc/embed-server';
 *
 *   app.use('/embed', createEmbedRouter({
 *     apiKey: process.env.MONAD_API_KEY!,
 *     apiBase: 'https://app.monad.com/api',
 *     frameOrigin: 'https://app.monad.com/embed',
 *     getCustomerOrgID: (req) => sessionOrg(req.raw),      // your auth → Monad team
 *     getProvisionedComponents: (org) => ({ destinationOutputId: stores[org] }),
 *   }));
 */
export {
	createEmbedHandler,
	EmbedError,
	type EmbedServerConfig,
	type EmbedRequest,
	type EmbedResponse,
	type Provision
} from './core';

export { createEmbedRouter, type EmbedRouterOptions } from './node';

export {
	MonadApi,
	type ComponentKind,
	type Session,
	type CatalogType,
	type ConfiguredConnector,
	type BuiltPipeline,
	type PipelineStatus,
	type CleanupPolicy
} from './monad';
