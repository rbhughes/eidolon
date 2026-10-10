import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { STATIONS } from '../../data/stations';
import { checkRateLimit, rateLimitedResponse } from '../../lib/rateLimit';

// Same-origin passthrough proxy for a station's live mp3 stream. This
// exists purely so client-side JS can build its own rolling audio buffer
// via fetch() -- reading a cross-origin stream's bytes directly in JS
// requires CORS, which these third-party stations don't send, so a
// direct fetch() to the station's own URL would be opaque/unreadable.
// Routing it through our own origin sidesteps that. Playback itself
// (the <audio> tag) doesn't need this -- it never reads the bytes, so
// it still points straight at the station's real URL.
export const GET: APIRoute = async ({ url, request }) => {
  // Looser than the transcribe endpoint (see wrangler.jsonc) -- this proxy
  // just relays bytes, but still bounded so it can't be used to hammer a
  // station or run up bandwidth from one IP.
  if (!(await checkRateLimit(env.RATE_LIMIT_STREAM, request))) {
    return rateLimitedResponse({ error: 'rate limited, slow down' });
  }

  const stationId = url.searchParams.get('station');
  const station = STATIONS.find((s) => s.id === stationId);
  if (!station) {
    return Response.json({ error: `unknown station: ${stationId}` }, { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(station.url, { signal: request.signal });
  } catch (err) {
    return Response.json({ error: `could not connect to station: ${err}` }, { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    return Response.json({ error: `station returned HTTP ${upstream.status}` }, { status: 502 });
  }

  return new Response(upstream.body, {
    headers: {
      'content-type': 'audio/mpeg',
      'cache-control': 'no-store'
    }
  });
};
