import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpencodeClient } from '@opencode-ai/sdk/v2';
import { FinalResponseRequest, finalResponseInstruction } from '../src/runtime/final-response.js';
import { awaitSessionReply } from '../src/runtime/session.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'opencorp-final-response-')); roots.push(root);
  const path = join(root, 'final-response.json'), controller = new AbortController();
  const messages: any[] = [{ info: { id: 'tool-batch', role: 'assistant' }, parts: [
    { type: 'tool', state: { status: 'completed' } }, { type: 'tool', state: { status: 'completed' } },
  ] }];
  const session = { status: vi.fn(async () => ({ data: { session: { type: 'busy' } }, response: { ok: true } })),
    messages: vi.fn(async () => ({ data: messages })),
    prompt: vi.fn(async (input: any) => {
      const intent = JSON.parse(await readFile(path, 'utf8')); expect(intent.state).toBe('prepared');
      const message = { info: { id: 'final-user', role: 'user', tools: input.tools }, parts: input.parts };
      messages.push(message); return { data: message, response: { ok: true } };
    }),
  };
  const checkpoint = vi.fn(() => true), onReceipt = vi.fn();
  const request = new FinalResponseRequest({ client: { session } as unknown as OpencodeClient, sessionId: 'session',
    modelId: 'owned-model', signal: controller.signal, path, checkpoint, onReceipt });
  const admit = () => request.atInference(['read', 'corporate_vote_decision', 'bash'], controller.signal);
  return { root, path, controller, session, messages, request, checkpoint, onReceipt, admit };
}

describe('one supported final-response user request at a settled native inference boundary', () => {
  it('serializes concurrent boundary callbacks into one consistent observed native request', async () => {
    const f = await fixture(); let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    f.session.messages.mockImplementation(async () => { await ready; return { data: f.messages }; });
    const first = f.admit(), second = f.admit(); release();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(f.session.prompt).toHaveBeenCalledOnce(); expect(f.session.messages).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(f.path, 'utf8'))).toMatchObject({ state: 'observed', messageId: 'final-user' });
    expect(f.request.error).toBeUndefined();
  });
  it('persists an intent before the real noReply request, disables the exact catalog, and never starts another loop', async () => {
    const f = await fixture(); expect(await f.admit()).toBe(true); expect(await f.admit()).toBe(true);
    expect(f.session.prompt).toHaveBeenCalledOnce();
    expect(f.session.prompt.mock.calls[0][0]).toEqual({ sessionID: 'session', agent: 'employee', model: { providerID: 'opencorp-local', modelID: 'owned-model' }, noReply: true,
      tools: { read: false, corporate_vote_decision: false, bash: false, '*': false }, parts: [{ type: 'text', text: finalResponseInstruction }] });
    expect(JSON.parse(await readFile(f.path, 'utf8'))).toMatchObject({ state: 'observed', messageId: 'final-user', previousMessageId: 'tool-batch', disabledToolCount: 3 });
    expect(f.messages).toHaveLength(2); expect(f.messages[0].parts).toHaveLength(2); expect(f.request.error).toBeUndefined();
  });
  it.each(['pending', 'running'])('settles every parallel native tool before appending a request (%s)', async status => {
    const f = await fixture(); f.messages[0].parts[1].state.status = status;
    expect(await f.admit()).toBe(false); expect(f.session.prompt).not.toHaveBeenCalled(); expect(f.request.receipt).toBeUndefined();
    f.messages[0].parts[1].state.status = 'completed'; expect(await f.admit()).toBe(true);
  });
  it('does nothing after the native loop already becomes idle', async () => {
    const f = await fixture(); f.session.status.mockResolvedValue({ data: { session: { type: 'idle' } }, response: { ok: true } });
    expect(await f.admit()).toBe(false); expect(f.session.prompt).not.toHaveBeenCalled();
  });
  it('requires the actual checkpoint again after asynchronous tool-state reads', async () => {
    const f = await fixture(); f.session.messages.mockImplementation(async () => { f.checkpoint.mockReturnValue(false); return { data: f.messages }; });
    expect(await f.admit()).toBe(false); expect(f.session.prompt).not.toHaveBeenCalled();
  });
  it('revalidates after durable intent write and does not send when that checkpoint changed', async () => {
    const f = await fixture(); f.checkpoint.mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false);
    expect(await f.admit()).toBe(false); expect(f.request.receipt?.state).toBe('withdrawn'); expect(f.session.prompt).not.toHaveBeenCalled();
    f.checkpoint.mockReturnValue(true); expect(await f.admit()).toBe(false); expect(f.session.prompt).not.toHaveBeenCalled();
  });
  it.each(['response lost', 'bad receipt'])('never replays an uncertain admission (%s)', async fault => {
    const f = await fixture(); f.session.prompt.mockImplementation(async () => {
      if (fault === 'response lost') throw new Error('response lost');
      return { data: { info: { id: 'wrong', role: 'assistant', tools: {} }, parts: [] }, response: { ok: true } };
    });
    await expect(f.admit()).rejects.toThrow(); await expect(f.admit()).rejects.toThrow();
    expect(f.session.prompt).toHaveBeenCalledOnce(); expect(JSON.parse(await readFile(f.path, 'utf8')).state).toBe('uncertain');
  });
  it('preserves an earlier durable intent and cannot replay it from a new helper', async () => {
    const f = await fixture(); const retained = '{"state":"uncertain","retained":"earlier admission"}'; await writeFile(f.path, retained);
    await expect(f.admit()).rejects.toThrow(); expect(f.session.prompt).not.toHaveBeenCalled(); expect(await readFile(f.path, 'utf8')).toBe(retained);
  });
  it('honors cancellation before admission and while the short native control response is pending', async () => {
    const f = await fixture(); f.controller.abort(new Error('original deadline')); await expect(f.admit()).rejects.toThrow('original deadline'); expect(f.session.prompt).not.toHaveBeenCalled();
    const g = await fixture(); g.session.prompt.mockImplementation(async (_input: any, options?: any) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); g.controller.abort(new Error('paused'));
    }));
    await expect(g.admit()).rejects.toThrow('paused'); expect(g.session.prompt).toHaveBeenCalledOnce(); expect(g.request.receipt?.state).toBe('uncertain');
  });
  it('does not continue final-only inference after authority or its checkpoint changes', async () => {
    const f = await fixture(); await f.admit(); f.checkpoint.mockReturnValue(false);
    await expect(f.admit()).rejects.toThrow('checkpoint changed'); expect(f.session.prompt).toHaveBeenCalledOnce();
  });
  it('does not treat an old-parent response as the new real final answer, even during stale idle observations', async () => {
    const f = await fixture(); await f.admit();
    const history = [{ info: { id: 'original-user', role: 'user' }, parts: [] }, f.messages[1],
      { info: { id: 'old-response', role: 'assistant', parentID: 'original-user', time: { completed: 1 } }, parts: [] }];
    f.session.messages.mockResolvedValue({ data: history }); let polls = 0;
    f.session.status.mockImplementation(async () => {
      if (++polls === 3) history.push({ info: { id: 'actual-final', role: 'assistant', parentID: 'final-user', time: { completed: 2 } }, parts: [] });
      return { data: { session: { type: 'idle' } }, response: { ok: true } };
    });
    const result = await awaitSessionReply({ session: f.session } as unknown as OpencodeClient, 'session', f.controller.signal, undefined, 1, undefined, f.request);
    expect(result.info.id).toBe('actual-final'); expect(polls).toBe(3);
  });
});
