"""spiritbox CLI entry point."""

from __future__ import annotations

import select
import sys
import termios
import tty
from datetime import datetime
from pathlib import Path

import typer
from dotenv import load_dotenv

from spiritbox import doctor, runtime

load_dotenv(runtime.PROJECT_ROOT / ".env")

app = typer.Typer(help="A ghost-box style RTL-SDR CLI with speech-to-text.")

RECORDINGS_DIR = runtime.PROJECT_ROOT / "recordings"


def _parse_freq(value: str) -> float:
    value = value.strip().upper()
    if value.endswith("M"):
        return float(value[:-1]) * 1e6
    if value.endswith("K"):
        return float(value[:-1]) * 1e3
    return float(value)


@app.command()
def check() -> None:
    """Verify the RTL-SDR tools and dongle are present and functional."""
    doctor.main()


@app.command()
def start(
    freq: str = typer.Option(runtime.DEFAULT_FREQ, "--freq", "-f", help="Frequency, e.g. 100.0M"),
    volume: int = typer.Option(
        runtime.DEFAULT_VOLUME, "--volume", "-v", help="Linear playback volume (65536 = unity, higher boosts quiet signals)"
    ),
) -> None:
    """Start live-listening at a frequency (useful for antenna adjustment)."""
    try:
        state = runtime.start(freq, volume)
    except RuntimeError as exc:
        typer.echo(f"error: {exc}", err=True)
        raise typer.Exit(1)
    typer.echo(f"listening at {state['freq']} (rtl_fm pid={state['rtl_fm_pid']}, player pid={state['player_pid']})")
    typer.echo("run 'spiritbox stop' to stop")


@app.command()
def stop() -> None:
    """Stop an active live-listening session."""
    state = runtime.stop()
    if state is None:
        typer.echo("nothing running")
    else:
        typer.echo(f"stopped (was listening at {state['freq']})")


@app.command()
def record(
    seconds: float = typer.Option(10.0, "--seconds", "-s", help="Duration to record"),
    freq: str = typer.Option(runtime.DEFAULT_FREQ, "--freq", "-f", help="Frequency, e.g. 100.0M"),
    out: Path = typer.Option(None, "--out", "-o", help="Output .wav path"),
) -> None:
    """Record audio to a .wav file for a fixed duration."""
    if out is None:
        timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        out = RECORDINGS_DIR / f"{timestamp}.wav"
    try:
        path = runtime.record(out, seconds, freq)
    except RuntimeError as exc:
        typer.echo(f"error: {exc}", err=True)
        raise typer.Exit(1)
    typer.echo(f"recorded {seconds}s at {freq} -> {path}")


@app.command()
def scan(
    band_low: str = typer.Option("88.0M", "--band-low", help="Low end of the scan range"),
    band_high: str = typer.Option("108.0M", "--band-high", help="High end of the scan range"),
) -> None:
    """Scan a band for active stations and save them as sweep hotspots.

    SDR only -- uses the RTL-SDR dongle to sweep real RF frequencies.
    Irrelevant to 'sweep --source stream', which picks from streams.json
    instead and never reads hotspots.json.
    """
    typer.echo("scanning (takes ~20s)...")
    band = (_parse_freq(band_low), _parse_freq(band_high))
    peaks = runtime.scan(band=band)
    if not peaks:
        typer.echo("no clear peaks found")
        return
    for p in peaks:
        typer.echo(f"{p['freq_hz'] / 1e6:7.2f} MHz  {p['db']:6.2f} dB")
    typer.echo(f"saved {len(peaks)} hotspots -> {runtime.HOTSPOTS_FILE}")


@app.command()
def streams() -> None:
    """List the internet radio stations configured for 'sweep --source stream'."""
    stations = runtime.load_streams()
    if not stations:
        typer.echo(f"no stations configured -- add some to {runtime.STREAMS_FILE}")
        return
    for s in stations:
        typer.echo(f"{s['name']} (weight {s.get('weight', 1)}): {s['url']}")


