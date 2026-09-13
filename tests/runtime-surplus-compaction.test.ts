import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { OpencodeClient, SessionMessagesResponse2 } from '@opencode-ai/sdk/v2';
import { awaitSessionReply } from '../src/runtime/session.js';
import { SurplusCompaction, surplusCompactionCandidate, nativeRequestID } from '../src/runtime/surplus-compaction.js';
type Reply = SessionMessagesResponse2[number];
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function history(): Reply[] {
  return [
    { info: { id: 'request', role: 'user' }, parts: [] },
    { info: { id: 'terminal', role: 'assistant', agent: 'employee', parentID: 'request', finish: 'stop', time: { completed: 2 } }, parts: [{ type: 'text', text: 'Retained work.' }] },
    { info: { id: 'compact', role: 'user' }, parts: [{ type: 'compaction', auto: true, overflow: false }] },
    { info: { id: 'summary', role: 'assistant', agent: 'compaction', summary: true, parentID: 'compact', time: {} }, parts: [] },
  ] as Reply[];
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'opencorp-surplus-')); roots.push(root);
  const messages = history();
  const session = { messages: vi.fn(async () => ({ response: { ok: true }, data: structuredClone(messages) })),
    children: vi.fn(async () => ({ response: { ok: true }, data: [] as unknown[] })),
    abort: vi.fn(async () => ({ response: { ok: true }, data: true })),
    status: vi.fn(async () => ({ response: { ok: true }, data: { bound: { type: 'idle' } } })) };
  const path = join(root, 'receipt.json');
  const sessionError: { error?: unknown } = {};
  const recovery = new SurplusCompaction({ client: { session } as unknown as Pick<OpencodeClient, 'session'>,
    sessionID: 'bound', sessionError, signal: AbortSignal.timeout(1000), path, check: () => {}, onReceipt: () => {} });
  return { recovery, session, messages, path, sessionError };
}
it('preserves a pre-intent provider failure without claiming compaction or cancelling work', async () => {
  const f = await fixture();
  f.sessionError.error = { name: 'APIError', data: { message: 'Synthetic free capacity unavailable' } };
  await expect(f.recovery.recover('request')).rejects.toThrow('Synthetic free capacity unavailable');
  expect(f.session.messages).not.toHaveBeenCalled();expect(f.session.abort).not.toHaveBeenCalled();
  await expect(readFile(f.path)).rejects.toMatchObject({code:'ENOENT'});
});
it.each(['messages', 'children'] as const)('leaves native overflow recovery running when it arrives during pre-intent %s', async phase => {
  const f = await fixture(), error = { name: 'ContextOverflowError', data: { message: 'Synthetic overflow' } };
  const original = f.session[phase].getMockImplementation()!;
  f.session[phase].mockImplementation(async () => {
    f.sessionError.error = error;
    return await original() as any;
  });
  expect(await f.recovery.recover('request')).toBeUndefined();
  expect(f.sessionError.error).toBe(error);expect(f.session.abort).not.toHaveBeenCalled();
  await expect(readFile(f.path)).rejects.toMatchObject({code:'ENOENT'});
});
it('rejects malformed overflow and preserves uncertainty after cancellation intent', async () => {
  const f = await fixture();f.sessionError.error = {name:'ContextOverflowError'};
  await expect(f.recovery.recover('request')).rejects.toThrow('OpenCode session error');
  f.sessionError.error = undefined;
  f.session.abort.mockImplementation(async () => {
    f.sessionError.error = {name:'ContextOverflowError',data:{message:'Synthetic overflow'}};
    return {response:{ok:true},data:true};
  });
  await expect(f.recovery.recover('request')).rejects.toThrow('outcome uncertain');
  expect(JSON.parse(await readFile(f.path,'utf8')).state).toBe('uncertain');
});
it('returns only the exact terminal after acknowledged abort, idle and unchanged history, retaining intent', async () => {
  const f = await fixture();
  f.session.abort.mockImplementation(async () => {
    expect(JSON.parse(await readFile(f.path, 'utf8')).state).toBe('prepared');
    return { response: { ok: true }, data: true };
  });
  expect((await f.recovery.recover('request'))?.info.id).toBe('terminal');
  expect(f.session.children).toHaveBeenCalledTimes(2);
  expect(JSON.parse(await readFile(f.path, 'utf8'))).toMatchObject({ state: 'quiescent', terminalID: 'terminal', compactionID: 'compact' });
});
it.each(['manual', 'overflow', 'length', 'error', 'wrong-parent', 'native-tool', 'child-task', 'pending', 'continuation'])('does not cancel %s histories', async kind => {
  const f = await fixture(); const h = f.messages as any[];
  if (kind === 'manual') h[2].parts[0].auto = false;
  if (kind === 'overflow') h[2].parts[0].overflow = true;
  if (kind === 'length') h[1].info.finish = 'length';
  if (kind === 'error') h[1].info.error = { name: 'APIError' };
  if (kind === 'wrong-parent') h[1].info.parentID = 'old';
  if (kind === 'native-tool') h[0].parts.push({ type: 'tool', tool: 'bash', state: { status: 'completed' } });
  if (kind === 'child-task') h[0].parts.push({ type: 'subtask' });
  if (kind === 'pending') h[0].parts.push({ type: 'tool', tool: 'corporate_read', state: { status: 'running' } });
  if (kind === 'continuation') h.push({ info: { id: 'later', role: 'user' }, parts: [] });
  expect(await f.recovery.recover('request')).toBeUndefined(); expect(f.session.abort).not.toHaveBeenCalled();
});
it.each(['new-user', 'tool', 'changed-terminal', 'child', 'busy', 'abort-failure'])('fails closed on cancellation race: %s', async kind => {
  const f = await fixture();
  f.session.abort.mockImplementation(async () => {
    if (kind === 'new-user') f.messages.push({ info: { id: 'new', role: 'user' }, parts: [] } as unknown as Reply);
    if (kind === 'tool') (f.messages[3].parts as any[]).push({ type: 'tool', tool: 'corporate_write', state: { status: 'completed' } });
    if (kind === 'changed-terminal') (f.messages[1].parts[0] as any).text = 'Changed';
    if (kind === 'child') f.session.children.mockResolvedValue({ response: { ok: true }, data: [{}] });
    if (kind === 'busy') f.session.status.mockResolvedValue({ response: { ok: true }, data: { bound: { type: 'busy' } } });
    return { response: { ok: true }, data: kind !== 'abort-failure' };
  });
  await expect(f.recovery.recover('request')).rejects.toThrow();
  expect(JSON.parse(await readFile(f.path, 'utf8')).state).toBe('uncertain');
  expect(f.session.abort).toHaveBeenCalledOnce();
});
it('does not abort a session with any child, including an idle child', async () => {
  const f = await fixture(); f.session.children.mockResolvedValue({ response: { ok: true }, data: [{}] });
  expect(await f.recovery.recover('request')).toBeUndefined(); expect(f.session.abort).not.toHaveBeenCalled();
});
it('accepts only the summary cancellation error, never a provider error', () => {
  const h = history() as any[]; h[3].info.error = { name: 'MessageAbortedError' };
  expect(surplusCompactionCandidate(h, 'request')).toBeUndefined();
  expect(surplusCompactionCandidate(h, 'request', true)).toBeDefined();
  h[3].info.error.name = 'APIError'; expect(surplusCompactionCandidate(h, 'request', true)).toBeUndefined();
});

