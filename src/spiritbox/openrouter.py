"""OpenRouter clients: speech-to-text (OpenAI-compatible transcription
endpoint) and chat-completion translation of transcripts to English."""

from __future__ import annotations

import os

import httpx

TRANSCRIBE_MODEL = "mistralai/voxtral-mini-transcribe"
TRANSCRIBE_ENDPOINT = "https://openrouter.ai/api/v1/audio/transcriptions"

TRANSLATE_MODEL = "openai/gpt-4o-mini"
CHAT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"

TRANSLATE_SYSTEM_PROMPT = (
    "You translate radio transcripts to English. Reply with ONLY the "
    "English translation -- no commentary, no quotes, no explanation. "
    "If the text is already English, return it unchanged. If it is "
    "noise or gibberish with nothing translatable, return it unchanged."
)


class OpenRouterError(RuntimeError):
    pass


def _post(endpoint: str, timeout: float, **kwargs) -> dict:
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise OpenRouterError("OPENROUTER_API_KEY is not set")

    response = httpx.post(endpoint, headers={"Authorization": f"Bearer {api_key}"}, timeout=timeout, **kwargs)
    if response.status_code != 200:
        raise OpenRouterError(f"HTTP {response.status_code}: {response.text[:300]}")
    return response.json()


def transcribe_wav(wav_bytes: bytes, timeout: float = 15.0) -> str:
    data = _post(
        TRANSCRIBE_ENDPOINT,
        timeout,
        files={"file": ("chunk.wav", wav_bytes, "audio/wav")},
        data={"model": TRANSCRIBE_MODEL},
    )
    return data.get("text", "")


def translate_to_english(text: str, timeout: float = 10.0) -> str:
    """Translate (likely non-English) transcribed text to English.

    Empty/whitespace input is returned as-is without an API call.
    """
    if not text.strip():
        return text

    data = _post(
        CHAT_ENDPOINT,
        timeout,
        json={
            "model": TRANSLATE_MODEL,
            "messages": [
                {"role": "system", "content": TRANSLATE_SYSTEM_PROMPT},
                {"role": "user", "content": text},
            ],
            "temperature": 0,
        },
    )
    return data["choices"][0]["message"]["content"].strip()
