import { describe, expect, it, vi } from 'vitest';
import type { AssistantMessage, ContextOverflowError, OpencodeClient, SessionMessagesResponse2 } from '@opencode-ai/sdk/v2';
import { completeSession } from '../src/runtime/session.js';

type Reply = SessionMessagesResponse2[number];
const overflow: ContextOverflowError = { name: 'ContextOverflowError', data: { message: 'maximum context length exceeded (32768 tokens)' } };
const user = { info: { id: 'native-continuation-user', role: 'user' }, parts: [] } as unknown as Reply;
const assistant: AssistantMessage = { id: 'recovered-answer', sessionID: 'bound', parentID: user.info.id, role: 'assistant', finish: 'stop',
  time: { created: 3, completed: 4 }, agent: 'employee', mode: 'primary', modelID: 'local-fixture', providerID: 'opencorp-local',
  path: { cwd: '/fixture', root: '/fixture' }, cost: 0, tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } };
const answer: Reply = { info: assistant, parts: [{ id: 'answer-text', messageID: assistant.id, sessionID: 'bound',
  type: 'text', text: 'Actual answer after native compaction.' }] };

function fixture() {
  const controller = new AbortController(), history: Reply[] = [], retained: Reply[] = [];
  const sessionError: { error?: unknown } = {};
  let polls = 0;
  const session = {
    messages: vi.fn(async () => ({ data: [...history] })),
    promptAsync: vi.fn(async () => { history.push(user); sessionError.error = overflow; return { response: { status: 204 } }; }),
    status: vi.fn(async () => {
      polls++;
      if (polls < 4) return { data: { bound: { type: polls === 2 ? 'retry' : 'busy' } }, response: { ok: true } };
      if (polls === 4) history.push(answer);
      return { data: { bound: { type: 'idle' } }, response: { ok: true } };
    }),
  };
  const options = { client: { session } as unknown as Pick<OpencodeClient, 'session'>,
    prompt: { sessionID: 'bound', agent: 'employee', parts: [{ type: 'text' as const, text: 'Original work.' }] },
    signal: controller.signal, intervalMs: 1, sessionError,
    budget: () => ({ requests: 9, steps: 7 }), onReply: async (reply: Reply) => { retained.push(reply); } };
  return { options, session, history, retained, controller, sessionError };
}

