// Browser-side only. Mirrors the CLI's ScrubSession ring buffer, but
// learned several hard lessons about how to actually fetch the stations:
//
// 1. Reconnecting a station's proxy fetch on every hop is wrong: these
//    Icecast/StreamTheWorld sources send a pre-buffered "catch up" burst
//    to every new connection (to smooth playback start for real
//    listeners), so reconnecting every few seconds repeatedly re-injects
//    several seconds of bonus audio -- measured ~3.5x real-time inflation.
//    Fix: open each station's connection once, at tune-in, and never
//    reconnect it; discard each station's own first ~2s of bytes.
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
//    indefinitely. Fix: playback has no connection of its own at all --
//    see bufferedPlayer.ts, fed via setOnLiveChunk() below with the exact
//    same post-burst-discard bytes capture reads. Anything audible has,
//    by construction, already been sitting in this buffer.
//
// A hop-event timeline lets since() reconstruct which station was
// actually current during each slice of a requested window, then pulls
// only that slice from that station's own (un-bursted) buffer.
export interface Station {
  id: string;
  name: string;
  url: string;
}

interface RawChunk {
  bytes: Uint8Array;
  t: number;
}

interface HopEvent {
  t: number;
  stationId: string;
  stationName: string;
}

export interface CapturedChunk {
  bytes: Uint8Array;
  station: string;
}

export class StationBuffer {
  private static readonly BURST_DISCARD_MS = 2_000;

  private perStation = new Map<string, RawChunk[]>();
  private controller: AbortController | null = null;
  private hopEvents: HopEvent[] = [];
  private readonly windowMs: number;
  private currentStationId: string | null = null;
  private onLiveChunk: ((bytes: Uint8Array) => void) | null = null;

  constructor(stations: Station[], windowMs = 60_000) {
    this.windowMs = windowMs;
    for (const s of stations) this.perStation.set(s.id, []);
  }

  /** Bytes for whichever station is current, in real time, as they're
   * buffered -- for feeding a BufferedPlayer so playback only ever plays
   * what's already in this buffer. */
  setOnLiveChunk(cb: ((bytes: Uint8Array) => void) | null): void {
    this.onLiveChunk = cb;
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

  /** Record that `station` became current, right now. */
  recordHop(stationId: string, stationName: string): void {
    const now = Date.now();
    this.currentStationId = stationId;
    this.hopEvents.push({ t: now, stationId, stationName });
    const cutoff = now - this.windowMs;
    while (this.hopEvents.length > 1 && this.hopEvents[1].t < cutoff) {
      this.hopEvents.shift();
    }
  }

  /** Everything "heard" (per the hop timeline) from sinceMs to now, in
   * chronological order, each chunk tagged with whichever station was
   * actually current when it was buffered. */
  since(sinceMs: number): CapturedChunk[] {
    const now = Date.now();
    const out: CapturedChunk[] = [];

    for (let i = 0; i < this.hopEvents.length; i++) {
      const hop = this.hopEvents[i];
      const segStart = Math.max(hop.t, sinceMs);
      const segEnd = i + 1 < this.hopEvents.length ? this.hopEvents[i + 1].t : now;
      if (segEnd <= sinceMs || segStart >= segEnd) continue;

      const chunks = this.perStation.get(hop.stationId) ?? [];
      for (const c of chunks) {
        if (c.t >= segStart && c.t < segEnd) {
          out.push({ bytes: c.bytes, station: hop.stationName });
        }
      }
    }
    return out;
  }

  /** Reads the one multiplexed connection and splits frames back out to
   * each station's own buffer. Frame format (see api/stream.ts):
   * [1 byte station index][4 bytes big-endian length][payload], repeating. */
  private async demux(stations: Station[], signal: AbortSignal): Promise<void> {
    try {
      const res = await fetch('/api/stream', { signal });
      if (!res.body) return;
      const reader = res.body.getReader();

      let buf = new Uint8Array(0);
      const firstFrameAt = new Map<string, number>();

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

          if (!firstFrameAt.has(station.id)) firstFrameAt.set(station.id, Date.now());
          // Every station measured so far dumps a large pre-buffered
          // "catch up" burst (tens to hundreds of KB) in the first
          // ~0.5-1s after its own upstream connection opens, then settles
          // to real time. Discard that burst rather than let it
          // masquerade as "just heard" content -- a one-time cost at
          // tune-in, since the connection is opened once, not per hop.
          if (Date.now() - firstFrameAt.get(station.id)! < StationBuffer.BURST_DISCARD_MS) continue;

          const chunks = this.perStation.get(station.id)!;
          chunks.push({ bytes: payload, t: Date.now() });
          this.trim(chunks);
          if (station.id === this.currentStationId && this.onLiveChunk) {
            this.onLiveChunk(payload);
          }
        }
      }
    } catch {
      // Aborted at stop(), or a network hiccup -- nothing to recover.
    }
  }

  private trim(chunks: RawChunk[]): void {
    const cutoff = Date.now() - this.windowMs;
    while (chunks.length && chunks[0].t < cutoff) {
      chunks.shift();
    }
  }
}
