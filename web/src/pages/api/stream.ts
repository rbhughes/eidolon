import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { STATIONS } from '../../data/stations';
import { checkRateLimit, rateLimitedResponse } from '../../lib/rateLimit';

// Multiplexes ALL stations' live mp3 bytes through this ONE connection,
// rather than the client opening one proxy connection per station.
//
// That per-station design (one persistent fetch each, fixing the earlier
// burst-reconnect bug -- see stationBuffer.ts) had a fatal flaw discovered
// via headless-browser reproduction, not guesswork: browsers cap
// concurrent HTTP/1.1 connections to a single origin at 6. With 9 stations
// held open forever, 3 of them -- and *any other request to this origin*,
// including the transcribe POST -- queued behind the 6 live ones and
// never got dispatched, hanging indefinitely with zero network activity.
// (Might be local-dev-only, since Cloudflare's edge serves HTTP/2 in
// production, which has no such per-origin cap -- but not relied on here;
// this fix is correct regardless of HTTP version.)
//
// Fix: the server opens all 9 upstream connections itself (no per-origin
// cap on outbound fetches from a Worker) and streams a single multiplexed
// byte stream back to the client, framed as:
//   [1 byte: index into STATIONS][4 bytes big-endian: payload length][payload]
// repeating. stationBuffer.ts demuxes this back into per-station buffers.
// No CORS concern either way -- this is why a proxy exists at all (these
// third-party stations don't send CORS headers, so a direct cross-origin
// fetch() would be opaque/unreadable to client JS; playback's <audio> tag
// doesn't need this, since the browser decodes it internally without
// exposing bytes to JS).
export const GET: APIRoute = async ({ request }) => {
  // One request now instead of nine per tune-in, so if anything this is
  // more generous in practice than before -- still bounded so it can't be
  // used to hammer a station or run up bandwidth from one IP.
  if (!(await checkRateLimit(env.RATE_LIMIT_STREAM, request))) {
    return rateLimitedResponse({ error: 'rate limited, slow down' });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const safeEnqueue = (frame: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(frame);
        } catch {
          closed = true;
        }
      };

      await Promise.all(
        STATIONS.map(async (station, index) => {
          let upstream: Response;
          try {
            upstream = await fetch(station.url, { signal: request.signal });
          } catch {
            return; // this station's unreachable -- the others still work
          }
          if (!upstream.ok || !upstream.body) return;

          const reader = upstream.body.getReader();
          while (!closed && !request.signal.aborted) {
            let result: ReadableStreamReadResult<Uint8Array>;
            try {
              result = await reader.read();
            } catch {
              break; // aborted, or the upstream connection dropped
            }
            if (result.done) break;
            const value = result.value;
            if (!value || value.length === 0) continue;

            const frame = new Uint8Array(5 + value.length);
            frame[0] = index;
            new DataView(frame.buffer).setUint32(1, value.length, false);
            frame.set(value, 5);
            safeEnqueue(frame);
          }
        })
      );

      closed = true;
      try {
        controller.close();
      } catch {
        // already closed/errored from the client side -- fine
      }
    }
  });

  return new Response(stream, {
    headers: {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store'
    }
  });
};
