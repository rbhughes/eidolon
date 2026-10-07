"""spiritbox CLI entry point."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

import typer

from spiritbox import doctor, runtime

app = typer.Typer(help="A ghost-box style RTL-SDR CLI with speech-to-text.")

RECORDINGS_DIR = runtime.PROJECT_ROOT / "recordings"


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


def main() -> None:
    app()


if __name__ == "__main__":
    main()
