import { describe, expect, it, vi } from 'vitest';
import type { OpencodeClient, SessionMessagesResponse2 } from '@opencode-ai/sdk/v2';
import { completeSession } from '../src/runtime/session.js';
import { assertFinalResponseCheckpoint, type FinalResponseRequest } from '../src/runtime/final-response.js';
import type { NativeStepLimit } from '../src/runtime/types.js';

type Reply = SessionMessagesResponse2[number];
const reply = (id: string, finish: string): Reply => ({ info: { id, role: 'assistant', finish, time: { completed: 123 } },
  parts: finish === 'length' ? [{ type: 'reasoning', text: 'retained reasoning' }] : [{ type: 'text', text: 'actual result' }] }) as Reply;
const prompt = { sessionID: 'same-session', agent: 'employee', parts: [{ type: 'text' as const, text: 'original assignment' }] };

function fixture(finishes: string[]) {
  const history: Reply[] = [];
  let pending: Reply | undefined, stalePoll = false;
  const budget = { requests: 0, steps: 0 }, snapshots: Array<{ id: string; continuations: number }> = [];
  const session = {
    messages: vi.fn(async () => ({ data: [...history] })),
    promptAsync: vi.fn(async () => {
      budget.requests++; budget.steps++;
      pending = reply(`reply-${budget.steps}`, finishes[budget.steps - 1] ?? 'stop'); stalePoll = true;
      return { response: { status: 204 } };
    }),
    status: vi.fn(async () => {
      // First idle observation still returns the PREVIOUS completed reply.
      // A correct continuation must wait for its own admitted assistant.
      if (stalePoll) stalePoll = false;
      else if (pending) { history.push(pending); pending = undefined; }
      return { data: {}, response: { ok: true } };
    }),
  };
  const options = { client: { session } as unknown as Pick<OpencodeClient, 'session'>, prompt,
    signal: new AbortController().signal, budget: () => budget, intervalMs: 1,
    onReply: async (value: Reply, continuations: number) => { snapshots.push({ id: value.info.id, continuations }); } };
  return { session, options, budget, snapshots };
}

