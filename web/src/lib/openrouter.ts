// Server-side only (Cloudflare Pages Function / Astro API route). Ports
// spiritbox's transcribe.py / translate.py to the webapp, with one
// deliberate difference: there's no ffmpeg here, so raw mp3 bytes read
// straight off a station stream are sent to OpenRouter as-is -- verified
// empirically that voxtral-mini-transcribe accepts them directly.

import { hedged } from './hedge';

const TRANSCRIBE_ENDPOINT = 'https://openrouter.ai/api/v1/audio/transcriptions';
const TRANSCRIBE_MODEL = 'mistralai/voxtral-mini-transcribe';

const CHAT_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const TRANSLATE_MODEL = 'openai/gpt-4o-mini';

const TRANSLATE_SYSTEM_PROMPT =
  'You translate radio transcripts to English. Reply with ONLY the ' +
  'English translation -- no commentary, no quotes, no explanation. ' +
  'If the text is already English, return it unchanged. If it is ' +
  'noise or gibberish with nothing translatable, return it unchanged.';

// Backup-request delays (see hedge.ts): ~2.5x the slowest of 20 measured
// normal calls (transcribe max 2.2s, translate max 2.0s).
const TRANSCRIBE_HEDGE_MS = 5_000;
const TRANSLATE_HEDGE_MS = 4_000;

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
  }
}

/** Worth a replacement attempt: a network failure, or an HTTP status that
 * says "try again" (408 timeout, 429 rate limit, 5xx upstream trouble).
 * Not 4xx client errors -- the same request would fail the same way. */
function retryable(err: unknown): boolean {
  if (err instanceof OpenRouterError) {
    const s = err.status ?? 0;
    return s === 408 || s === 429 || s >= 500;
  }
  return err instanceof TypeError; // fetch's network-error type
}

/** Exactly what OpenRouter reported for one call (including its own cost
 * figure in USD), plus our wall-clock latency -- surfaced to the page's
 * debug log rather than estimated client-side. */
export interface CallInfo {
  model: string;
  provider?: string;
  ms: number;
  usage?: Record<string, unknown>;
  /** Requests sent: 1 normally, 2 if a backup or retry was needed. */
  attempts: number;
}

export interface TranscribeResult extends CallInfo {
  text: string;
}

export interface TranslateResult extends CallInfo {
  text: string;
  systemPrompt: string;
  input: string;
}

async function transcribeOnce(apiKey: string, bytes: Uint8Array, signal: AbortSignal) {
  // Built per attempt: a request body can only be sent once.
  const form = new FormData();
  form.append('file', new Blob([bytes as BlobPart], { type: 'audio/mpeg' }), 'chunk.mp3');
  form.append('model', TRANSCRIBE_MODEL);
  const resp = await fetch(TRANSCRIBE_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal
  });
  if (!resp.ok) {
    throw new OpenRouterError(`transcription HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`, resp.status);
  }
  return (await resp.json()) as { text?: string; usage?: Record<string, unknown> };
}

export async function transcribeMp3(
  apiKey: string,
  bytes: Uint8Array,
  timeoutMs = 20_000,
  cancel?: AbortSignal
): Promise<TranscribeResult> {
  const started = Date.now();
  const { value: data, attempts } = await hedged((signal) => transcribeOnce(apiKey, bytes, signal), {
    hedgeAfterMs: TRANSCRIBE_HEDGE_MS,
    timeoutMs,
    cancel,
    retryable
  });
  return { text: data.text ?? '', model: TRANSCRIBE_MODEL, ms: Date.now() - started, usage: data.usage, attempts };
}

async function translateOnce(apiKey: string, text: string, signal: AbortSignal) {
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
    throw new OpenRouterError(`translation HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`, resp.status);
  }
  return (await resp.json()) as {
    choices?: { message?: { content?: string } }[];
    provider?: string;
    usage?: Record<string, unknown>;
  };
}

export async function translateToEnglish(
  apiKey: string,
  text: string,
  timeoutMs = 15_000,
  cancel?: AbortSignal
): Promise<TranslateResult> {
  const started = Date.now();
  const { value: data, attempts } = await hedged((signal) => translateOnce(apiKey, text, signal), {
    hedgeAfterMs: TRANSLATE_HEDGE_MS,
    timeoutMs,
    cancel,
    retryable
  });
  return {
    text: data.choices?.[0]?.message?.content?.trim() ?? text,
    systemPrompt: TRANSLATE_SYSTEM_PROMPT,
    input: text,
    model: TRANSLATE_MODEL,
    provider: data.provider,
    ms: Date.now() - started,
    usage: data.usage,
    attempts
  };
}
