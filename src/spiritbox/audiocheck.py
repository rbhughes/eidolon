"""Quick statistical gating to skip chunks unlikely to contain speech.

Dead air and static have a distinctive "shape" compared to speech: dead air
is just low energy, and static/hiss is spectrally flat (broadband noise
spread evenly across frequencies), while speech concentrates energy in
formants that shift over time. This is a cheap heuristic, not a VAD model --
it only exists to avoid paying for transcription of audio that's about as
close to guaranteed-empty as we can tell without asking the API.
"""

from __future__ import annotations

import numpy as np


def _spectral_flatness(samples: np.ndarray) -> float:
    """Geometric mean / arithmetic mean of the power spectrum. 0 = tonal/
    structured (e.g. speech formants), 1 = flat broadband noise (static)."""
    if samples.size < 2:
        return 0.0
    windowed = samples * np.hanning(samples.size)
    power = np.abs(np.fft.rfft(windowed)) ** 2 + 1e-12
    geo_mean = np.exp(np.mean(np.log(power)))
    arith_mean = np.mean(power)
    return float(geo_mean / arith_mean)


def profile(pcm: bytes, sample_rate: int, frame_ms: float = 50.0) -> dict:
    """Cheap statistical fingerprint of a captured chunk."""
    samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float64)
    if samples.size == 0:
        return {"rms_dbfs": -120.0, "energy_cv": 0.0, "zcr": 0.0, "flatness": 0.0}

    rms = np.sqrt(np.mean(samples**2))
    rms_dbfs = 20 * np.log10(rms / 32768.0) if rms > 0 else -120.0

    frame_len = max(1, int(sample_rate * frame_ms / 1000))
    n_frames = samples.size // frame_len
    if n_frames >= 2:
        frames = samples[: n_frames * frame_len].reshape(n_frames, frame_len)
        frame_rms = np.sqrt(np.mean(frames**2, axis=1))
        mean_rms = frame_rms.mean()
        energy_cv = float(frame_rms.std() / mean_rms) if mean_rms > 1e-9 else 0.0
    else:
        energy_cv = 0.0

    signs = np.sign(samples)
    signs[signs == 0] = 1
    zcr = float(np.mean(signs[:-1] != signs[1:])) if samples.size > 1 else 0.0

    return {
        "rms_dbfs": float(rms_dbfs),
        "energy_cv": energy_cv,
        "zcr": zcr,
        "flatness": _spectral_flatness(samples),
    }


def is_worth_transcribing(
    pcm: bytes,
    sample_rate: int,
    silence_dbfs: float = -50.0,
    max_flatness: float = 0.45,
) -> tuple[bool, str, dict]:
    """Cheap pass/fail gate before spending an API call on transcription.

    Returns (passed, reason, stats). reason is "" when passed, otherwise
    "silence" (too quiet -- dead air) or "static" (spectrally flat broadband
    noise). Thresholds are starting points, not calibrated truth -- tune them
    against your own noise floor with `sweep --debug-stats`.
    """
    stats = profile(pcm, sample_rate)
    if stats["rms_dbfs"] < silence_dbfs:
        return False, "silence", stats
    if stats["flatness"] > max_flatness:
        return False, "static", stats
    return True, "", stats
