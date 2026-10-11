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

/** An AbortController that fires on the timeout or when `cancel` does
 * (the visitor pressed stop and the request was aborted). */
function abortOn(timeoutMs: number, cancel?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onCancel = () => controller.abort();
  cancel?.addEventListener('abort', onCancel, { once: true });
  if (cancel?.aborted) controller.abort();
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      cancel?.removeEventListener('abort', onCancel);
    }
  };
}

/** Exactly what OpenRouter reported for one call (including its own cost
 * figure in USD), plus our wall-clock latency -- surfaced to the page's
 * debug log rather than estimated client-side. */
export interface CallInfo {
  model: string;
  provider?: string;
  ms: number;
  usage?: Record<string, unknown>;
}

export interface TranscribeResult extends CallInfo {
  text: string;
}

export interface TranslateResult extends CallInfo {
  text: string;
  systemPrompt: string;
  input: string;
}

export async function transcribeMp3(
  apiKey: string,
  bytes: Uint8Array,
  timeoutMs = 20_000,
  cancel?: AbortSignal
): Promise<TranscribeResult> {
  const form = new FormData();
  form.append('file', new Blob([bytes as BlobPart], { type: 'audio/mpeg' }), 'chunk.mp3');
  form.append('model', TRANSCRIBE_MODEL);

  const { signal, done } = abortOn(timeoutMs, cancel);
  const started = Date.now();
  try {
    const resp = await fetch(TRANSCRIBE_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal
    });
    if (!resp.ok) {
      throw new OpenRouterError(`transcription HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    }
    const data = (await resp.json()) as { text?: string; usage?: Record<string, unknown> };
    return { text: data.text ?? '', model: TRANSCRIBE_MODEL, ms: Date.now() - started, usage: data.usage };
  } finally {
    done();
  }
}

export async function translateToEnglish(
  apiKey: string,
  text: string,
  timeoutMs = 15_000,
  cancel?: AbortSignal
): Promise<TranslateResult> {
  const { signal, done } = abortOn(timeoutMs, cancel);
  const started = Date.now();
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
        temperature: 0,
        // Ask OpenRouter to include the call's actual cost in `usage`.
        usage: { include: true }
      }),
      signal
    });
    if (!resp.ok) {
      throw new OpenRouterError(`translation HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    }
    const data = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
      provider?: string;
      usage?: Record<string, unknown>;
    };
    return {
      text: data.choices?.[0]?.message?.content?.trim() ?? text,
      systemPrompt: TRANSLATE_SYSTEM_PROMPT,
      input: text,
      model: TRANSLATE_MODEL,
      provider: data.provider,
      ms: Date.now() - started,
      usage: data.usage
    };
  } finally {
    done();
  }
}
