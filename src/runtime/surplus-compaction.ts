import { observeControl } from './control-observation.js';
import { createHash, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { OpencodeClient, SessionMessagesResponse2 } from '@opencode-ai/sdk/v2';

type Reply = SessionMessagesResponse2[number];
type Client = Pick<OpencodeClient, 'session'>;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Pinned Identifier.create: 48-bit millisecond/counter prefix, 14 base62 bytes.
// https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/id/id.ts
let lastTimestamp = 0, counter = 0;
export function nativeRequestID(): string {
  const now = Date.now();
  if (lastTimestamp !== now) { lastTimestamp = now; counter = 0; }
  const time = ((BigInt(now) * 4096n + BigInt(++counter)) & 0xffffffffffffn).toString(16).padStart(12, '0');
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  return `msg_${time}${[...randomBytes(14)].map(byte => chars[byte % 62]).join('')}`;
}

export function isContextOverflow(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'ContextOverflowError'
    && 'data' in error && typeof error.data === 'object' && error.data !== null
    && 'message' in error.data && typeof error.data.message === 'string';
}

/** Private owned sessions only. Full retained history must exclude native
 * task/bash calls and all children before session-wide cancellation. */
export class SurplusCompaction {
  constructor(private readonly options: { client: Client; sessionID: string; signal: AbortSignal;
    sessionError?: { error?: unknown }; path: string; check: () => void; onReceipt: (receipt: Record<string, unknown>) => void }) {}

  async recover(requestID: string, originalRequestID = requestID): Promise<Reply | undefined> {
    const o = this.options;
    let control = o.signal;
    let cancelling = false;
    let intent = false;
    const check = () => {
      control.throwIfAborted(); o.check();
      const error = o.sessionError?.error;
      if (error && (intent || !isContextOverflow(error)) && (!cancelling || typeof error !== 'object' || !('name' in error) || error.name !== 'MessageAbortedError')) {
        throw new Error(`OpenCode session error: ${JSON.stringify(error)}`);
      }
    };
    check();
    if (isContextOverflow(o.sessionError?.error)) return;
    const before = await observeControl('surplus.pre-intent.messages', o.signal, check, observed => o.client.session.messages({ sessionID: o.sessionID }, { signal: observed }));
    if (isContextOverflow(o.sessionError?.error)) return;
    if (!before.response.ok || !before.data) throw new Error('Surplus-compaction messages unavailable');
    const history = before.data;
    const candidate = surplusCompactionCandidate(history, requestID, false, originalRequestID);
    if (!candidate) return;
    const children = async () => {
      const result = cancelling ? await o.client.session.children({ sessionID: o.sessionID }, { signal: control })
        : await observeControl('surplus.pre-intent.children', o.signal, check, observed => o.client.session.children({ sessionID: o.sessionID }, { signal: observed }));
      if (!result.response.ok || !result.data) throw new Error('Surplus-compaction child work unavailable');
      return result.data.length === 0;
    };
    // Existing child work makes this optimization ineligible; let it finish
    // normally rather than failing the run and stopping its owned worker.
    if (!await children()) return;
    check();
    if (isContextOverflow(o.sessionError?.error)) return;
    const receipt: Record<string, unknown> = { state: 'prepared', sessionID: o.sessionID, requestID, originalRequestID,
      terminalID: candidate.terminal.info.id, compactionID: candidate.compaction.info.id,
      historySha256: digest(history), preparedAt: new Date().toISOString() };
    const save = async () => { await writeFile(o.path, JSON.stringify(receipt, null, 2), { mode: 0o600 }); o.onReceipt({ ...receipt }); };
    // Exclusive intent: an uncertain cancellation is never retried.
    intent = true;
    await writeFile(o.path, JSON.stringify(receipt, null, 2), { mode: 0o600, flag: 'wx' });
    let operation = 'abort';
    try {
      control = AbortSignal.any([o.signal, AbortSignal.timeout(10000)]);
      check();
      cancelling = true;
      const aborted = await o.client.session.abort({ sessionID: o.sessionID }, { signal: control });
      if (!aborted.response.ok || aborted.data !== true) throw new Error('Surplus-compaction cancellation unconfirmed');
      check();
      operation = 'status-after-abort';
      const status = await o.client.session.status({}, { signal: control });
      if (!status.response.ok || !status.data || status.data[o.sessionID]?.type && status.data[o.sessionID].type !== 'idle') {
        throw new Error('Surplus-compaction native session is not quiescent');
      }
      operation = 'children-after-abort';
      if (!await children()) throw new Error('Surplus-compaction child work appeared during cancellation');
      operation = 'messages-after-abort';
      const after = await o.client.session.messages({ sessionID: o.sessionID }, { signal: control });
      if (!after.response.ok || !after.data) throw new Error('Surplus-compaction final messages unavailable');
      check();
      operation = 'validate-history';
      const latest = surplusCompactionCandidate(after.data, requestID, true, originalRequestID);
      const previousSummary = history[candidate.index + 2];
      if (previousSummary && after.data[candidate.index + 2]?.info.id !== previousSummary.info.id) {
        throw new Error('Surplus-compaction summary identity changed');
      }
      if (!latest || latest.terminal.info.id !== candidate.terminal.info.id
        || latest.compaction.info.id !== candidate.compaction.info.id
        || digest(after.data.slice(0, candidate.index + 1)) !== digest(history.slice(0, candidate.index + 1))
        || digest(latest.compaction) !== digest(candidate.compaction)) {
        throw new Error('Surplus-compaction conversation changed; retained work requires recovery');
      }
      operation = 'final-status';
      const settled = await o.client.session.status({}, { signal: control });
      if (!settled.response.ok || !settled.data || settled.data[o.sessionID]?.type && settled.data[o.sessionID].type !== 'idle') {
        throw new Error('Surplus-compaction quiescence changed during validation');
      }
      check();
      const cancellationError = o.sessionError?.error;
      if (cancellationError) {
        const summary = after.data[candidate.index + 2];
        if (summary?.info.role !== 'assistant' || summary.info.error?.name !== 'MessageAbortedError') {
          throw new Error('Surplus-compaction abort error is not attributed to the verified summary');
        }
      }
      receipt.state = 'quiescent'; receipt.completedAt = new Date().toISOString();
      receipt.finalHistorySha256 = digest(after.data); await save();
      if (o.sessionError && o.sessionError.error === cancellationError && cancellationError) o.sessionError.error = undefined;
      return latest.terminal;
    } catch (error) {
      receipt.state = 'uncertain'; receipt.operation = operation; receipt.failedAt = new Date().toISOString();
      await save(); throw new Error(`OpenCode surplus post-intent ${operation} failed; outcome uncertain`, { cause: error });
    }
  }
}

export function surplusCompactionCandidate(history: Reply[], requestID: string, cancelled = false, originalRequestID = requestID):
  { terminal: Reply; compaction: Reply; index: number } | undefined {
  if (history[0]?.info.role !== 'user' || history[0].info.id !== originalRequestID) return;
  // A native tool or child-task artifact means session-wide cancellation cannot
  // prove absence of detached work. Corporate tool batches must all be settled.
  if (history.some(message => message.parts.some(part => part.type === 'subtask'
    || part.type === 'tool' && (!part.tool.startsWith('corporate_') || !['completed', 'error'].includes(part.state.status))))) return;
  const index = history.findLastIndex(message => message.info.role === 'assistant' && !message.info.summary);
  const terminal = history[index], compaction = history[index + 1];
  if (!terminal || terminal.info.role !== 'assistant' || terminal.info.agent !== 'employee'
    || terminal.info.parentID !== requestID || terminal.info.finish !== 'stop' || terminal.info.error
    || !terminal.info.time.completed || terminal.parts.some(part => part.type === 'tool')
    || !compaction || compaction.info.role !== 'user' || compaction.parts.length !== 1) return;
  const request = history.findLast(message => message.info.role === 'user' && message !== compaction);
  if (request?.info.id !== requestID) return;
  const part = compaction.parts[0];
  if (part.type !== 'compaction' || !part.auto || part.overflow !== false) return;
  const tail = history.slice(index + 2);
  if (tail.length > 1) return;
  if (tail.length) {
    const summary = tail[0];
    if (summary.info.role !== 'assistant' || !summary.info.summary || summary.info.agent !== 'compaction'
      || summary.info.parentID !== compaction.info.id || summary.parts.some(part => !['text', 'reasoning', 'step-start', 'step-finish'].includes(part.type))
      || summary.info.error && (!cancelled || summary.info.error.name !== 'MessageAbortedError')) return;
  }
  return { terminal, compaction, index };
}
