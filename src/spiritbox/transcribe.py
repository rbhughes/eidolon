"""OpenRouter speech-to-text client (OpenAI-compatible transcription endpoint)."""

from __future__ import annotations

import os

import httpx

MODEL = "mistralai/voxtral-mini-transcribe"
ENDPOINT = "https://openrouter.ai/api/v1/audio/transcriptions"


class TranscriptionError(RuntimeError):
    pass


def transcribe_wav(wav_bytes: bytes, timeout: float = 15.0) -> str:
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise TranscriptionError("OPENROUTER_API_KEY is not set")

    response = httpx.post(
        ENDPOINT,
        headers={"Authorization": f"Bearer {api_key}"},
        files={"file": ("chunk.wav", wav_bytes, "audio/wav")},
        data={"model": MODEL},
        timeout=timeout,
    )
    if response.status_code != 200:
        raise TranscriptionError(f"HTTP {response.status_code}: {response.text[:300]}")
    return response.json().get("text", "")
