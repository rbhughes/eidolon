"""spiritbox CLI entry point."""

from __future__ import annotations

import typer

from spiritbox import doctor

app = typer.Typer(help="A ghost-box style RTL-SDR CLI with speech-to-text.")


@app.command()
def check() -> None:
    """Verify the RTL-SDR tools and dongle are present and functional."""
    doctor.main()


@app.command()
def start() -> None:
    """Start sweeping frequencies and streaming audio. (not yet implemented)"""
    typer.echo("start: not yet implemented")


@app.command()
def stop() -> None:
    """Stop an active sweep/stream session. (not yet implemented)"""
    typer.echo("stop: not yet implemented")


@app.command()
def record() -> None:
    """Record audio (and optionally transcribe) to a file. (not yet implemented)"""
    typer.echo("record: not yet implemented")


def main() -> None:
    app()


if __name__ == "__main__":
    main()
