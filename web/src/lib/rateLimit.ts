import { env } from 'cloudflare:workers';
import type { Bucket } from './rateLimiter';

// Routes each request to its client's RateLimiter Durable Object (see
// rateLimiter.ts for the limits and why it's a DO).
//
// Keyed on cf-connecting-ip, the header Cloudflare's edge sets to the
// real client IP (and what @astrojs/cloudflare's own getClientAddress()
// reads). It survives the ghost-pages proxy, which forwards the request
// untouched. Unset in local dev -- falls back to a constant key, a single
// shared bucket, appropriate for one developer testing locally.
export async function checkRateLimit(bucket: Bucket, request: Request): Promise<boolean> {
  const key = request.headers.get('cf-connecting-ip') ?? 'local-dev';
  return env.RATE_LIMITER.getByName(key).hit(bucket);
}

export function rateLimitedResponse(body: Record<string, unknown>): Response {
  return Response.json(body, { status: 429, headers: { 'retry-after': '60' } });
}