it('requires the original owned request even when a later final-response request exists', () => {
  const h = history();
  expect(surplusCompactionCandidate(h, 'request', false, 'missing-original')).toBeUndefined();
  h.unshift({ info: { id: 'original', role: 'user' }, parts: [] } as unknown as Reply);
  expect(surplusCompactionCandidate(h, 'request', false, 'original')).toBeDefined();
});
it('uses pinned ascending timestamp/counter and base62 ID encoding', () => {
  vi.spyOn(Date, 'now').mockReturnValue(1789200000123);
  try {
    const first = nativeRequestID(), second = nativeRequestID();
    expect(first).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(BigInt(`0x${second.slice(4, 16)}`) - BigInt(`0x${first.slice(4, 16)}`)).toBe(1n);
    expect(first < second).toBe(true);
  } finally { vi.restoreAllMocks(); }
});
it('awaits abort cleanup before checking idle or returning', async () => {
  const f = await fixture(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.session.abort.mockImplementation(async () => { await gate; return { response: { ok: true }, data: true }; });
  const result = f.recovery.recover('request');
  await vi.waitFor(() => expect(f.session.abort).toHaveBeenCalledOnce());
  expect(f.session.status).not.toHaveBeenCalled();
  release(); expect((await result)?.info.id).toBe('terminal');
});
it('retains uncertain intent when abort times out without retrying', async () => {
  const f = await fixture(); f.session.abort.mockRejectedValue(new DOMException('Timed out', 'TimeoutError'));
  await expect(f.recovery.recover('request')).rejects.toThrow('post-intent abort failed');
  expect(JSON.parse(await readFile(f.path, 'utf8')).state).toBe('uncertain');
  expect(f.session.status).not.toHaveBeenCalled(); expect(f.session.abort).toHaveBeenCalledOnce();
});

it.each(['attributed', 'unattributed', 'unrelated'])('handles native cancellation session error only when %s', async kind => {
  const f = await fixture();
  f.session.abort.mockImplementation(async () => {
    f.sessionError.error = { name: kind === 'unrelated' ? 'APIError' : 'MessageAbortedError', data: { message: 'Aborted' } };
    if (kind === 'attributed') (f.messages[3].info as any).error = f.sessionError.error;
    return { response: { ok: true }, data: true };
  });
  if (kind === 'attributed') {
    expect((await f.recovery.recover('request'))?.info.id).toBe('terminal'); expect(f.sessionError.error).toBeUndefined();
  } else {
    await expect(f.recovery.recover('request')).rejects.toThrow();
    expect(f.sessionError.error).toBeDefined(); expect(JSON.parse(await readFile(f.path, 'utf8')).state).toBe('uncertain');
  }
});

it.each(['messages', 'children'] as const)('pre-intent %s observation timeout remains safe to reobserve without abort intent', async method => {
  const f = await fixture(); vi.useFakeTimers();
  try {
    f.session[method].mockImplementationOnce(async (_args?: unknown, options?: { signal: AbortSignal }) =>
      new Promise<never>((_, reject) => options!.signal.addEventListener('abort', () => reject(options!.signal.reason), { once: true })));
    const pending = f.recovery.recover('request');
    const failure = expect(pending).rejects.toThrow(`surplus.pre-intent.${method} observation timed out`);
    await vi.advanceTimersByTimeAsync(10001); await failure;
    expect(f.session.abort).not.toHaveBeenCalled();
    await expect(readFile(f.path)).rejects.toThrow();
    vi.useRealTimers();
    expect((await f.recovery.recover('request'))?.info.id).toBe('terminal');
  } finally { vi.useRealTimers(); }
});
it('does not retry a post-intent messages timeout or return the earlier terminal', async () => {
  const f = await fixture();
  f.session.messages.mockImplementationOnce(async () => ({ response: { ok: true }, data: structuredClone(f.messages) }));
  f.session.messages.mockRejectedValueOnce(new DOMException('Timed out', 'TimeoutError'));
  await expect(f.recovery.recover('request')).rejects.toThrow('post-intent messages-after-abort failed');
  expect(f.session.abort).toHaveBeenCalledOnce(); expect(f.session.messages).toHaveBeenCalledTimes(2);
  expect(JSON.parse(await readFile(f.path, 'utf8'))).toMatchObject({ state: 'uncertain', operation: 'messages-after-abort' });
});

it('bounds optional full-history inspection while observing idle completion on the next poll', async () => {
  const f = await fixture();let now = 0, polls = 0;
  const clock = vi.spyOn(performance,'now').mockImplementation(()=>now);
  const recover = vi.spyOn(f.recovery,'recover').mockResolvedValue(undefined);
  f.session.status.mockImplementation(async()=>{now+=750;return {response:{ok:true},data:{bound:{type:++polls<=8?'busy':'idle'}}};});
  f.session.messages.mockResolvedValue({response:{ok:true},data:history().slice(0,2)});
  try {
    const result=await awaitSessionReply({session:f.session} as unknown as Pick<OpencodeClient,'session'>,'bound',new AbortController().signal,()=>{},0,undefined,undefined,undefined,{recovery:f.recovery,requestID:'request',originalRequestID:'request'});
    expect(result.info.id).toBe('terminal');expect(polls).toBe(9);expect(recover).toHaveBeenCalledTimes(2);expect(f.session.messages).toHaveBeenCalledTimes(1);
  } finally {clock.mockRestore();}
});
