// Server-side only (Cloudflare Pages Function / Astro API route). Ports
// spiritbox's transcribe.py / translate.py to the webapp, with one
// deliberate difference: there's no ffmpeg here, so raw mp3 bytes read
// straight off a station stream are sent to OpenRouter as-is -- verified
// empirically that voxtral-mini-transcribe accepts them directly.

const TRANSCRIBE_ENDPOINT = 'https://openrouter.ai/api/v1/audio/transcriptions';
const TRANSCRIBE_MODEL = 'mistralai/voxtral-mini-transcribe';

const CHAT_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const TRANSLATE_MODEL = 'openai/gpt-4o-mini';

const TRANSLATE_SYSTEM_PROMPT =
  'You translate radio transcripts to English. Reply with ONLY the ' +
  'English translation -- no commentary, no quotes, no explanation. ' +
  'If the text is already English, return it unchanged. If it is ' +
  'noise or gibberish with nothing translatable, return it unchanged.';

export class OpenRouterError extends Error {}

export async function transcribeMp3(apiKey: string, bytes: Uint8Array, timeoutMs = 20_000): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([bytes as BlobPart], { type: 'audio/mpeg' }), 'chunk.mp3');
  form.append('model', TRANSCRIBE_MODEL);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(TRANSCRIBE_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal
    });
    if (!resp.ok) {
      throw new OpenRouterError(`transcription HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    }
    const data = (await resp.json()) as { text?: string };
    return data.text ?? '';
  } finally {
    clearTimeout(timer);
  }
}

export async function translateToEnglish(apiKey: string, text: string, timeoutMs = 15_000): Promise<string> {
  if (!text.trim()) return text;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(CHAT_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: TRANSLATE_MODEL,
        messages: [
          { role: 'system', content: TRANSLATE_SYSTEM_PROMPT },
          { role: 'user', content: text }
        ],
        temperature: 0
      }),
      signal: controller.signal
    });
    if (!resp.ok) {
      throw new OpenRouterError(`translation HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    }
    const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content?.trim() ?? text;
  } finally {
    clearTimeout(timer);
  }
}