describe('pinned native context overflow recovery', () => {
  it('lets the busy native overflow-compaction loop produce its genuine reply without another prompt', async () => {
    // OpenCode 1.18.30 processor.ts emits ContextOverflowError before returning
    // compact; prompt.ts then runs compaction in the SAME busy session loop.
    const f = fixture();
    expect(await completeSession(f.options)).toEqual(answer);
    expect(f.session.status).toHaveBeenCalledTimes(5);
    expect(f.session.promptAsync).toHaveBeenCalledOnce();
    expect(f.retained).toEqual([answer]);
    expect(f.options.budget()).toEqual({ requests: 9, steps: 7 });
    expect(f.sessionError.error).toBeUndefined();
  });

  it('retains a truly terminal idle compaction error for normal runtime failure reporting', async () => {
    const f = fixture();
    const terminal: Reply = { info: { ...assistant, id: 'failed-compaction', agent: 'compaction', summary: true,
      finish: 'error', error: { ...overflow, data: { message: 'Conversation history too large to compact - exceeds model context limit' } },
      time: { created: 4, completed: 5 } }, parts: [] };
    f.session.status.mockImplementation(async () => {
      f.history.push(terminal); return { data: { bound: { type: 'idle' } }, response: { ok: true } };
    });
    const result = await completeSession(f.options);
    // LocalRuntime retains onReply then rejects result.info.error. This is
    // the real upstream terminal error, not a synthesized successful finish.
    expect(result.info).toMatchObject({ finish: 'error', error: terminal.info.role === 'assistant' ? terminal.info.error : undefined });
    expect(f.retained).toEqual([terminal]); expect(f.session.promptAsync).toHaveBeenCalledOnce();
  });

  it.each(['empty', 'incomplete', 'completed-without-finish', 'stale', 'tool-calls', 'unknown', 'old-parent', 'summary', 'tool-with-stop'])('fails an unresolved idle overflow with %s history', async kind => {
    const f = fixture();
    if (kind === 'stale') f.history.push(answer);
    f.session.status.mockImplementation(async () => {
      if (kind === 'incomplete' || kind === 'completed-without-finish') f.history.push({ info: { id: 'overflow-assistant', role: 'assistant',
        time: kind === 'incomplete' ? {} : { completed: 5 } }, parts: [] } as unknown as Reply);
      if (['tool-calls', 'unknown', 'old-parent', 'summary', 'tool-with-stop'].includes(kind)) f.history.push({
        info: { ...answer.info, ...(kind === 'old-parent' ? { parentID: 'previous-user' } : {}),
          ...(kind === 'tool-calls' || kind === 'unknown' ? { finish: kind } : {}), ...(kind === 'summary' ? { summary: true } : {}) },
        parts: kind === 'tool-with-stop' ? [{ type: 'tool', state: { status: 'completed' } }] : [],
      } as Reply);
      return { data: { bound: { type: 'idle' } }, response: { ok: true } };
    });
    await expect(completeSession(f.options)).rejects.toThrow('ContextOverflowError');
    expect(f.retained).toEqual([]); expect(f.session.promptAsync).toHaveBeenCalledOnce();
  });

  it.each([
    { name: 'APIError', data: { message: 'ContextOverflowError mentioned in provider prose' } },
    { name: 'ContextOverflowError' },
    { name: 'ContextOverflowError', data: { message: null } },
  ])('does not defer another or malformed session error: %j', async error => {
    const f = fixture();
    f.session.promptAsync.mockImplementation(async () => { f.sessionError.error = error; return { response: { status: 204 } }; });
    await expect(completeSession(f.options)).rejects.toThrow('OpenCode session error');
    expect(f.session.status).not.toHaveBeenCalled(); expect(f.retained).toEqual([]);
  });

  it.each(['cancel', 'hard deadline', 'request budget', 'authority superseded'])('preserves %s during busy native recovery', async cause => {
    const f = fixture(), failure = new Error(cause);
    let observed = false;
    f.session.status.mockImplementation(async () => {
      observed = true;
      if (cause === 'cancel' || cause === 'hard deadline') f.controller.abort(failure);
      return { data: { bound: { type: 'busy' } }, response: { ok: true } };
    });
    await expect(completeSession({ ...f.options, check: () => {
      if (observed && (cause === 'request budget' || cause === 'authority superseded')) throw failure;
    } })).rejects.toThrow(cause);
    expect(f.retained).toEqual([]); expect(f.session.promptAsync).toHaveBeenCalledOnce();
  });

  it('does not reuse a resolved overflow event during the existing output-length continuation', async () => {
    const f = fixture(); let polls = 0;
    const length = { ...answer, info: { ...answer.info, id: 'length-after-compaction', finish: 'length' } } as Reply;
    f.session.status.mockImplementation(async () => {
      polls++;
      if (polls === 1) f.history.push(length);
      if (polls === 4) f.history.push(answer);
      // Poll2 confirms idle; poll3 sees the old reply during async admission.
      return { data: { bound: { type: 'idle' } }, response: { ok: true } };
    });
    f.session.promptAsync.mockImplementation(async () => {
      if (f.session.promptAsync.mock.calls.length === 1) { f.history.push(user); f.sessionError.error = overflow; }
      return { response: { status: 204 } };
    });
    expect(await completeSession(f.options)).toEqual(answer);
    expect(f.retained).toEqual([length, answer]); expect(f.session.promptAsync).toHaveBeenCalledTimes(2);
    expect(f.options.budget()).toEqual({ requests: 9, steps: 7 });
  });

  it.each(['status', 'messages'])('does not lose a new ordinary error arriving during the %s read', async boundary => {
    const f = fixture(), error = { name: 'APIError', data: { message: 'later ordinary provider failure' } };
    if (boundary === 'status') f.session.status.mockImplementation(async () => {
      f.sessionError.error = error; return { data: { bound: { type: 'idle' } }, response: { ok: true } };
    });
    else {
      f.session.status.mockResolvedValue({ data: { bound: { type: 'idle' } }, response: { ok: true } });
      f.session.messages.mockImplementation(async () => {
        if (f.session.promptAsync.mock.calls.length) f.sessionError.error = error;
        return { data: [user, answer] };
      });
    }
    await expect(completeSession(f.options)).rejects.toThrow('later ordinary provider failure');
    expect(f.retained).toEqual([]); expect(f.sessionError.error).toEqual(error);
  });

  it('reobserves native recovery that starts after an earlier idle status', async () => {
    const f = fixture(); let polls = 0;
    f.session.promptAsync.mockImplementation(async () => ({ response: { status: 204 } }));
    f.session.messages.mockImplementation(async () => {
      if (f.session.promptAsync.mock.calls.length) f.sessionError.error = overflow;
      return { data: polls >= 3 ? [user, answer] : [user] };
    });
    f.session.status.mockImplementation(async () => {
      polls++; return { data: { bound: { type: polls === 2 ? 'busy' : 'idle' } }, response: { ok: true } };
    });
    expect(await completeSession(f.options)).toEqual(answer);
    expect(polls).toBe(4); expect(f.retained).toEqual([answer]);
    expect(f.session.promptAsync).toHaveBeenCalledOnce();
  });

  it('preserves the original cancellation reason while waiting for reobserved recovery', async () => {
    const f = fixture(); let polls = 0;
    f.session.status.mockImplementation(async () => {
      polls++;
      if (polls === 2) setTimeout(() => f.controller.abort(new Error('original deadline during native recovery')), 1);
      return { data: { bound: { type: polls === 1 ? 'idle' : 'busy' } }, response: { ok: true } };
    });
    await expect(completeSession({ ...f.options, intervalMs: 20 })).rejects.toThrow('original deadline during native recovery');
    expect(f.retained).toEqual([]); expect(f.session.promptAsync).toHaveBeenCalledOnce();
  });
});
