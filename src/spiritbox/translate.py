"""OpenRouter chat-completion client for translating transcripts to English."""

from __future__ import annotations

import os

import httpx

MODEL = "openai/gpt-4o-mini"
ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"

SYSTEM_PROMPT = (
    "You translate radio transcripts to English. Reply with ONLY the "
    "English translation -- no commentary, no quotes, no explanation. "
    "If the text is already English, return it unchanged. If it is "
    "noise or gibberish with nothing translatable, return it unchanged."
)


class TranslationError(RuntimeError):
    pass


def translate_to_english(text: str, timeout: float = 10.0) -> str:
    """Translate (likely non-English) transcribed text to English.

    Empty/whitespace input is returned as-is without an API call.
    """
    if not text.strip():
        return text

    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise TranslationError("OPENROUTER_API_KEY is not set")

    response = httpx.post(
        ENDPOINT,
        headers={"Authorization": f"Bearer {api_key}"},
        json={
            "model": MODEL,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": text},
            ],
            "temperature": 0,
        },
        timeout=timeout,
    )
    if response.status_code != 200:
        raise TranslationError(f"HTTP {response.status_code}: {response.text[:300]}")
    return response.json()["choices"][0]["message"]["content"].strip()
