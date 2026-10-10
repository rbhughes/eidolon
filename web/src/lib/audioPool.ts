import type { Station } from './stationBuffer';

// Replaces msePlayer.ts entirely. That approach tried to feed one <audio>
// element live bytes via MediaSource so playback and capture would be
// byte-identical -- but MSE+raw-mp3 is unsupported on Firefox outright and
// fails probabilistically on Chromium (a single corrupted chunk from a
// live connection is fatal to Chrome's demuxer, confirmed via headless
// reproduction). Both cases fell back to `audio.src = station.url`,
// reassigned on every hop -- which reopens a fresh connection each time,
// and every station measured re-sends a large pre-buffered "catch up"
// burst (stale, already-past audio) to any new connection. Reported
// symptom: a word distinctly heard was completely absent from the
// transcript, because what was *audible* was stale burst content with no
// relationship to "now," while the capture buffer correctly recorded true
// real-time bytes -- they were never the same timeline in fallback mode.
//
// Fix: sidestep MSE entirely. Open one real <audio> element per station,
// pointed straight at that station's own URL (no proxy needed -- native
// <audio> playback never reads bytes in JS, so there's no CORS concern,
// same as the old fallback path), ALL at tune-in, and never reconnect any
// of them. Mute all but the current one. Hopping just mutes the old one
// and unmutes the new one -- no src reassignment, no reconnect, so no
// burst replay. Each muted station keeps advancing through real time in
// the background exactly like StationBuffer's own connections do, so by
// the time you hop to it, its one-time burst is long past and it's
// genuinely live. Works identically in every browser; no MSE, no codec
// fragility, no Firefox/Chromium split.
//
// Resource note: this doubles total station bandwidth (StationBuffer's
// own multiplexed proxy connection for capture, plus these 9 direct
// connections for playback) -- acceptable for a small personal demo, not
// something to optimize away here.
export class StationAudioPool {
  private elements = new Map<string, HTMLAudioElement>();
  private currentId: string | null = null;

  start(stations: Station[]): void {
    this.stop();
    for (const s of stations) {
      const audio = new Audio(s.url);
      audio.muted = true;
      audio.preload = 'auto';
      audio.play().catch(() => {
        // Muted autoplay is allowed everywhere without a user gesture;
        // a rejection here just means this station is unreachable --
        // harmless, it simply stays silent if hopped to.
      });
      this.elements.set(s.id, audio);
    }
  }

  stop(): void {
    for (const audio of this.elements.values()) {
      audio.pause();
      audio.src = '';
    }
    this.elements.clear();
    this.currentId = null;
  }

  /** Mute the previously-current station and unmute this one. Never
   * touches any element's connection. */
  setCurrent(stationId: string): void {
    if (this.currentId === stationId) return;

    const prev = this.currentId ? this.elements.get(this.currentId) : undefined;
    if (prev) prev.muted = true;

    const next = this.elements.get(stationId);
    if (next) {
      next.muted = false;
      if (next.paused) next.play().catch(() => {});
    }
    this.currentId = stationId;
  }
}
