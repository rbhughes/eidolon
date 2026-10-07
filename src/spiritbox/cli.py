"""spiritbox CLI entry point."""

from __future__ import annotations

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
    """Scan a band for active stations and save them as sweep hotspots."""
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
def sweep(
    chunk_seconds: float = typer.Option(3.0, "--chunk-seconds", "-c", help="Seconds of audio per hop"),
    band_low: str = typer.Option("88.0M", "--band-low", help="Low end of the hop range"),
    band_high: str = typer.Option("108.0M", "--band-high", help="High end of the hop range"),
    duration: float = typer.Option(None, "--duration", "-d", help="Total seconds to run; omit to run until Ctrl+C"),
    volume: int = typer.Option(runtime.DEFAULT_VOLUME, "--volume", "-v", help="Linear playback volume"),
    hotspot_bias: float = typer.Option(
        0.6, "--hotspot-bias", help="Fraction of hops biased toward scan()-found stations (0 = fully random valid channels)"
    ),
) -> None:
    """Hop across a frequency band, transcribing each chunk near-real-time.

    Run 'spiritbox scan' first to bias hops toward actual local stations;
    without it, hops are random across the real FM channel grid.
    """
    band = (_parse_freq(band_low), _parse_freq(band_high))

    def on_chunk(freq: str, index: int) -> None:
        typer.echo(f"[{index}] tuning {freq}...")

    def on_transcript(freq: str, index: int, text: str) -> None:
        typer.echo(f"[{index}] {freq}: {text!r}")

    if not runtime.load_hotspots():
        typer.echo("no saved hotspots -- run 'spiritbox scan' first for better odds of real text")
    typer.echo("sweeping -- press Ctrl+C to stop")
    try:
        runtime.sweep(
            chunk_seconds=chunk_seconds,
            band=band,
            hotspot_bias=hotspot_bias,
            volume=volume,
            total_seconds=duration,
            on_chunk=on_chunk,
            on_transcript=on_transcript,
        )
    except RuntimeError as exc:
        typer.echo(f"error: {exc}", err=True)
        raise typer.Exit(1)
    except KeyboardInterrupt:
        typer.echo("\nstopped")


def main() -> None:
    app()


if __name__ == "__main__":
    main()
