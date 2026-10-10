// Thin wrapper around Cloudflare's native Rate Limiting binding (see
// wrangler.jsonc's "ratelimits" array) -- a per-key sliding window the
// platform tracks for us, so there's no KV/Durable Object counter to
// write and no race conditions to worry about across concurrent isolates.
//
// Keyed on cf-connecting-ip, the header Cloudflare's edge sets to the
// real client IP (and what @astrojs/cloudflare's own getClientAddress()
// reads). Unset in local dev -- falls back to a constant key, which still
// exercises the binding (Miniflare simulates it locally too) against a
// single shared bucket, appropriate for one developer testing locally.
export async function checkRateLimit(limiter: RateLimit, request: Request): Promise<boolean> {
  const key = request.headers.get('cf-connecting-ip') ?? 'local-dev';
  const { success } = await limiter.limit({ key });
  return success;
}

export function rateLimitedResponse(body: Record<string, unknown>): Response {
  return Response.json(body, { status: 429, headers: { 'retry-after': '60' } });
}