@app.command()
def sweep(
    chunk_seconds: float = typer.Option(
        1.5, "--chunk-seconds", "-c", help="Seconds of audio per hop (shorter = faster perceived sweep)"
    ),
    band_low: str = typer.Option("88.0M", "--band-low", help="Low end of the hop range (sdr source only)"),
    band_high: str = typer.Option("108.0M", "--band-high", help="High end of the hop range (sdr source only)"),
    volume: int = typer.Option(runtime.DEFAULT_VOLUME, "--volume", "-v", help="Linear playback volume"),
    source: str = typer.Option(
        "sdr", "--source", help="Where chunks come from: 'sdr' (RTL-SDR dongle) or 'stream' (internet radio)"
    ),
    hotspot_bias: float = typer.Option(
        0.6, "--hotspot-bias", help="sdr source only: fraction of hops biased toward scan()-found stations"
    ),
    max_mark_seconds: float = typer.Option(
        60.0,
        "--max-mark-seconds",
        "-m",
        help="Cap on how far back a mark can reach if you wait a while between marks",
    ),
    buffer_seconds: float = typer.Option(
        75.0, "--buffer-seconds", help="How much audio history stays available to mark (keep above --max-mark-seconds)"
    ),
    dedup: bool = typer.Option(
        True, "--dedup/--no-dedup", help="Exclude chunks that exactly repeat recent audio (a looping stream relay) from marks"
    ),
    dedup_window: float = typer.Option(120.0, "--dedup-window", help="How far back (seconds) to check for repeated chunks"),
    translate: bool = typer.Option(
        True, "--translate/--no-translate", help="Translate non-English transcripts to English via a second LLM call"
    ),
    show_transcript: bool = typer.Option(
        True,
        "--show-transcript/--no-show-transcript",
        help="Print every marked segment again, in order, when you quit. "
        "If on, Ctrl+C also marks whatever's buffered before quitting.",
    ),
) -> None:
    """Hop across an audio source, playing live, with manual mark-to-transcribe.

    source=sdr (default): hops across the RTL-SDR FM channel grid. Run
    'spiritbox scan' first to bias hops toward actual local stations;
    without it, hops are random across the grid.

    source=stream: hops across the internet radio stations listed in
    streams.json instead -- no dongle needed. See 'spiritbox streams'.

    Press SPACE to mark everything heard since the last mark (or since
    start, for the first one) for transcription, 'q' to quit. Nothing is
    sent to OpenRouter until you say so -- you decide by ear what's worth
    transcribing, which keeps hops fast since most of them are never sent
    anywhere.

    Requires an interactive terminal (reads raw keypresses from stdin).
    """
    if not sys.stdin.isatty():
        typer.echo("error: 'sweep' needs an interactive terminal (stdin is not a tty)", err=True)
        raise typer.Exit(1)

    band = (_parse_freq(band_low), _parse_freq(band_high))

    if source == "sdr" and not runtime.load_hotspots():
        typer.echo("no saved hotspots -- run 'spiritbox scan' first for better odds of real text")
    if source == "stream" and not runtime.load_streams():
        typer.echo(f"error: no stations configured -- add some to {runtime.STREAMS_FILE}", err=True)
        raise typer.Exit(1)

    def on_chunk(label: str, index: int) -> None:
        typer.echo(f"\r[{index}] {label:<24}", nl=False)

    def on_transcript(timestamp: str, label_summary: str, text: str) -> None:
        typer.echo(f"\n>> [{timestamp}] {label_summary}: {text!r}")

    def on_profile(label: str, index: int, is_duplicate: bool) -> None:
        if is_duplicate:
            typer.echo(f"\n[dup] {label} (hop {index}) repeated recent audio -- excluded from marks")

    try:
        session = runtime.SweepSession(
            chunk_seconds=chunk_seconds,
            band=band,
            hotspot_bias=hotspot_bias,
            volume=volume,
            source=source,
            buffer_seconds=buffer_seconds,
            dedup=dedup,
            dedup_window_seconds=dedup_window,
            translate=translate,
            on_chunk=on_chunk,
            on_transcript=on_transcript,
            on_profile=on_profile,
        )
    except (RuntimeError, ValueError) as exc:
        typer.echo(f"error: {exc}", err=True)
        raise typer.Exit(1)

    typer.echo(f"sweeping -- SPACE marks everything since the last mark (capped at {max_mark_seconds:.0f}s), q quits")
    session.start()

    fd = sys.stdin.fileno()
    old_settings = termios.tcgetattr(fd)
    try:
        tty.setcbreak(fd)
        while True:
            ready, _, _ = select.select([sys.stdin], [], [], 0.1)
            if not ready:
                continue
            ch = sys.stdin.read(1)
            if ch == " ":
                typer.echo("\n[marked]")
                session.mark(max_window_seconds=max_mark_seconds)
            elif ch in ("q", "Q"):
                break
    except KeyboardInterrupt:
        if show_transcript:
            typer.echo("\n[ctrl+c: marking final audio]")
            session.mark(max_window_seconds=max_mark_seconds)
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
        typer.echo("\nstopping...")
        session.stop()

    if show_transcript:
        transcript = session.get_transcript()
        typer.echo("\n--- full transcript ---")
        if not transcript:
            typer.echo("(nothing marked)")
        for timestamp, label_summary, text in transcript:
            typer.echo(f"[{timestamp}] {label_summary}: {text!r}")


def main() -> None:
    app()


if __name__ == "__main__":
    main()
