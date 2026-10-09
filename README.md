# eidolon / spiritbox

A Python CLI "spiritbox" (ghost-box style) app: sweep/scan radio
frequencies via an RTL-SDR dongle (or, as a no-hardware alternative, hop
across internet radio stations), capture audio, and transcribe it
near-real-time using a cheap model via OpenRouter.

## Requirements

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
uv run spiritbox scan                        # find local FM stations -> .run/hotspots.json
uv run spiritbox sweep                       # hop + transcribe, SDR source (default)
uv run spiritbox sweep --source stream       # hop + transcribe, internet radio source
uv run spiritbox streams                     # list configured internet radio stations
uv run spiritbox scrub                       # fast hop + live play, manual mark-to-transcribe
uv run spiritbox --help
```

`sweep` statistically gates out dead air and static before spending an API
call on transcription (see `--debug-stats` to inspect/tune thresholds). It
also skips chunks that exactly repeat recent audio -- some internet radio
relays intermittently loop a short segment instead of true live audio
(`--dedup`/`--no-dedup`, `--dedup-window`). `scrub` applies the same check
to exclude repeated chunks from what gets sent when you mark.

`scrub` is the faster, more "ghost box"-like mode: it hops and plays
continuously without auto-transcribing anything. Press SPACE to send the
last few seconds to OpenRouter, `q` to quit. Because nothing is sent
automatically, hops can be much shorter (default 1.5s vs sweep's 3s) --
in practice per-hop subprocess/connection overhead caps real-world speed
around 2-3s/hop either way, well short of a hardware ghost box's rapid
tuner-based switching, but noticeably snappier than `sweep`. Needs an
interactive terminal.

## Configuration

- `OPENROUTER_API_KEY` -- required for transcription; set in your
  environment or a local, gitignored `.env`.
- `streams.json` -- list of `{"name", "url", "weight"}` internet radio
  stations for `sweep --source stream`/`scrub`. `weight` (default 1) is a
  relative selection weight -- bias toward talk/news stations over music
  ones, since music chunks reliably come back empty (nothing to
  transcribe, not a bug). Checked into the repo as a starting seed list;
  edit freely to add your own.
