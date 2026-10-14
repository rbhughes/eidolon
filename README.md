# eidolon / spiritbox

> **Try it in a browser at [ghost.purr.io](https://ghost.purr.io)** -- no
> dongle, no install. Nine live internet radio stations, a two-second
> snippet from each, and two language models deciding what the spirits
> said. Switch to *skeptic* mode to watch every connection, snippet pick,
> prompt, token count and cent as it happens.

A spirit box sweeps radio too quickly for whole words to get through, and
believers hear the dead in the gaps. This repo builds one twice:

- **`src/spiritbox/`** -- the original, and the reason for the RTL-SDR
  requirements below: a Python CLI that sweeps/scans real FM frequencies
  through an SDR dongle (or hops internet radio stations, with no hardware
  at all), plays what it hears live, and transcribes the parts you mark
  near-real-time using a cheap model via OpenRouter.
- **`web/`** -- the demo behind ghost.purr.io: an Astro + Cloudflare Worker
  port that a stranger can open without owning a radio. Internet radio is
  not a radio, and [`web/README.md`](web/README.md) is the account of what
  that cost -- burst-on-connect, the browser's six-connection limit, and
  MP3 fragments that refuse to decode alone.

Speech-to-text models invent confident words out of noise, which happens to
be exactly the property a spirit box runs on. Neither version pretends
otherwise.

## Requirements (CLI)

- RTL-SDR dongle (tested with an RTL-SDR Blog V4) and the `rtl-sdr`
  userspace tools (`rtl_test`, `rtl_sdr`, `rtl_fm`, `rtl_power`) on PATH --
  only needed for the default `sdr` sweep source.
- `ffmpeg` on PATH -- only needed for the `stream` sweep source.
- `paplay` (PipeWire's PulseAudio-compatible CLI) for audio playback.
- Python 3.14+, managed via [`uv`](https://docs.astral.sh/uv/).

Note: audio acquisition shells out to the `rtl_fm`/`rtl_sdr`/`rtl_power` CLI
tools rather than using the `pyrtlsdr` Python bindings. On this machine the
installed driver is the RTL-SDR Blog fork (needed for V4 hardware support),
which doesn't export every symbol `pyrtlsdr` expects at import time.

## Usage

```
uv run spiritbox check                      # verify the RTL-SDR tools/dongle are usable
uv run spiritbox start -f 100.0M             # live-listen (antenna testing)
uv run spiritbox record -s 10 -o out.wav     # record a fixed-duration clip
uv run spiritbox scan                        # SDR only: find local FM stations -> .run/hotspots.json
uv run spiritbox sweep                       # hop + live play, manual mark-to-transcribe, SDR source (default)
uv run spiritbox sweep --source stream       # same, internet radio source
uv run spiritbox streams                     # list configured internet radio stations
uv run spiritbox --help
```

`sweep` hops across an audio source and plays each chunk live without
auto-transcribing anything. Press SPACE to send everything heard since
the *last* mark (or since start, for the first one) to OpenRouter -- not
just a fixed trailing window, so nothing said between two marks is lost
-- capped at `--max-mark-seconds` (default 60s) in case you wait a while
before marking. `q` quits; Ctrl+C does too, but first marks whatever's
been buffered since the last mark (so you don't lose the tail end).
`--show-transcript` (on by default) reprints every marked segment in
order, with timestamps, before exiting. Because nothing is sent
automatically, hops can be short (default 1.5s) without driving up API
cost -- in practice per-hop subprocess/connection overhead caps
real-world speed around 2-3s/hop regardless, well short of a hardware
ghost box's rapid tuner-based switching. Needs an interactive terminal
(reads raw keypresses from stdin).

`sweep` also skips chunks that exactly repeat recent audio from what
gets sent when you mark -- some internet radio relays intermittently
loop a short segment instead of true live audio (`--dedup`/`--no-dedup`,
`--dedup-window`).

Non-English transcripts (e.g. a foreign-language station) are translated
to English via a second, cheap LLM call before being reported
(`--translate`/`--no-translate`). If translation fails, the original
transcript is kept with a note appended rather than being dropped.

`scan` is SDR-only (sweeps real RF frequencies via `rtl_power`) and has
no effect on `sweep --source stream`, which picks from `streams.json`
instead and never reads `scan`'s `.run/hotspots.json`.

## Configuration

- `OPENROUTER_API_KEY` -- required for transcription; set in your
  environment or a local, gitignored `.env`.
- `streams.json` -- list of `{"name", "url", "weight"}` internet radio
  stations for `sweep --source stream`. `weight` (default 1) is a
  relative selection weight -- bias toward talk/news stations over music
  ones, since music chunks reliably come back empty (nothing to
  transcribe, not a bug). Checked into the repo as a starting seed list;
  edit freely to add your own. Includes Paranormalium, a Polish-language
  paranormal/UFO/conspiracy talk station -- its output is auto-translated
  to English (see `--translate` above).
