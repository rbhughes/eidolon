// Hedged requests: if an attempt hasn't answered after `hedgeAfterMs`,
// start an identical second one and take whichever succeeds first.
//
// Why: measured OpenRouter latency is tight -- 20/20 transcriptions in
// 1.0-2.2s, 20/20 translations in 0.8-2.0s -- yet every failure seen in
// testing was an attempt that simply hung until our timeout (20s
// transcribe, 8-15s translate). A stuck request doesn't get faster by
// waiting on it; a fresh one usually comes back in ~1s. The backup only
// fires on the rare slow attempt, so the extra cost is at most one more
// call (~$0.0015) on those, never on the normal path.
//
// A retryable failure (network error, 408/429/5xx) also starts a
// replacement immediately, without waiting for the hedge delay.

export interface HedgeOptions {
  /** Start a backup attempt if nothing has succeeded by then. */
  hedgeAfterMs: number;
  /** Give up entirely after this long. */
  timeoutMs: number;
  /** Total attempts allowed, backups and retries included. */
  maxAttempts?: number;
  /** Fires when the caller no longer wants the result (visitor pressed stop). */
  cancel?: AbortSignal;
  /** Whether a failed attempt is worth a replacement. */
  retryable?: (err: unknown) => boolean;
}

export interface HedgeResult<T> {
  value: T;
  /** Attempts started (1 = the first one answered on its own). */
  attempts: number;
  /** Which attempt's answer was used, 1-based. */
  winner: number;
}

export class HedgeTimeoutError extends Error {
  readonly name = 'AbortError';
}

export function hedged<T>(attempt: (signal: AbortSignal) => Promise<T>, opts: HedgeOptions): Promise<HedgeResult<T>> {
  const maxAttempts = opts.maxAttempts ?? 2;
  const retryable = opts.retryable ?? (() => true);

  return new Promise((resolve, reject) => {
    const controllers: AbortController[] = [];
    let running = 0;
    let settled = false;
    let hedgeTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(hedgeTimer);
      clearTimeout(overallTimer);
      opts.cancel?.removeEventListener('abort', onCancel);
      for (const c of controllers) c.abort(); // losers and stragglers
      fn();
    };

    const start = () => {
      if (settled || controllers.length >= maxAttempts) return;
      const controller = new AbortController();
      controllers.push(controller);
      const n = controllers.length;
      running++;
      attempt(controller.signal).then(
        (value) => finish(() => resolve({ value, attempts: controllers.length, winner: n })),
        (err) => {
          running--;
          if (settled) return;
          if (retryable(err) && controllers.length < maxAttempts) {
            clearTimeout(hedgeTimer); // the replacement starts now
            start();
          } else if (running === 0) {
            finish(() => reject(err));
          }
        }
      );
    };

    const onCancel = () => finish(() => reject(new HedgeTimeoutError('cancelled')));
    const overallTimer = setTimeout(
      () => finish(() => reject(new HedgeTimeoutError(`no answer within ${opts.timeoutMs}ms`))),
      opts.timeoutMs
    );
    if (opts.cancel?.aborted) return onCancel();
    opts.cancel?.addEventListener('abort', onCancel, { once: true });

    start();
    hedgeTimer = setTimeout(start, opts.hedgeAfterMs);
  });
}
