// Plays whole snippets (see StationBuffer.snippet()) back to back on the
// Web Audio clock.
//
// History, all measured rather than guessed:
// - <audio src="blob:..."> swapping: every src swap restarts the element's
//   whole decode pipeline before any sound comes out -- choppy in both
//   browsers, worse in Firefox.
// - Web Audio, fed the live edge in ~400ms batches, each decoded on its
//   own: scheduling was gapless (~0ms between start() times), but the
//   *content* wasn't -- every separately decoded mp3 fragment starts with
//   ~20-50ms of near-silence (no decoder state from the frames before it),
//   and Firefox rejects fragments that don't start on a valid frame header
//   outright. 5.9% of the audio lost in Chromium, 45.8% in Firefox (see
//   mp3.ts). Still choppy in both, still worse in Firefox.
//
// Now: one decodeAudioData per snippet, so there are no seams inside a
// snippet at all. The snippet's primer frames are decoded along with it,
// purely to give the decoder its warm-up state, and skipped via
// start()'s offset. Each snippet is scheduled to begin exactly where the
// previous one ends (start(when) on the audio clock is sample-accurate in
// both browsers), and gets a few-ms fade in/out so the one unavoidable
// splice per snippet -- two unrelated stations meeting -- doesn't click.
//
// play() calls must not overlap: await each before the next, so snippets
// queue in order.

import type { Snippet } from './stationBuffer';

const FADE_S = 0.008;
// Lead given to the very first snippet (or one after a stall), so the
// start time is never already in the past by the time start() runs.
const START_LEAD_S = 0.1;

export class SnippetPlayer {
  private ctx: AudioContext;
  private nextStartTime = 0;
  private generation = 0;
  private scheduled = new Set<AudioBufferSourceNode>();

  constructor() {
    this.ctx = new AudioContext();
  }

  /** Must be called from a user-gesture handler (e.g. the tune-in click)
   * -- autoplay policy in both browsers starts a fresh AudioContext
   * suspended until a gesture resumes it. */
  resume(): void {
    void this.ctx.resume();
  }

  /** Seconds of audio already scheduled beyond the current moment. */
  queuedSeconds(): number {
    return Math.max(0, this.nextStartTime - this.ctx.currentTime);
  }

  /**
   * Decode and schedule a snippet right after whatever is already queued.
   * Resolves with the wall-clock time (ms) it becomes audible, or null if
   * it couldn't be decoded or stop() was called meanwhile.
   */
  async play(snippet: Snippet): Promise<number | null> {
    const gen = this.generation;
    const bytes = new Uint8Array(snippet.primer.length + snippet.audio.length);
    bytes.set(snippet.primer, 0);
    bytes.set(snippet.audio, snippet.primer.length);

    let decoded: AudioBuffer;
    try {
      // decodeAudioData detaches its input -- `bytes` is our own copy.
      decoded = await this.ctx.decodeAudioData(bytes.buffer);
    } catch {
      return null;
    }
    if (gen !== this.generation) return null;

    const duration = Math.min(snippet.seconds, decoded.duration - snippet.primerSeconds);
    if (duration <= 0) return null;

    const now = this.ctx.currentTime;
    const startAt = Math.max(this.nextStartTime, now + START_LEAD_S);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(1, startAt + FADE_S);
    gain.gain.setValueAtTime(1, startAt + duration - FADE_S);
    gain.gain.linearRampToValueAtTime(0, startAt + duration);
    gain.connect(this.ctx.destination);

    const source = this.ctx.createBufferSource();
    source.buffer = decoded;
    source.connect(gain);
    source.onended = () => {
      this.scheduled.delete(source);
      gain.disconnect();
    };
    source.start(startAt, snippet.primerSeconds, duration);
    this.scheduled.add(source);
    this.nextStartTime = startAt + duration;

    return Date.now() + (startAt - now) * 1000;
  }

  /** Silence everything scheduled and forget the queue. */
  stop(): void {
    this.generation++;
    for (const src of this.scheduled) {
      try {
        src.stop();
      } catch {
        // Already finished/stopped -- fine.
      }
    }
    this.scheduled.clear();
    this.nextStartTime = 0;
  }
}
