"""Process control for live monitoring and recording.

Audio path: rtl_fm (FM demod, raw s16le PCM on stdout) piped into paplay
(PipeWire's PulseAudio-compatible player) for live listening, or captured
to a .wav file for recording. Both are CLI tools shelled out to -- see
doctor.py for why we avoid the pyrtlsdr bindings.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import time
import wave
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
STATE_DIR = PROJECT_ROOT / ".run"
STATE_FILE = STATE_DIR / "session.json"

DEFAULT_FREQ = "100.0M"
DEFAULT_VOLUME = 65536  # PulseAudio/PipeWire "normal" (unity) volume
RF_SAMPLE_RATE_ARG = "200k"
AUDIO_RATE_ARG = "48k"
AUDIO_RATE_HZ = 48000


def _rtl_fm_cmd(freq: str) -> list[str]:
    return ["rtl_fm", "-f", freq, "-M", "fm", "-s", RF_SAMPLE_RATE_ARG, "-r", AUDIO_RATE_ARG, "-"]


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _read_state() -> dict | None:
    if not STATE_FILE.exists():
        return None
    try:
        return json.loads(STATE_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        return None


def _write_state(data: dict) -> None:
    STATE_DIR.mkdir(exist_ok=True)
    STATE_FILE.write_text(json.dumps(data))


def is_running() -> dict | None:
    """Return the current session's state if both processes are still alive."""
    state = _read_state()
    if state is None:
        return None
    if _pid_alive(state["rtl_fm_pid"]) and _pid_alive(state["player_pid"]):
        return state
    STATE_FILE.unlink(missing_ok=True)
    return None


def start(freq: str = DEFAULT_FREQ, volume: int = DEFAULT_VOLUME) -> dict:
    existing = is_running()
    if existing is not None:
        raise RuntimeError(f"already running at {existing['freq']} -- run stop first")

    rtl_fm = subprocess.Popen(
        _rtl_fm_cmd(freq),
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    assert rtl_fm.stdout is not None
    player = subprocess.Popen(
        [
            "paplay",
            "--raw",
            f"--rate={AUDIO_RATE_HZ}",
            "--format=s16le",
            "--channels=1",
            "--client-name=spiritbox",
            f"--volume={volume}",
        ],
        stdin=rtl_fm.stdout,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    rtl_fm.stdout.close()  # player now owns the read end

    state = {
        "freq": freq,
        "volume": volume,
        "rtl_fm_pid": rtl_fm.pid,
        "player_pid": player.pid,
        "started_at": time.time(),
    }
    _write_state(state)
    return state


def _terminate(pid: int, timeout: float = 2.0) -> None:
    if not _pid_alive(pid):
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        return
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not _pid_alive(pid):
            return
        time.sleep(0.1)
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass


def stop() -> dict | None:
    state = _read_state()
    if state is None:
        return None
    _terminate(state["player_pid"])
    _terminate(state["rtl_fm_pid"])
    STATE_FILE.unlink(missing_ok=True)
    return state


def record(path: Path, seconds: float, freq: str = DEFAULT_FREQ) -> Path:
    if is_running() is not None:
        raise RuntimeError("live monitor is running -- run stop first")

    proc = subprocess.Popen(_rtl_fm_cmd(freq), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    assert proc.stdout is not None

    chunks: list[bytes] = []
    deadline = time.time() + seconds
    try:
        while time.time() < deadline:
            chunk = proc.stdout.read(65536)
            if not chunk:
                break
            chunks.append(chunk)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()

    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(AUDIO_RATE_HZ)
        wav.writeframes(b"".join(chunks))
    return path
