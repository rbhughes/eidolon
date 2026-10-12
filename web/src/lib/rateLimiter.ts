import { DurableObject } from 'cloudflare:workers';

// Per-client rate limiter: one Durable Object per client key (see
// rateLimit.ts), holding a sliding log of that client's recent hits.
//
// Replaces Cloudflare's native Rate Limiting binding, whose counts are
// "local to the Cloudflare location" and "eventually consistent" -- per
// its own docs not an accounting system. A Durable Object is a single
// instance worldwide for a given name, so these counts are exact.
//
// Deliberately NOT a global cap: Cloudflare's DO guidance calls a single
// global rate-limiter object a common mistake (every request funnels
// through one instance). The hard spending ceiling is the OpenRouter
// key's own credit limit, set on OpenRouter's side.
export const LIMITS = {
  // The OpenRouter-backed endpoint: costs real money per call.
  transcribe: { limit: 10, periodMs: 60_000 },
  // The station-stream relay: one request per tune-in, plus reconnects.
  stream: { limit: 60, periodMs: 60_000 }
} as const;

export type Bucket = keyof typeof LIMITS;

const LONGEST_PERIOD_MS = Math.max(...Object.values(LIMITS).map((l) => l.periodMs));

export class RateLimiter extends DurableObject<Env> {
  // Records a hit and returns whether it's within the limit. Counts live in
  // storage, not memory: an idle object is evicted after 70-140s and loses
  // its in-memory state. The get-then-put below has no other I/O between
  // them, which the DO runtime makes atomic -- concurrent requests from the
  // same client can't both read the same count.
  async hit(bucket: Bucket): Promise<boolean> {
    const { limit, periodMs } = LIMITS[bucket];
    const now = Date.now();
    const recent = ((await this.ctx.storage.get<number[]>(bucket)) ?? []).filter((t) => now - t < periodMs);
    const allowed = recent.length < limit;
    if (allowed) recent.push(now);
    await this.ctx.storage.put(bucket, recent);
    // Pushed back on every hit, so it fires only once the client has been
    // quiet for a full window -- when every logged hit has expired anyway.
    await this.ctx.storage.setAlarm(now + LONGEST_PERIOD_MS);
    return allowed;
  }

  // Forget the client entirely, so per-IP objects don't accumulate storage.
  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
