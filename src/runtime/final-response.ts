import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { OpencodeClient } from '@opencode-ai/sdk/v2';
import { RuntimeExecutionError, type FinalResponseReceipt, type RuntimeResult } from './types.js';

export const finalResponseInstruction = 'The scheduler has verified this assignment\'s assigned corporate-action checkpoint. Briefly summarize only the actual retained outcome of this assignment and end this turn. Do not resolve the original blocked work, start other work, or call more tools. Final validation still belongs to the scheduler; this request does not establish any unobserved product, project, merge or release completion.';

export function assertFinalResponseCheckpoint(checkpoint: () => boolean, result?: RuntimeResult): void {
  try { if (checkpoint()) return; }
  catch (cause) { throw new RuntimeExecutionError('checkpoint_superseded', 'Final-response assignment or authority changed; retained work requires its current disposition', result, { cause }); }
  throw new RuntimeExecutionError('checkpoint_superseded', 'Final-response checkpoint changed; retained work requires its current disposition', result);
}

/** Called only while the gateway holds the next native employee inference. The
 * existing runner is busy and the preceding tool batch has settled. noReply
 * stores a real user request without starting another loop or resetting steps.
 * https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/session/prompt.ts
 * https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/session/llm/request.ts
 */
export class FinalResponseRequest {
  receipt?: FinalResponseReceipt;
  tools?: Record<string, false>;
  error?: unknown;
  private pending?: Promise<boolean>;
  constructor(private readonly options: {
    client: Pick<OpencodeClient, 'session'>; sessionId: string; modelId: string;
    signal: AbortSignal; path: string; checkpoint: () => boolean;
    onReceipt: (receipt: FinalResponseReceipt) => void;
  }) {}

  get active(): boolean { return this.receipt?.state === 'observed'; }

  async atInference(toolNames: string[], signal: AbortSignal): Promise<boolean> {
    if (this.error) throw this.error;
    signal.throwIfAborted();
    this.pending ??= this.admit(toolNames, signal).catch(error => { this.error = error; throw error; })
      .finally(() => { this.pending = undefined; });
    const admitted = await this.pending;
    signal.throwIfAborted();
    return admitted;
  }

  private async admit(toolNames: string[], signal: AbortSignal): Promise<boolean> {
    const o = this.options;
    const control = AbortSignal.any([o.signal, signal, AbortSignal.timeout(10000)]);
    control.throwIfAborted();
    if (this.receipt) {
      if (this.active) assertFinalResponseCheckpoint(o.checkpoint);
      return this.active;
    }
    if (!o.checkpoint()) return false;
    const status = await o.client.session.status({}, { signal: control });
    if (!status.response.ok || !status.data) throw new Error('Final-response session status unavailable');
    if (status.data[o.sessionId]?.type !== 'busy') return false;
    const snapshot = await o.client.session.messages({ sessionID: o.sessionId }, { signal: control });
    if (!snapshot.data) throw new Error('Final-response tool state unavailable');
    const last = snapshot.data.at(-1);
    if (!last || snapshot.data.some(message => message.parts.some(part => part.type === 'tool'
      && ['pending', 'running'].includes(part.state.status)))) return false;
    control.throwIfAborted();
    if (!o.checkpoint()) return false;
    this.tools = Object.fromEntries([...new Set([...toolNames, '*'])].map(name => [name, false]));
    this.receipt = { state: 'prepared', sessionId: o.sessionId, previousMessageId: last.info.id,
      instructionSha256: createHash('sha256').update(finalResponseInstruction).digest('hex'),
      disabledToolCount: Object.keys(this.tools).length - 1, requestedAt: new Date().toISOString(), path: o.path };
    let persisted = false;
    try {
      // Exclusive intent survives uncertain admission; never resend this request.
      await writeFile(o.path, JSON.stringify(this.receipt, null, 2), { mode: 0o600, flag: 'wx' });
      persisted = true;
      control.throwIfAborted();
      if (!o.checkpoint()) { this.receipt.state = 'withdrawn'; await this.save(); return false; }
      const result = await o.client.session.prompt({ sessionID: o.sessionId, agent: 'employee',
        model: { providerID: 'opencorp-local', modelID: o.modelId }, noReply: true,
        tools: this.tools, parts: [{ type: 'text', text: finalResponseInstruction }] }, { signal: control });
      // SDK declares an assistant response even for noReply; pinned upstream
      // actually returns the created user. Validate its observed wire shape.
      const message = result.data as unknown as { info?: { id?: string; role?: string; tools?: Record<string, boolean> }; parts?: Array<{ type: string; text?: string }> };
      if (!result.response.ok || message?.info?.role !== 'user' || !message.info.id
        || !message.info.tools || Object.keys(message.info.tools).length !== Object.keys(this.tools).length
        || Object.keys(this.tools).some(name => message.info!.tools![name] !== false)
        || !message.parts?.some(part => part.type === 'text' && part.text === finalResponseInstruction)) {
        throw new Error('Final-response admission receipt is unconfirmed; refusing replay');
      }
      this.receipt = { ...this.receipt, state: 'observed', messageId: message.info.id };
      await this.save();
      control.throwIfAborted();
      assertFinalResponseCheckpoint(o.checkpoint);
      return true;
    } catch (error) {
      this.error = error;
      if (this.receipt.state !== 'observed') this.receipt.state = 'uncertain';
      if (persisted) await this.save().catch(() => {});
      throw error;
    }
  }

  private async save(): Promise<void> {
    await writeFile(this.options.path, JSON.stringify(this.receipt, null, 2), { mode: 0o600 });
    this.options.onReceipt({ ...this.receipt! });
  }
}
