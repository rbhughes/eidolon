// Replaces audioPool.ts, which opened 9 direct connections straight to
// each station's URL. That had the exact same root problem the whole
// project has been fighting: a SEPARATE connection has no guaranteed
// relationship to the buffer's timeline, and in particular a plain
// <audio src> never skips a station's pre-buffered "catch up" burst --
// it just plays through it at 1x, meaning audible output silently ran
// behind true live by however long that burst represented, with nothing
// to ever reset the lag. That's why "I heard X, it's missing from the
// transcript" kept reproducing no matter which playback mechanism was
// tried: every one of them was a second, independent stream.
//
// Fix, per explicit instruction: stop maintaining two streams entirely.
// Playback has NO connection of its own. It only ever plays bytes that
// StationBuffer has *already* received, tagged, and stored for the
// current station (same burst-discarded data capture reads) -- fed via
// StationBuffer.setOnLiveChunk(), gated the same way the old MSE design
// was (only chunks for the current station, post-burst-discard). Each
// chunk becomes one small Blob, played back to back as plain, complete,
// short audio files -- not a live stream, so there's no MSE, no raw-
// stream burst behavior, no codec fragility, and it works identically in
// every browser. By construction, anything audible has already been
// sitting in the capture buffer for at least the time it took to queue
// it -- there's nothing left to desync from.
export class BufferedPlayer {
  // If playback ever falls behind (clip setup overhead compounding, a
  // network hiccup), drop older queued clips rather than let the delay
  // between "buffered" and "audible" silently grow -- the delay must
  // stay small and bounded, never drift.
  private static readonly MAX_QUEUED = 2;

  private audio = new Audio();
  private queue: Blob[] = [];
  private currentUrl: string | null = null;
  private playing = false;

  constructor() {
    this.audio.addEventListener('ended', () => this.playNext());
  }

  /** Queue one newly-arrived chunk for the current station. */
  feed(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.queue.push(new Blob([bytes as BlobPart], { type: 'audio/mpeg' }));
    while (this.queue.length > BufferedPlayer.MAX_QUEUED) this.queue.shift();
    if (!this.playing) this.playNext();
  }

  /** Called on every hop: drop anything queued/playing from the
   * previous station immediately, so there's never a backlog to play
   * through -- the next feed() (from the new current station) starts
   * fresh. */
  cutover(): void {
    this.queue = [];
    this.playing = false;
    this.audio.pause();
    this.releaseCurrentUrl();
  }

  stop(): void {
    this.cutover();
  }

  private playNext(): void {
    const blob = this.queue.shift();
    this.releaseCurrentUrl();
    if (!blob) {
      this.playing = false;
      return;
    }
    this.playing = true;
    this.currentUrl = URL.createObjectURL(blob);
    this.audio.src = this.currentUrl;
    this.audio.play().catch(() => {
      // A hop mid-play-attempt can race with this; the next feed()
      // or cutover() settles things either way.
    });
  }

  private releaseCurrentUrl(): void {
    if (this.currentUrl) {
      URL.revokeObjectURL(this.currentUrl);
      this.currentUrl = null;
    }
  }
}
