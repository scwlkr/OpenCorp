import { setTimeout as delay } from 'node:timers/promises';

export class ControlObservationTimeout extends Error {
  constructor(operation: string, cause: unknown) { super(`OpenCode ${operation} observation timed out`, { cause }); }
}

/** Only call for read-only native observations, never admission/cancellation.
 * The timer belongs to this observation; an upstream TimeoutError alone is not
 * retryable. The unchanged run signal and process check remain authoritative. */
export async function observeControl<T>(operation: string, signal: AbortSignal, check: () => void,
  read: (signal: AbortSignal) => Promise<T>, retry = false): Promise<T> {
  while (true) {
    signal.throwIfAborted(); check();
    const timeout = new AbortController();
    const reason = new DOMException('Native observation deadline', 'TimeoutError');
    const timer = setTimeout(() => timeout.abort(reason), 10000);
    try {
      const result = await read(AbortSignal.any([signal, timeout.signal]));
      signal.throwIfAborted(); check();
      if (timeout.signal.aborted) throw reason;
      return result;
    } catch (error) {
      signal.throwIfAborted(); check();
      if (!timeout.signal.aborted || error !== reason) {
        throw new Error(`OpenCode ${operation} observation failed (${error instanceof Error ? error.name : 'unknown error'})`, { cause: error });
      }
      if (!retry) throw new ControlObservationTimeout(operation, error);
    } finally { clearTimeout(timer); }
    await delay(750, undefined, { signal });
  }
}
