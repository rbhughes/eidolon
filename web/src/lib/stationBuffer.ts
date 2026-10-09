// Browser-side only. Mirrors the CLI's ScrubSession ring buffer, but
// learned the hard way that reconnecting a station's proxy fetch on every
// hop is wrong: these Icecast/StreamTheWorld sources send a pre-buffered
// "catch up" burst to every new connection (to smooth playback start for
// real listeners), so reconnecting every few seconds repeatedly re-injects
// several seconds of bonus audio -- measured ~3.5x real-time inflation.
//
// Fix: open ONE persistent connection per station at tune-in and never
// reconnect it. Each station's own buffer then genuinely advances in real
// time. Hopping only changes which station is "current" for playback and
// for what gets attributed to the listener at capture time -- it does
// NOT touch any connection. A separate hop-event timeline lets capture()
// reconstruct which station was actually playing during each slice of
// the requested window, then pulls only that slice from that station's
// own (un-bursted) buffer.
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
  private controllers = new Map<string, AbortController>();
  private hopEvents: HopEvent[] = [];
  private readonly windowMs: number;
  private currentStationId: string | null = null;
  private onLiveChunk: ((bytes: Uint8Array) => void) | null = null;

  constructor(stations: Station[], windowMs = 60_000) {
    this.windowMs = windowMs;
    for (const s of stations) this.perStation.set(s.id, []);
  }

  /** Bytes from whichever station is current, in real time, as they're
   * buffered -- for feeding an MsePlayer so playback and capture are the
   * exact same data. */
  setOnLiveChunk(cb: ((bytes: Uint8Array) => void) | null): void {
    this.onLiveChunk = cb;
  }

  /** Open one persistent connection per station. Call once at tune-in
   * (and again after stop() if resuming from a hidden tab). */
  start(stations: Station[]): void {
    this.stop();
    for (const s of stations) {
      const controller = new AbortController();
      this.controllers.set(s.id, controller);
      this.fillStation(s, controller.signal);
    }
  }

  stop(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }

  /** Record that `station` became the "current" one for playback, right now. */
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

  private async fillStation(station: Station, signal: AbortSignal): Promise<void> {
    try {
      const res = await fetch(`/api/stream?station=${encodeURIComponent(station.id)}`, { signal });
      if (!res.body) return;
      const reader = res.body.getReader();
      const chunks = this.perStation.get(station.id)!;
      const connectedAt = Date.now();
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) {
          // Every station measured so far dumps a large pre-buffered
          // "catch up" burst (tens to hundreds of KB -- 50+ seconds'
          // worth of real-time audio) in the first ~0.5-1s of a fresh
          // connection, then settles to real time. Discard that burst
          // rather than let it masquerade as "just heard" content. This
          // only costs a one-time delay at tune-in, since connections
          // are opened once now, not per hop.
          if (Date.now() - connectedAt >= StationBuffer.BURST_DISCARD_MS) {
            chunks.push({ bytes: value, t: Date.now() });
            this.trim(chunks);
            if (station.id === this.currentStationId && this.onLiveChunk) {
              this.onLiveChunk(value);
            }
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
