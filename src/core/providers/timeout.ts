export const DEFAULT_MT_REQUEST_TIMEOUT_MS = 12_000;
export const DEFAULT_AI_CONNECT_TIMEOUT_MS = 45_000;
export const DEFAULT_SSE_IDLE_TIMEOUT_MS = 35_000;

export type ProviderTimeoutPhase = 'connect' | 'stream-idle';

export class ProviderTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly phase: ProviderTimeoutPhase;

  constructor(timeoutMs: number, phase: ProviderTimeoutPhase = 'connect') {
    super(
      phase === 'stream-idle'
        ? `Upstream stream stalled with no data for ${timeoutMs}ms.`
        : `Upstream request timed out after ${timeoutMs}ms.`,
    );
    this.name = 'ProviderTimeoutError';
    this.timeoutMs = timeoutMs;
    this.phase = phase;
  }
}

export interface LinkedTimeoutScope {
  readonly signal: AbortSignal;
  clearTimer: () => void;
  cleanup: () => void;
  race: <T>(promise: Promise<T>) => Promise<T>;
  rethrowMapped: (err: unknown) => never;
}

/**
 * Links an optional caller `AbortSignal` with an internal request deadline timer.
 * - Caller cancellation preserves standard `AbortError` semantics.
 * - Internal deadline expiry aborts the underlying `fetch` socket AND maps to
 *   `ProviderTimeoutError` so `engine.ts` classifies it cleanly as a fast-failing
 *   `NETWORK_ERROR` rather than an unhandled user cancellation.
 */
export function createLinkedTimeoutScope(
  timeoutMs: number,
  callerSignal?: AbortSignal,
  phase: ProviderTimeoutPhase = 'connect',
): LinkedTimeoutScope {
  const ctrl = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let rejectAbortWaiters: ((reason: unknown) => void) | null = null;

  const abortPromise = new Promise<never>((_, reject) => {
    rejectAbortWaiters = reject;
  });
  // Prevent unhandled rejection warnings when `promise` resolves before `abortPromise` rejects
  abortPromise.catch(() => undefined);

  const onCallerAbort = () => {
    const abortErr = new DOMException('The operation was aborted.', 'AbortError');
    ctrl.abort(abortErr);
    rejectAbortWaiters?.(abortErr);
  };

  if (callerSignal?.aborted) {
    onCallerAbort();
  } else if (callerSignal) {
    callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }

  if (!callerSignal?.aborted && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      const timeoutErr = new ProviderTimeoutError(timeoutMs, phase);
      ctrl.abort(timeoutErr);
      rejectAbortWaiters?.(timeoutErr);
    }, timeoutMs);
  }

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const cleanup = () => {
    clearTimer();
    if (callerSignal) {
      callerSignal.removeEventListener('abort', onCallerAbort);
    }
  };

  const rethrowMapped = (err: unknown): never => {
    if (callerSignal?.aborted) {
      if (err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError') {
        throw err;
      }
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    if (timedOut || err instanceof ProviderTimeoutError) {
      throw err instanceof ProviderTimeoutError
        ? err
        : new ProviderTimeoutError(timeoutMs, phase);
    }
    throw err;
  };

  const race = async <T>(promise: Promise<T>): Promise<T> => {
    try {
      return await Promise.race([promise, abortPromise]);
    } catch (err) {
      return rethrowMapped(err);
    }
  };

  return {
    signal: ctrl.signal,
    clearTimer,
    cleanup,
    race,
    rethrowMapped,
  };
}
