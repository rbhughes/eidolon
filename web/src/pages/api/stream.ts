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
//
// A station's own upstream connection can end on its own (BBC's CDN in
// particular measured dropping after ~12s, with no error -- the read
// loop just naturally returns done:true), not just on client abort.
// First version here had no reconnect logic: once that happened, the
// station went permanently silent for the rest of the session -- the
// read loop's Promise just resolved and nothing restarted it. Measured,
// not assumed: a headless test showed BBC World Service and BBC Arabic
// both stopping at the exact same byte count and never producing another
// frame for the remainder of the session, while every other station kept
// working. Fixed by reconnecting (with a short backoff) whenever a
// station's loop ends for any reason other than the client disconnecting.
//
// Burst-discard also moved SERVER-SIDE as part of this fix. It used to
// live in stationBuffer.ts, keyed by each station's first-frame-ever
// timestamp -- which only worked because a station connected exactly
// once. A reconnect gets its own fresh burst from the upstream, and that
// client-side key would never re-arm for it, re-injecting stale "catch
// up" audio into the buffer every time a station reconnects. Discarding
// each (re)connection's own first BURST_DISCARD_MS here means the client
// never needs to know a reconnect happened at all -- it only ever sees
// clean, already-live-aligned bytes, from any connection, on the first
// try or the fiftieth.
const BURST_DISCARD_MS = 2_000;
const RECONNECT_DELAY_MS = 1_500;

// Hard cap on bytes queued for a client that isn't reading. The first
// version enqueued unconditionally, ignoring backpressure: a client that
// held the connection open but stopped reading (stalled tab, a client-side
// read loop that died without cancelling) made the 9 upstream relays pile
// bytes into the stream's queue forever. Measured ~22MB/min growth per
// stalled client, never reclaimed -- left overnight it grew the local
// workerd to 8GB and got it OOM-killed (and in production one such client
// would blow the isolate's memory limit for everyone on it). Now the queue
// is bounded by construction: once it's full the client is too far behind
// to be "live" anyway, so the connection is terminated (and every upstream
// fetch aborted) instead of buffering. The client reconnects on its own.
// ~512KB is ~3.5s of all 9 stations at ~128kbps each.
const MAX_QUEUED_BYTES = 512 * 1024;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const GET: APIRoute = async ({ request }) => {
  // One request now instead of nine per tune-in, so if anything this is
  // more generous in practice than before -- still bounded so it can't be
  // used to hammer a station or run up bandwidth from one IP.
  if (!(await checkRateLimit('stream', request))) {
    return rateLimitedResponse({ error: 'rate limited, slow down' });
  }

  // Aborted when the client disconnects OR when we terminate a client
  // that fell too far behind -- either way every upstream fetch stops.
  const upstreamAbort = new AbortController();
  request.signal.addEventListener('abort', () => upstreamAbort.abort(), { once: true });
  const signal = upstreamAbort.signal;

  const stream = new ReadableStream<Uint8Array>(
    {
      async start(controller) {
        let closed = false;
        const safeEnqueue = (frame: Uint8Array) => {
          if (closed) return;
          // desiredSize <= 0 means MAX_QUEUED_BYTES are already sitting
          // unread -- drop the client rather than grow the queue.
          if ((controller.desiredSize ?? 0) <= 0) {
            closed = true;
            upstreamAbort.abort();
            try {
              controller.error(new Error('client not keeping up with live stream'));
            } catch {
              // already closed/errored
            }
            return;
          }
          try {
            controller.enqueue(frame);
          } catch {
            closed = true;
            upstreamAbort.abort();
          }
        };

        async function relayStation(station: (typeof STATIONS)[number], index: number): Promise<void> {
          while (!closed && !signal.aborted) {
            let upstream: Response;
            try {
              upstream = await fetch(station.url, { signal });
            } catch {
              if (signal.aborted) return;
              await sleep(RECONNECT_DELAY_MS);
              continue;
            }
            if (!upstream.ok || !upstream.body) {
              await sleep(RECONNECT_DELAY_MS);
              continue;
            }

            const reader = upstream.body.getReader();
            const connectedAt = Date.now();
            while (!closed && !signal.aborted) {
              let result: ReadableStreamReadResult<Uint8Array>;
              try {
                result = await reader.read();
              } catch {
                break; // aborted, or this connection dropped -- fall through to reconnect
              }
              if (result.done) break; // this connection ended on its own -- reconnect below
              const value = result.value;
              if (!value || value.length === 0) continue;
              if (Date.now() - connectedAt < BURST_DISCARD_MS) continue;

              const frame = new Uint8Array(5 + value.length);
              frame[0] = index;
              new DataView(frame.buffer).setUint32(1, value.length, false);
              frame.set(value, 5);
              safeEnqueue(frame);
            }

            if (signal.aborted) return;
            await sleep(RECONNECT_DELAY_MS);
          }
        }

        await Promise.all(STATIONS.map((station, index) => relayStation(station, index)));

        closed = true;
        try {
          controller.close();
        } catch {
          // already closed/errored from the client side -- fine
        }
      },
      cancel() {
        upstreamAbort.abort();
      }
    },
    new ByteLengthQueuingStrategy({ highWaterMark: MAX_QUEUED_BYTES })
  );

  return new Response(stream, {
    headers: {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store'
    }
  });
};
