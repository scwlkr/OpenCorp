import { afterEach, expect, it, vi } from 'vitest';
import type { OpencodeClient } from '@opencode-ai/sdk/v2';
import { completeSession } from '../src/runtime/session.js';
import { observeControl } from '../src/runtime/control-observation.js';
afterEach(() => vi.useRealTimers());
const ok = <T>(data: T) => ({ response: { ok: true }, data });
function hang(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
}
it.each(['status', 'messages'])('reobserves %s after its own timeout without a second prompt or premature terminal', async operation => {
  vi.useFakeTimers();
  const controller = new AbortController(); let admitted = false;
  const terminal = { info: { id: 'answer', role: 'assistant', finish: 'stop', time: { completed: 1 } }, parts: [] };
  let timedOut = false, retriedBusy = false;
  const session = {
    promptAsync: vi.fn(async () => { admitted = true; return ok(undefined); }),
    status: vi.fn(async (_args: unknown, options: { signal: AbortSignal }) => {
      if (operation === 'status' && !timedOut) { timedOut = true; return hang(options.signal); }
      if (timedOut && !retriedBusy) { retriedBusy = true; return ok({ bound: { type: 'busy' } }); }
      return ok({ bound: { type: 'idle' } });
    }),
    messages: vi.fn(async (_args: unknown, options: { signal: AbortSignal }) => {
      if (!admitted) return ok([]);
      if (operation === 'messages' && !timedOut) { timedOut = true; return hang(options.signal); }
      return ok([terminal]);
    }),
  };
  const onReply = vi.fn(async () => {});
  const result = completeSession({ client: { session } as unknown as Pick<OpencodeClient, 'session'>,
    prompt: { sessionID: 'bound', parts: [] }, signal: controller.signal, intervalMs: 1,
    budget: () => ({ requests: 1, steps: 1 }), onReply });
  await vi.advanceTimersByTimeAsync(9999); expect(onReply).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10);
  expect(await result).toEqual(terminal); expect(retriedBusy).toBe(true);
  expect(session.promptAsync).toHaveBeenCalledOnce(); expect(onReply).toHaveBeenCalledOnce();
});
it.each(['outer-abort', 'dead-native', 'unowned-timeout', 'auth'])('does not retry %s', async kind => {
  vi.useFakeTimers(); const controller = new AbortController(); let dead = false;
  const read = vi.fn(async (signal: AbortSignal) => {
    if (kind === 'outer-abort') { controller.abort(new Error('Outer deadline')); return hang(signal); }
    if (kind === 'unowned-timeout') throw new DOMException('Other timer', 'TimeoutError');
    if (kind === 'auth') throw new Error('Unauthorized');
    dead = true; return hang(signal);
  });
  // Already-aborted signals reject immediately like fetch.
  if (kind === 'outer-abort') read.mockImplementation(async () => { controller.abort(new Error('Outer deadline')); throw controller.signal.reason; });
  const result = observeControl('fixture.messages', controller.signal, () => { if (dead) throw new Error('Native exited'); }, read, true);
  const asserted = expect(result).rejects.toThrow(kind === 'outer-abort' ? 'Outer deadline' : kind === 'dead-native' ? 'Native exited' : 'fixture.messages observation failed');
  await vi.advanceTimersByTimeAsync(10001); await asserted; expect(read).toHaveBeenCalledOnce();
});
it('labels unowned timeout without leaking request/error contents', async () => {
  await expect(observeControl('session.status', new AbortController().signal, () => {}, async () => {
    throw new DOMException('SECRET request details', 'TimeoutError');
  }, true)).rejects.toThrow('OpenCode session.status observation failed (TimeoutError)');
});
it('retries completion evidence reads only while outer checks remain valid', async () => {
  vi.useFakeTimers(); const controller = new AbortController();
  const check = vi.fn(); const read = vi.fn(async (_signal: AbortSignal) => 'retained messages');
  read.mockImplementationOnce(signal => hang(signal));
  const result = observeControl('completion.session.messages', controller.signal, check, read, true);
  await vi.advanceTimersByTimeAsync(10751);
  expect(await result).toBe('retained messages'); expect(read).toHaveBeenCalledTimes(2); expect(check.mock.calls.length).toBeGreaterThan(2);
});
it('rejects invalid status responses without polling again', async () => {
  const session = { messages: vi.fn(async () => ok([])), promptAsync: vi.fn(async () => ok(undefined)),
    status: vi.fn(async () => ({ response: { ok: false }, data: undefined })) };
  await expect(completeSession({ client: { session } as unknown as Pick<OpencodeClient, 'session'>,
    prompt: { sessionID: 'bound', parts: [] }, signal: new AbortController().signal,
    budget: () => ({ requests: 1, steps: 1 }), onReply: async () => {} })).rejects.toThrow('session status unavailable');
  expect(session.status).toHaveBeenCalledOnce(); expect(session.promptAsync).toHaveBeenCalledOnce();
});