describe('bounded same-session output continuation', () => {
  it('retains completed evidence and ignores the stale length reply during async admission', async () => {
    const f = fixture(['length', 'stop']);
    const result = await completeSession(f.options);
    expect(result.info.id).toBe('reply-2');
    expect(f.snapshots).toEqual([{ id: 'reply-1', continuations: 0 }, { id: 'reply-2', continuations: 1 }]);
    expect(f.session.promptAsync).toHaveBeenCalledTimes(2);
    for (const call of f.session.promptAsync.mock.calls as unknown as Array<[typeof prompt]>) {
      expect(call[0].sessionID).toBe('same-session'); expect(call[0]).not.toHaveProperty('system');
    }
    expect(f.budget).toEqual({ requests: 2, steps: 2 });
  });

  it.each(['stop', 'length'])('preserves a %s native-limit checkpoint without resetting its agent budget', async finish => {
    const f = fixture([finish]);
    let nativeStepLimit: NativeStepLimit | undefined;
    const onReply = f.options.onReply;
    const result = await completeSession({ ...f.options,
      budget: () => ({ ...f.budget, nativeStepLimit }),
      onReply: async (value, count) => { await onReply(value, count); nativeStepLimit = { limit: 32, request: 32, toolEnabledSteps: 27 }; },
    });
    expect(result.info.id).toBe('reply-1');
    expect(f.snapshots).toEqual([{ id: 'reply-1', continuations: 0 }]);
    expect(f.session.promptAsync).toHaveBeenCalledTimes(1);
  });

  it('keeps a checkpoint final response tool-free through the existing two bounded length continuations', async () => {
    const f = fixture(['length', 'length', 'stop']);
    const finalResponse = { active: true, tools: { read: false, corporate_vote_decision: false, '*': false } } as unknown as FinalResponseRequest;
    const result = await completeSession({ ...f.options, finalResponse });
    expect(result.info.id).toBe('reply-3'); expect(f.budget.requests).toBe(3);
    for (const [input] of f.session.promptAsync.mock.calls as unknown as Array<[any]>) expect(input.tools).toEqual(finalResponse.tools);
    for (const [input] of f.session.promptAsync.mock.calls.slice(1) as unknown as Array<[any]>) {
      expect(input.parts[0].text).toContain('Do not resolve the original blocked work');
      expect(input.parts[0].text).not.toContain('Execute the remaining necessary tools');
    }
    expect(f.snapshots.map(item => item.continuations)).toEqual([0, 1, 2]);
  });

  it('retains a length reply but does not dispatch its continuation after the checkpoint is superseded', async () => {
    const f = fixture(['length', 'stop']), retain = f.options.onReply;
    await expect(completeSession({ ...f.options, onReply: async (reply, count) => {
      await retain(reply, count); assertFinalResponseCheckpoint(() => false);
    } })).rejects.toMatchObject({ code: 'checkpoint_superseded' });
    expect(f.snapshots).toEqual([{ id: 'reply-1', continuations: 0 }]);
    expect(f.session.promptAsync).toHaveBeenCalledOnce(); expect(f.budget.requests).toBe(1);
  });

  it('rechecks after asynchronous continuation preflight before admitting any new final-response user', async () => {
    const f = fixture(['length']), retain = f.options.onReply; let current = true;
    await expect(completeSession({ ...f.options, onReply: async (reply, count) => {
      await retain(reply, count); assertFinalResponseCheckpoint(() => current);
      f.session.messages.mockImplementation(async () => { current = false; return { data: [reply] }; });
    }, onContinue: () => assertFinalResponseCheckpoint(() => current) })).rejects.toMatchObject({ code: 'checkpoint_superseded' });
    expect(f.session.promptAsync).toHaveBeenCalledOnce(); expect(f.snapshots).toHaveLength(1);
  });

  it('checkpoints every exhausted reply then stops after exactly two continuations', async () => {
    const f = fixture(['length', 'length', 'length']);
    await expect(completeSession(f.options)).rejects.toMatchObject({ name: 'RuntimeExecutionError', code: 'output_limit_exhausted', message: expect.stringContaining('finish=length') });
    expect(f.session.promptAsync).toHaveBeenCalledTimes(3);
    expect(f.snapshots.map(item => item.continuations)).toEqual([0, 1, 2]);
  });

  it.each(['requests', 'steps'] as const)('does not reset the existing %s budget for a continuation', async dimension => {
    const f = fixture(['length']);
    f.options.onReply = async () => { f.budget[dimension] = dimension === 'requests' ? 36 : 32; };
    await expect(completeSession(f.options)).rejects.toMatchObject({ code: dimension === 'requests' ? 'run_budget_exhausted' : 'step_budget_exhausted' });
    expect(f.session.promptAsync).toHaveBeenCalledTimes(1);
  });

  it('keeps the original cancellation signal across continuation admission', async () => {
    const f = fixture(['length']), controller = new AbortController();
    f.options.signal = controller.signal;
    f.options.onReply = async () => { controller.abort(new Error('original run deadline')); };
    await expect(completeSession(f.options)).rejects.toThrow('original run deadline');
    expect(f.session.promptAsync).toHaveBeenCalledTimes(1);
  });

  it('rejects changed conversation state before dispatching a duplicate continuation', async () => {
    const f = fixture(['length']);
    f.options.onReply = async () => { f.session.messages.mockResolvedValue({ data: [reply('unexpected-message', 'stop')] }); };
    await expect(completeSession(f.options)).rejects.toThrow('conversation changed');
    expect(f.session.promptAsync).toHaveBeenCalledTimes(1);
  });

  it('cancels an already admitted continuation through the original run signal', async () => {
    const f = fixture(['length']), controller = new AbortController();
    f.options.signal = controller.signal;
    await expect(completeSession({ ...f.options, onContinue: () => {
      f.session.status.mockImplementation(async () => ({ data: { 'same-session': { type: 'busy' } }, response: { ok: true } }));
      setTimeout(() => controller.abort(new Error('original deadline during continuation')), 5);
    } })).rejects.toThrow('original deadline during continuation');
    expect(f.session.promptAsync).toHaveBeenCalledTimes(2);
  });
});
