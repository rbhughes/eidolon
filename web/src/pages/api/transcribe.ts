import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getSecret } from 'astro:env/server';
import { transcribeMp3, translateToEnglish, OpenRouterError } from '../../lib/openrouter';
import { checkRateLimit, rateLimitedResponse } from '../../lib/rateLimit';

const MAX_CLIP_BYTES = 2_000_000; // generous cap on a client-assembled clip
// Translation normally answers in ~1s; one that hangs is going to fail
// anyway, so give up well before the user wonders whether anything happened.
const TRANSLATE_TIMEOUT_MS = 8_000;

export const POST: APIRoute = async ({ request }) => {
  // Checked first, before touching the body -- this is the endpoint that
  // actually costs money (OpenRouter calls), so the limit here is the one
  // doing the real budget protection. See wrangler.jsonc for the bucket.
  if (!(await checkRateLimit(env.RATE_LIMIT_TRANSCRIBE, request))) {
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
    let text = await transcribeMp3(apiKey, bytes);
    if (text.trim()) {
      // A failed translation must not throw away a successful
      // transcription -- the one failure the user hit (16.7s = ~1.7s
      // transcribe + the translate timeout) did exactly that. Fall back to
      // the untranslated text instead.
      try {
        text = await translateToEnglish(apiKey, text, TRANSLATE_TIMEOUT_MS);
      } catch (err) {
        console.error(`[transcribe] translate failed after ${Date.now() - started}ms, returning untranslated:`, err);
      }
    }
    return Response.json({ ok: true, text, timestamp: new Date().toISOString() });
  } catch (err) {
    const elapsed = Date.now() - started;
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
