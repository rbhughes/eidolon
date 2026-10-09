// Browser-side only. Feeds an <audio> element from the exact same bytes
// StationBuffer is recording for capture, via MediaSource Extensions --
// instead of `audio.src = stationUrl`, which gives playback its own
// independent network connection (and therefore its own independent
// burst/jitter, unrelated to what's actually buffered for capture). That
// mismatch is why "what you heard" and "what got captured" could
// disagree. Feeding both from one source makes them identical by
// construction, matching the CLI's single-pipeline guarantee.
//
// Raw MP3-via-MSE support is inconsistent, not just "Safari is behind":
// measured Firefox on Linux (Arch) rejecting `addSourceBuffer('audio/mpeg')`
// outright ("No decoders for requested formats") even though plain
// `<audio src="*.mp3">` playback works fine there via a different code
// path. Always check isSupported() and fall back to direct-URL playback
// (accepting the playback/capture sync tradeoff that motivated this
// class) rather than assume MSE+mp3 works.
export class MsePlayer {
  static isSupported(): boolean {
    return (
      typeof MediaSource !== 'undefined' &&
      typeof MediaSource.isTypeSupported === 'function' &&
      MediaSource.isTypeSupported('audio/mpeg')
    );
  }

  private mediaSource = new MediaSource();
  private sourceBuffer: SourceBuffer | null = null;
  private queue: Uint8Array[] = [];
  private appending = false;
  private audio: HTMLAudioElement | null = null;
  // Set on any unexpected SourceBuffer-removed/decode-error condition --
  // measured on Chromium (a real appendBuffer() on a live, burst-discard
  // byte offset can trigger a decode error that tears the SourceBuffer
  // out of the MediaSource entirely). Once true, every method becomes a
  // no-op so the caller's hop loop stops throwing; index.astro checks
  // hasFailed() and switches to direct-URL playback for the rest of the
  // session instead of repeating a broken call every hop.
  private failed = false;

  attach(audio: HTMLAudioElement): void {
    this.audio = audio;
    audio.src = URL.createObjectURL(this.mediaSource);
    this.mediaSource.addEventListener('sourceopen', () => {
      try {
        this.sourceBuffer = this.mediaSource.addSourceBuffer('audio/mpeg');
        this.sourceBuffer.addEventListener('updateend', () => {
          this.appending = false;
          this.pump();
        });
      } catch (err) {
        console.error('MSE not usable (audio/mpeg unsupported?):', err);
        this.failed = true;
      }
    });
  }

  hasFailed(): boolean {
    return this.failed;
  }

  /** Append a chunk of the currently-tuned station's live bytes. */
  feed(bytes: Uint8Array): void {
    if (this.failed) return;
    this.queue.push(bytes);
    this.pump();
  }

  /** Called on hop: drop whatever's queued/not-yet-played from the
   * previous station so the switch is heard immediately, not after the
   * old station's backlog finishes playing. */
  cutover(): void {
    if (this.failed) return;
    this.queue = [];
    const sb = this.sourceBuffer;
    const audio = this.audio;
    if (!sb || !audio) return;

    const dropAhead = () => {
      try {
        if (sb.buffered.length === 0) return;
        const end = sb.buffered.end(sb.buffered.length - 1);
        const start = audio.currentTime;
        if (end > start) {
          sb.remove(start, end);
        }
      } catch (err) {
        this.onSourceBufferError(err);
      }
    };

    try {
      if (sb.updating) {
        sb.abort();
        this.appending = false;
        // abort() fires its own updateend-ish settling; give it a tick.
        setTimeout(dropAhead, 0);
      } else {
        dropAhead();
      }
    } catch (err) {
      this.onSourceBufferError(err);
    }
  }

  private pump(): void {
    if (this.failed) return;
    const sb = this.sourceBuffer;
    if (!sb || this.appending || this.queue.length === 0) return;
    try {
      if (sb.updating) return;
      this.appending = true;
      const chunk = this.queue.shift()!;
      sb.appendBuffer(chunk as BufferSource);
    } catch (err) {
      this.appending = false;
      this.onSourceBufferError(err);
    }
  }

  private onSourceBufferError(err: unknown): void {
    if (this.failed) return;
    console.error('[msePlayer] SourceBuffer error, falling back to direct-URL playback:', err);
    this.failed = true;
    this.queue = [];
  }
}
