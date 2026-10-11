// Browser-side only. Mirrors the CLI's ScrubSession ring buffer, but
// learned several hard lessons about how to actually fetch the stations:
//
// 1. Reconnecting a station's proxy fetch on every hop is wrong: these
//    Icecast/StreamTheWorld sources send a pre-buffered "catch up" burst
//    to every new connection (to smooth playback start for real
//    listeners), so reconnecting every few seconds repeatedly re-injects
//    several seconds of bonus audio -- measured ~3.5x real-time inflation.
//    Fix: open each station's connection once, at tune-in, and never
//    reconnect it (api/stream.ts now does its OWN reconnection on a
//    dropped upstream, with the burst-discard applied server-side on
//    every reconnect -- see that file's header comment; this class no
//    longer needs to know or care that a reconnect ever happened).
//
// 2. Opening those 9 persistent connections AS 9 SEPARATE fetches from the
//    browser is *also* wrong -- browsers cap concurrent HTTP/1.1
//    connections to one origin at 6. Held open forever, 3 of the 9 (and
//    any other request to this origin, including the transcribe POST)
//    queue behind the 6 live ones and never get dispatched -- reproduced
//    headlessly, not guessed at (see api/stream.ts's header comment for
//    the full story). Fix: one fetch to /api/stream, which multiplexes
//    all 9 stations' bytes server-side and sends them down as a single
//    framed byte stream; demux() below splits them back out client-side.
//
// 3. Giving playback its OWN connection (directly to each station, or via
//    MSE fed from a live tap) is *also* wrong, no matter how carefully
//    synced it seems: a second connection has no guaranteed relationship
//    to this buffer's timeline, and a plain <audio src> never skips a
//    station's burst -- it plays through it at 1x with nothing to ever
//    reset the lag, so audible output silently ran behind true live
//    indefinitely. Playback has no connection of its own at all.
//
// 4. Feeding playback the live edge in small pieces as bytes arrive is
//    *also* wrong: each piece has to be decoded on its own, and that
//    measured 5.9% audio loss in Chromium and 45.8% in Firefox (see
//    mp3.ts). Since all 9 stations are buffered continuously anyway, a hop
//    instead takes a whole snippet -- the station's latest few seconds,
//    cut on validated frame boundaries -- that is already sitting here,
//    and the player decodes it as one unit.
//
// Sync between what's heard and what's transcribed is by construction:
// the player reports each snippet it schedules via recordPlayed(), and
// since() returns exactly those snippets' bytes -- the very same arrays
// that were decoded for playback, never a re-derivation from timestamps.

import { parseFrames } from './mp3';

export interface Station {
  id: string;
  name: string;
  url: string;
}

interface RawChunk {
  bytes: Uint8Array;
  t: number;
  /** Absolute byte position of this chunk in its station's stream. */
  pos: number;
}

interface StationState {
  chunks: RawChunk[];
  /** Total bytes ever received -- the absolute position of the next chunk. */
  received: number;
  /** Absolute position where this station's last snippet ended, so picking
   * the same station again continues instead of replaying audio. */
  cursor: number;
}

export interface Snippet {
  station: Station;
  /** Frames before the snippet, decoded only to warm up the decoder (bit
   * reservoir / overlap state) and skipped, never played. */
  primer: Uint8Array;
  /** Exactly the frames that get played, and transcribed. */
  audio: Uint8Array;
  primerSeconds: number;
  seconds: number;
}

interface PlayedSnippet {
  /** Wall-clock time the snippet starts being audible. */
  t: number;
  stationName: string;
  bytes: Uint8Array;
}

export interface CapturedChunk {
  bytes: Uint8Array;
  station: string;
}

// Warm-up frames ahead of each snippet. The bit reservoir can reach back
// up to 511 bytes and the MDCT overlaps one frame, so 2 is the minimum;
// one extra for margin.
const PRIMER_FRAMES = 3;
// Upper bound on how much of a station's tail to parse per snippet: ~8s
// at 320kbps, the highest Layer III bitrate.
const MAX_TAIL_BYTES = 320_000;
// A station whose newest bytes are older than this isn't live right now
// (upstream stalled/reconnecting, or we're resuming from a hidden tab and
// haven't received anything new yet) -- its tail is old audio, not a
// snippet of what's on air.
const MAX_STALENESS_MS = 2_000;

const STREAM_RECONNECT_DELAY_MS = 1_000;

export class StationBuffer {
  private perStation = new Map<string, StationState>();
  private controller: AbortController | null = null;
  private played: PlayedSnippet[] = [];
  private readonly windowMs: number;

  constructor(stations: Station[], windowMs = 60_000) {
    this.windowMs = windowMs;
    for (const s of stations) this.perStation.set(s.id, { chunks: [], received: 0, cursor: 0 });
  }

  /** Open the one multiplexed connection. Call once at tune-in (and
   * again after stop() if resuming from a hidden tab). */
  start(stations: Station[]): void {
    this.stop();
    const controller = new AbortController();
    this.controller = controller;
    this.demux(stations, controller.signal);
  }

  stop(): void {
    this.controller?.abort();
    this.controller = null;
  }

