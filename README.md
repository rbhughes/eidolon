# eidolon / spiritbox

A Python CLI "spiritbox" (ghost-box style) app built on an RTL-SDR dongle:
sweep/scan radio frequencies, capture audio, and attempt speech-to-text on
the result using a cheap model via OpenRouter.

Status: early scaffolding. Hardware verification works; frequency sweep,
recording, and transcription are not yet implemented.

## Requirements

- RTL-SDR dongle (tested with an RTL-SDR Blog V4) and the `rtl-sdr`
  userspace tools (`rtl_test`, `rtl_sdr`, `rtl_fm`) on PATH.
- Python 3.14+, managed via [`uv`](https://docs.astral.sh/uv/).

Note: audio acquisition shells out to the `rtl_fm`/`rtl_sdr` CLI tools
rather than using the `pyrtlsdr` Python bindings. On this machine the
installed driver is the RTL-SDR Blog fork (needed for V4 hardware support),
which doesn't export every symbol `pyrtlsdr` expects at import time.

## Usage

```
uv run spiritbox check   # verify the RTL-SDR tools/dongle are usable
uv run spiritbox --help
```

## Configuration

Speech-to-text will call OpenRouter; set `OPENROUTER_API_KEY` in your
environment (or a local, gitignored `.env`) once that part is implemented.
