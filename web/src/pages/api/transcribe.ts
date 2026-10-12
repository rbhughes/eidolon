import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getSecret } from 'astro:env/server';
import { transcribeMp3, translateToEnglish, OpenRouterError, type TranslateResult } from '../../lib/openrouter';
import { checkRateLimit, rateLimitedResponse } from '../../lib/rateLimit';

const MAX_CLIP_BYTES = 2_000_000; // generous cap on a client-assembled clip
// Translation normally answers in ~1s; one that hangs is going to fail
// anyway, so give up well before the user wonders whether anything happened.
const TRANSLATE_TIMEOUT_MS = 8_000;

export const POST: APIRoute = async ({ request }) => {
  // Checked first, before touching the body -- this is the endpoint that
  // actually costs money (OpenRouter calls). The hard spending cap is the
  // OpenRouter key's credit limit; this per-client limit stops one client
  // from burning through it. See lib/rateLimiter.ts.
  if (!(await checkRateLimit('transcribe', request))) {
    return rateLimitedResponse({ ok: false, error: 'rate limited, slow down' });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ ok: false, error: 'expected multipart/form-data' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof Blob)) {
    return Response.json({ ok: false, error: 'missing file' }, { status: 400 });
  }
  if (file.size === 0) {
    return Response.json({ ok: false, error: 'empty clip' }, { status: 400 });
  }
  if (file.size > MAX_CLIP_BYTES) {
    return Response.json({ ok: false, error: 'clip too large' }, { status: 413 });
  }

  const apiKey = getSecret('OPENROUTER_API_KEY');
  if (!apiKey) {
    return Response.json({ ok: false, error: 'server misconfigured: no API key' }, { status: 500 });
  }

  // Logged with timing so a failure says what happened -- a
  // non-OpenRouterError (timeout abort, network error) used to collapse
  // into a bare "transcription failed" with nothing in the server log.
  const started = Date.now();
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    // request.signal fires if the visitor presses stop mid-request, so the
    // OpenRouter calls are abandoned rather than run to completion.
    const transcription = await transcribeMp3(apiKey, bytes, undefined, request.signal);
    let text = transcription.text;
    let translation: TranslateResult | { error: string } | null = null;
    if (text.trim()) {
      // A failed translation must not throw away a successful
      // transcription -- the one failure the user hit (16.7s = ~1.7s
      // transcribe + the translate timeout) did exactly that. Fall back to
      // the untranslated text instead.
      try {
        translation = await translateToEnglish(apiKey, text, TRANSLATE_TIMEOUT_MS, request.signal);
        text = translation.text;
      } catch (err) {
        if (request.signal.aborted) throw err; // stopped by the visitor, not a translation failure
        console.error(`[transcribe] translate failed after ${Date.now() - started}ms, returning untranslated:`, err);
        translation = { error: err instanceof Error ? err.message : String(err) };
      }
    }
    // Everything the page's debug log shows about the model calls: which
    // models, how long, the exact usage/cost OpenRouter reported, and the
    // full translation prompt. Nothing secret -- the point of the log is
    // to show all of it.
    const debug = {
      clipBytes: file.size,
      transcription: {
        model: transcription.model,
        ms: transcription.ms,
        attempts: transcription.attempts,
        usage: transcription.usage,
        rawText: transcription.text
      },
      translation
    };
    return Response.json({ ok: true, text, timestamp: new Date().toISOString(), debug });
  } catch (err) {
    const elapsed = Date.now() - started;
    if (request.signal.aborted) {
      console.log(`[transcribe] cancelled by the client after ${elapsed}ms`);
      return Response.json({ ok: false, error: 'cancelled' }, { status: 499 });
    }
    console.error(`[transcribe] transcription failed after ${elapsed}ms (${file.size}B clip):`, err);
    const reason =
      err instanceof OpenRouterError
        ? err.message
        : err instanceof Error && err.name === 'AbortError'
          ? 'transcription timed out'
          : 'transcription failed';
    return Response.json({ ok: false, error: reason }, { status: 502 });
  }
};