  /**
   * The station's most recent audio, up to `targetSeconds` of it, as whole
   * frames -- never anything at or before where its previous snippet ended.
   * Null if less than `minSeconds` is available (still connecting, dead
   * air upstream, or the same station was just played), or if the station
   * hasn't delivered anything recently (MAX_STALENESS_MS). Advances the
   * station's cursor, so call it only for a snippet that will be played.
   */
  snippet(station: Station, targetSeconds: number, minSeconds: number): Snippet | null {
    const state = this.perStation.get(station.id);
    if (!state || state.chunks.length === 0) return null;
    if (Date.now() - state.chunks[state.chunks.length - 1].t > MAX_STALENESS_MS) return null;

    // Concatenate just the tail of the buffer -- whole chunks, so the
    // absolute position of the first byte is known.
    let first = state.chunks.length;
    let size = 0;
    while (first > 0 && size < MAX_TAIL_BYTES) {
      first--;
      size += state.chunks[first].bytes.length;
    }
    const base = state.chunks[first].pos;
    const tail = new Uint8Array(state.received - base);
    for (let i = first; i < state.chunks.length; i++) {
      tail.set(state.chunks[i].bytes, state.chunks[i].pos - base);
    }

    const frames = parseFrames(tail);
    // Walk back from the newest frame, staying contiguous (an upstream
    // reconnect leaves a gap between frames) and after the cursor.
    let start = frames.length;
    let seconds = 0;
    while (start > 0 && seconds < targetSeconds) {
      const f = frames[start - 1];
      if (base + f.offset < state.cursor) break;
      if (start < frames.length && f.offset + f.length !== frames[start].offset) break;
      start--;
      seconds += f.seconds;
    }
    if (start === frames.length || seconds < minSeconds) return null;

    let primerStart = start;
    while (
      primerStart > 0 &&
      start - primerStart < PRIMER_FRAMES &&
      frames[primerStart - 1].offset + frames[primerStart - 1].length === frames[primerStart].offset
    ) {
      primerStart--;
    }
    let primerSeconds = 0;
    for (let i = primerStart; i < start; i++) primerSeconds += frames[i].seconds;

    const last = frames[frames.length - 1];
    const audioStart = frames[start].offset;
    const audioEnd = last.offset + last.length;
    state.cursor = base + audioEnd;
    return {
      station,
      primer: tail.slice(frames[primerStart].offset, audioStart),
      audio: tail.slice(audioStart, audioEnd),
      primerSeconds,
      seconds
    };
  }

  /** Record a snippet the player has scheduled to become audible at
   * wall-clock time `t` -- since() reads exactly these. */
  recordPlayed(snippet: Snippet, t: number): void {
    this.played.push({ t, stationName: snippet.station.name, bytes: snippet.audio });
    const cutoff = Date.now() - this.windowMs;
    while (this.played.length && this.played[0].t < cutoff) this.played.shift();
  }

  /** Every snippet that started being audible from sinceMs up to now, in
   * order -- byte-for-byte what was played. */
  since(sinceMs: number): CapturedChunk[] {
    const now = Date.now();
    return this.played
      .filter((p) => p.t >= sinceMs && p.t <= now)
      .map((p) => ({ bytes: p.bytes, station: p.stationName }));
  }

  /** Reads the one multiplexed connection and splits frames back out to
   * each station's own buffer. Frame format (see api/stream.ts):
   * [1 byte station index][4 bytes big-endian length][payload], repeating.
   * The server already discards each (re)connection's own burst, so
   * every byte seen here is clean, already-live-aligned content. */
  private async demux(stations: Station[], signal: AbortSignal): Promise<void> {
    // The server drops a client that falls too far behind (see
    // MAX_QUEUED_BYTES in api/stream.ts), and the connection can also just
    // drop -- either way, reconnect for as long as we're tuned in.
    while (!signal.aborted) {
      await this.readStream(stations, signal);
      if (!signal.aborted) await new Promise((r) => setTimeout(r, STREAM_RECONNECT_DELAY_MS));
    }
  }

  private async readStream(stations: Station[], signal: AbortSignal): Promise<void> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      const res = await fetch('/api/stream', { signal });
      if (!res.body) return;
      reader = res.body.getReader();

      let buf = new Uint8Array(0);

      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) {
          const merged = new Uint8Array(buf.length + value.length);
          merged.set(buf, 0);
          merged.set(value, buf.length);
          buf = merged;
        }

        // A read() can deliver a partial frame, several frames at once,
        // or both -- drain every complete frame currently buffered and
        // leave any trailing partial one for the next read().
        while (buf.length >= 5) {
          const view = new DataView(buf.buffer, buf.byteOffset, buf.length);
          const stationIndex = view.getUint8(0);
          const len = view.getUint32(1, false);
          if (buf.length < 5 + len) break;

          const payload = buf.slice(5, 5 + len);
          buf = buf.slice(5 + len);

          const station = stations[stationIndex];
          if (!station) continue;

          const state = this.perStation.get(station.id)!;
          state.chunks.push({ bytes: payload, t: Date.now(), pos: state.received });
          state.received += payload.length;
          this.trim(state.chunks);
        }
      }
    } catch {
      // Aborted at stop(), a network hiccup, or a malformed frame --
      // demux() reconnects unless we were stopped.
    } finally {
      // Always release the connection. Exiting this loop (e.g. on a throw)
      // without cancelling used to leave the response open but unread, and
      // the server kept queueing bytes for it -- see api/stream.ts.
      reader?.cancel().catch(() => {});
    }
  }

  private trim(chunks: RawChunk[]): void {
    const cutoff = Date.now() - this.windowMs;
    while (chunks.length && chunks[0].t < cutoff) {
      chunks.shift();
    }
  }
}
