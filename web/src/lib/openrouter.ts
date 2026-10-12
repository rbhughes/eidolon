// Server-side only (Astro API route on the Worker). Ports spiritbox's
// openrouter.py to the webapp, with one
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

/** What /api/transcribe's `debug` field carries: everything the page's
 * debug log shows about the model calls. */
export interface TranscribeDebug {
  clipBytes: number;
  transcription: Omit<TranscribeResult, 'text'> & { rawText: string };
  /** null: nothing to translate (empty transcript). */
  translation: TranslateResult | { error: string } | null;
}

export type TranscribeResponse =
  | { ok: true; text: string; timestamp: string; debug: TranscribeDebug }
  | { ok: false; error: string };

/** One POST to OpenRouter; any non-2xx becomes an OpenRouterError. */
async function post<T>(what: string, url: string, apiKey: string, body: BodyInit, signal: AbortSignal, contentType?: string): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  if (contentType) headers['Content-Type'] = contentType;
  const resp = await fetch(url, { method: 'POST', headers, body, signal });
  if (!resp.ok) {
    throw new OpenRouterError(`${what} HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`, resp.status);
  }
  return (await resp.json()) as T;
}

/** Run `once` hedged (see hedge.ts), timing the whole thing. */
async function timedHedged<T>(once: (signal: AbortSignal) => Promise<T>, hedgeAfterMs: number, timeoutMs: number, cancel?: AbortSignal) {
  const started = Date.now();
  const { value, attempts } = await hedged(once, { hedgeAfterMs, timeoutMs, cancel, retryable });
  return { data: value, attempts, ms: Date.now() - started };
}

export async function transcribeMp3(
  apiKey: string,
  bytes: Uint8Array,
  timeoutMs = 20_000,
  cancel?: AbortSignal
): Promise<TranscribeResult> {
  const { data, attempts, ms } = await timedHedged(
    (signal) => {
      // Built per attempt: a request body can only be sent once.
      const form = new FormData();
      form.append('file', new Blob([bytes as BlobPart], { type: 'audio/mpeg' }), 'chunk.mp3');
      form.append('model', TRANSCRIBE_MODEL);
      return post<{ text?: string; usage?: Record<string, unknown> }>('transcription', TRANSCRIBE_ENDPOINT, apiKey, form, signal);
    },
    TRANSCRIBE_HEDGE_MS,
    timeoutMs,
    cancel
  );
  return { text: data.text ?? '', model: TRANSCRIBE_MODEL, ms, usage: data.usage, attempts };
}

export async function translateToEnglish(
  apiKey: string,
  text: string,
  timeoutMs = 15_000,
  cancel?: AbortSignal
): Promise<TranslateResult> {
  const body = JSON.stringify({
    model: TRANSLATE_MODEL,
    messages: [
      { role: 'system', content: TRANSLATE_SYSTEM_PROMPT },
      { role: 'user', content: text }
    ],
    temperature: 0,
    // Ask OpenRouter to include the call's actual cost in `usage`.
    usage: { include: true }
  });
  const { data, attempts, ms } = await timedHedged(
    (signal) =>
      post<{
        choices?: { message?: { content?: string } }[];
        provider?: string;
        usage?: Record<string, unknown>;
      }>('translation', CHAT_ENDPOINT, apiKey, body, signal, 'application/json'),
    TRANSLATE_HEDGE_MS,
    timeoutMs,
    cancel
  );
  return {
    text: data.choices?.[0]?.message?.content?.trim() ?? text,
    systemPrompt: TRANSLATE_SYSTEM_PROMPT,
    input: text,
    model: TRANSLATE_MODEL,
    provider: data.provider,
    ms,
    usage: data.usage,
    attempts
  };
}
