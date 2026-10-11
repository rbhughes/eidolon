// Replaces the <audio src="blob:...">-swapping version. That version cut
// each clip as a Blob, pointed a single <audio> element's src at it, and
// relied on the 'ended' event to chain to the next clip. Measured choppy
// in BOTH browsers, worse in Firefox -- which makes sense once you look at
// what a src swap actually costs: every swap tears down the previous
// decode pipeline and starts a new one (fetch the blob, sniff/parse the
// container, prime the decoder, fire 'loadeddata', THEN start producing
// samples). That startup latency is real wall-clock time with no audio
// output, it is not deterministic, and it is NOT eliminated by picking
// better clip boundaries or more careful 'ended'-driven timing -- it's
// inherent to asking an <audio> element to load a new source. Firefox's
// pipeline evidently costs more of it than Chromium's, which is why the
// exact same code sounded "worse" there, but neither is actually silent
// of gaps.
//
// Fix: stop using <audio> for stream playback entirely. Use the Web Audio
// API to decode each chunk to raw PCM (AudioContext.decodeAudioData) and
// schedule it on an AudioBufferSourceNode at a precise, pre-computed
// start time (AudioBufferSourceNode.start(when)). Back-to-back scheduled
// buffers have NO engine-startup gap between them -- this is the standard
// technique for gapless playback of a sequence of buffers, and it works
// identically in both browsers because it's sample-accurate scheduling
// against the audio clock (ctx.currentTime), not wall-clock/event timing.
//
// The only timer in this file (DECODE_BATCH_MS) governs how many bytes we
// hand to decodeAudioData at once -- it has NO effect on playback timing
// or gaps. That's the opposite of the earlier (rejected) fixed-interval
// approach, where the timer directly gated when a clip started playing.
// Here, decoding happens ahead of the scheduled start time (batches are
// queued into a promise chain as they arrive, decoded while the
// previously-scheduled buffer is still playing), so sloppy timer timing
// only affects how far ahead we stay buffered, never whether playback
// stutters.
//
// Measured (headless Chromium, instrumented AudioBufferSourceNode.start
// calls directly, not guessed): once a station has a few batches queued,
// consecutive segments schedule back-to-back with ~0ms gap, confirming
// the technique works. But right after every hop, the FIRST few batches
// for the new station had small (tens-to-hundreds of ms) gaps before
// settling -- because nextStartTime resets to ctx.currentTime (correctly,
// so there's no backlog from the old station), and the very first batch's
// startAt is then "now", leaving zero lead for the next batch's decode to
// finish before its predecessor stops playing. At a 3s hop interval, that
// ramp-up was eating a real fraction of every single snippet. Fix: give
// only the first batch after each hop/cutover a small deliberate pre-roll
// (PRIME_LEAD_S) instead of starting it immediately -- that head start is
// enough for the pipeline to get ahead of real-time and stay gapless for
// the rest of the station's window. Costs a fixed, single, predictable
// silence right at the hop boundary (on top of whatever's already there
// waiting for the new station's first bytes to arrive) in exchange for
// eliminating the scattered mid-snippet stutters that used to follow it.
const DECODE_BATCH_MS = 400;
const MAX_PENDING_BYTES = 256_000; // safety valve if decode falls behind
const PRIME_LEAD_S = 0.25;

function findFrameSync(buf: Uint8Array): number {
  for (let i = 0; i < buf.length - 2; i++) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) {
      const bitrateIndex = (buf[i + 2] >> 4) & 0x0f;
      if (bitrateIndex !== 0x0f) return i; // 0b1111 is reserved/invalid -- not a real header
    }
  }
  return -1;
}

export class BufferedPlayer {
  private ctx: AudioContext;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private flushTimer: ReturnType<typeof setInterval>;
  private decodeChain: Promise<void> = Promise.resolve();
  private generation = 0;
  private nextStartTime = 0;
  private primed = false;
  private scheduled = new Set<AudioBufferSourceNode>();

  constructor() {
    this.ctx = new AudioContext();
    this.flushTimer = setInterval(() => this.flush(), DECODE_BATCH_MS);
  }

  /** Must be called from a user-gesture handler (e.g. the tune-in click)
   * -- autoplay policy in both browsers starts a fresh AudioContext
   * suspended until a gesture resumes it. */
  resume(): void {
    void this.ctx.resume();
  }

  /** Accumulate one newly-arrived chunk for the current station. Actual
   * decoding/scheduling happens on the batch timer or the size safety
   * valve, not here -- see header comment. */
  feed(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.pending.push(bytes);
    this.pendingBytes += bytes.length;
    if (this.pendingBytes >= MAX_PENDING_BYTES) this.flush();
  }

  /** Called on every hop: stop whatever's currently scheduled from the
   * previous station immediately (so there's never a backlog to play
   * through), invalidate any in-flight decode so it can't schedule stale
   * audio after this point, and reset the scheduling clock. */
  cutover(): void {
    this.generation++;
    this.pending = [];
    this.pendingBytes = 0;
    for (const src of this.scheduled) {
      try {
        src.stop();
      } catch {
        // Already finished/stopped -- fine.
      }
    }
    this.scheduled.clear();
    this.nextStartTime = this.ctx.currentTime;
    this.primed = false;
  }

  stop(): void {
    this.cutover();
    clearInterval(this.flushTimer);
  }

  private flush(): void {
    if (this.pendingBytes === 0) return;
    const combined = new Uint8Array(this.pendingBytes);
    let offset = 0;
    for (const b of this.pending) {
      combined.set(b, offset);
      offset += b.length;
    }
    this.pending = [];
    this.pendingBytes = 0;

    // Trim to the first real frame boundary -- discards at most a few
    // dozen leading bytes, not worth carrying forward to the next batch.
    const syncAt = findFrameSync(combined);
    const aligned = syncAt > 0 ? combined.subarray(syncAt) : combined;
    const bytesForDecode = aligned.slice(); // own copy: decodeAudioData detaches its input

    const gen = this.generation;
    // Chain decodes so scheduling order always matches arrival order, even
    // though decodeAudioData is async and batches can take variable time.
    this.decodeChain = this.decodeChain.then(() => this.decodeAndSchedule(bytesForDecode, gen));
  }

  private async decodeAndSchedule(bytes: Uint8Array, gen: number): Promise<void> {
    if (gen !== this.generation) return; // superseded by a hop while queued

    let audioBuffer: AudioBuffer;
    try {
      audioBuffer = await this.ctx.decodeAudioData(bytes.buffer as ArrayBuffer);
    } catch {
      // Not enough bytes yet, or a batch boundary landed somewhere a
      // decoder couldn't parse -- drop this batch. The next one starts
      // fresh at a real frame sync, so this never compounds.
      return;
    }
    if (gen !== this.generation) return; // hop happened while decoding

    const source = this.ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.ctx.destination);
    source.onended = () => this.scheduled.delete(source);

    const startAt = this.primed ? Math.max(this.ctx.currentTime, this.nextStartTime) : this.ctx.currentTime + PRIME_LEAD_S;
    this.primed = true;
    source.start(startAt);
    this.nextStartTime = startAt + audioBuffer.duration;
    this.scheduled.add(source);
  }
}
