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
// was (only chunks for the current station, post-burst-discard).
//
// Two earlier mistakes in how this class turned bytes into audible clips,
// both measured, not assumed:
//
// 1. First version cut a new clip per raw network chunk (median ~1400
//    bytes, ~88ms of audio) -- each one a full separate <audio> load/
//    play cycle, audibly chopped and too short for a word.
//
// 2. Second version batched on a fixed 1200ms timer instead -- clips got
//    long enough, but measured (via paused-state polling) only a ~36%
//    audible duty cycle, with recurring silent gaps up to ~2s. Cause: a
//    clip's actual playback duration is however much real audio it
//    contains, which rarely lines up with the timer's fixed tick -- a
//    clip would finish early, and nothing was queued yet because the
//    next tick hadn't fired, so the player sat idle until it did.
//
// Fix: don't batch on a timer at all. Cut and play whatever's
// accumulated the INSTANT the previous clip ends ('ended' event) or the
// instant the first bytes arrive after being idle -- never wait for a
// clock tick when there's audio ready to go. Each clip's length then
// naturally tracks how much arrived during the previous clip's own
// playback (since data arrives at ~1x real time), which self-stabilizes
// into continuous, gapless-ish playback with no tuned constant at all.
// The only unavoidable gaps are real ones: no data has arrived yet
// (e.g., just after a hop, before the new station's next chunk lands).
//
// 3. Measured in headless Chromium as mostly-continuous after (2), but
//    the user reported real Firefox playback as extensive, non-periodic
//    *silence* ("like someone hitting mute arbitrarily") rather than
//    clicks/pops -- a different symptom than anything measured so far.
//    Each clip is a Blob cut at whatever byte offset `pending` happened
//    to end at, which is a raw network-read boundary, not an MP3 frame
//    boundary -- there is no reason to expect it to line up with one.
//    Chromium's decoder appears tolerant of a clip starting mid-frame
//    (skips to the next sync word); this is a plausible, NOT yet
//    independently confirmed explanation for Firefox producing silence
//    for a clip instead -- Firefox's remote-debugging-port here doesn't
//    implement Chrome's CDP discovery endpoints, so headless automation
//    (the technique used for every other fix today) wasn't available to
//    directly verify this in Firefox. Fixed anyway, since it's correct
//    regardless of whether this is the exact Firefox mechanism: scan for
//    the first valid MPEG frame sync word before cutting each clip, so
//    every clip handed to <audio> starts at a real frame, never mid-one.
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
  private audio = new Audio();
  private currentUrl: string | null = null;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private playing = false;

  constructor() {
    this.audio.addEventListener('ended', () => this.playNext());
  }

  /** Accumulate one newly-arrived chunk for the current station. If
   * nothing is currently playing, start immediately with whatever's
   * here rather than waiting for more. */
  feed(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.pending.push(bytes);
    this.pendingBytes += bytes.length;
    if (!this.playing) this.playNext();
  }

  /** Called on every hop: drop anything pending/playing from the
   * previous station immediately, so there's never a backlog to play
   * through -- the next feed() (from the new current station) starts
   * fresh. */
  cutover(): void {
    this.pending = [];
    this.pendingBytes = 0;
    this.playing = false;
    this.audio.pause();
    // Revoking the object URL while audio.src still points at it leaves
    // a dangling reference -- the element can then throw an unhandled
    // NotSupportedError trying to reload a URL that no longer resolves
    // to anything. Clear src first, then revoke.
    this.audio.removeAttribute('src');
    this.releaseCurrentUrl();
  }

  stop(): void {
    this.cutover();
  }

  private playNext(): void {
    this.releaseCurrentUrl();
    if (this.pendingBytes === 0) {
      this.playing = false;
      return;
    }

    const combined = new Uint8Array(this.pendingBytes);
    let offset = 0;
    for (const b of this.pending) {
      combined.set(b, offset);
      offset += b.length;
    }
    this.pending = [];
    this.pendingBytes = 0;

    // Trim to the first real frame boundary -- discards at most a few
    // dozen leading bytes (well under 1ms of audio), not worth carrying
    // forward to the next clip.
    const syncAt = findFrameSync(combined);
    const aligned = syncAt > 0 ? combined.subarray(syncAt) : combined;

    this.playing = true;
    const blob = new Blob([aligned as BlobPart], { type: 'audio/mpeg' });
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
