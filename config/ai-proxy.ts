/**
 * URL of the AI assistant proxy Worker (see worker/). Set DIM_AI_PROXY_URL to
 * use a different deployment. This isn't a secret: the Worker only accepts
 * requests from the origins in its ALLOWED_ORIGINS.
 */
const DEFAULT_AI_PROXY_URL = 'https://dim-ai-proxy.rasputin-warmind-network.workers.dev';

export function aiProxyUrl() {
  return process.env.DIM_AI_PROXY_URL || DEFAULT_AI_PROXY_URL;
}
