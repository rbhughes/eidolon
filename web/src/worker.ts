// Custom Worker entrypoint (wrangler.jsonc "main"), the adapter's documented
// way to export a Durable Object class alongside the Astro app. The fetch
// handler is exactly the adapter's default entrypoint.
import { handle } from '@astrojs/cloudflare/handler';

export { RateLimiter } from './lib/rateLimiter';

export default { fetch: handle } satisfies ExportedHandler<Env>;
