// Minimal MPEG audio (Layer III) frame parser -- just enough to cut a
// live station's byte stream on real frame boundaries and know exactly how
// much audio each frame holds.
//
// Why this exists: the station streams are arbitrary byte slices of an
// endless mp3, and both browsers' decodeAudioData are picky about what they
// get. Firefox rejects input that doesn't start exactly on a valid frame
// header ("unknown content type"); Chromium accepts it but every separately
// decoded fragment starts with ~20-50ms of near-silence (the decoder has no
// bit-reservoir/overlap state from the frames before it). Measured on a
// 19s Deutschlandfunk recording, decoding the old player's way (~400ms
// batches, weak one-byte sync check): Chromium lost 5.9% of the audio to
// those leading silences, Firefox failed 21 of 48 batches outright and lost
// 45.8% -- the "choppy in both, far worse in Firefox" the user heard. The
// same bytes decoded whole, from a validated frame start, came out exactly
// as long as the frames say (18.984s) in both.

const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES_V1 = [44100, 48000, 32000];

interface FrameHeader {
  length: number;
  seconds: number;
  /** The header bits that must stay constant across a stream's frames
   * (sync, version, layer, sample rate) -- used to reject false syncs. */
  key: number;
}

function readHeader(b: Uint8Array, i: number): FrameHeader | null {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const version = (b[i + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5, 1 = reserved
  const layer = (b[i + 1] >> 1) & 3; // 1 = Layer III
  const bitrateIndex = b[i + 2] >> 4;
  const sampleRateIndex = (b[i + 2] >> 2) & 3;
  const padding = (b[i + 2] >> 1) & 1;
  if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) {
    return null;
  }
  const mpeg1 = version === 3;
  const sampleRate = SAMPLE_RATES_V1[sampleRateIndex] / (mpeg1 ? 1 : version === 2 ? 2 : 4);
  const bitrate = (mpeg1 ? BITRATES_V1 : BITRATES_V2)[bitrateIndex] * 1000;
  const samples = mpeg1 ? 1152 : 576;
  return {
    length: Math.floor(((samples / 8) * bitrate) / sampleRate) + padding,
    seconds: samples / sampleRate,
    key: (b[i + 1] << 8) | (b[i + 2] & 0x0c)
  };
}

export interface Mp3Frame {
  /** Offset of the frame within the parsed buffer. */
  offset: number;
  length: number;
  seconds: number;
}

/**
 * Every complete frame in `b`, in order. A header only counts once the
 * next frame's header is found exactly where this one says it ends (or
 * this frame ends exactly at the end of the buffer), so a stray 0xFFE
 * inside audio data can't start a bogus frame. After a discontinuity (an
 * upstream reconnect splices two streams mid-frame) it rescans byte by
 * byte until frames chain again. A trailing partial frame is left out.
 */
export function parseFrames(b: Uint8Array): Mp3Frame[] {
  const frames: Mp3Frame[] = [];
  let key: number | null = null;
  let i = 0;
  while (i + 4 <= b.length) {
    const h = readHeader(b, i);
    if (!h || (key !== null && h.key !== key) || i + h.length > b.length) {
      if (h && key !== null && h.key === key && i + h.length > b.length) break; // partial last frame
      key = null;
      i++;
      continue;
    }
    const end = i + h.length;
    // Too close to the end to see the next header -- accept (only the
    // last frame of a buffer is ever judged on its own header alone).
    const next = end + 4 > b.length ? null : readHeader(b, end);
    const chains = end + 4 > b.length || (next !== null && next.key === h.key);
    if (!chains) {
      key = null;
      i++;
      continue;
    }
    frames.push({ offset: i, length: h.length, seconds: h.seconds });
    key = h.key;
    i = end;
  }
  return frames;
}
