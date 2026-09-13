import { observeControl, ControlObservationTimeout } from './control-observation.js';
import { SurplusCompaction, nativeRequestID, isContextOverflow } from './surplus-compaction.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { OpencodeClient, SessionMessagesResponse2 } from '@opencode-ai/sdk/v2';
import { RuntimeExecutionError, type NativeStepLimit } from './types.js';
import { finalResponseInstruction, type FinalResponseRequest } from './final-response.js';

type SessionErrorState = { error?: unknown };
function checkSessionError(state?: SessionErrorState): unknown {
  const error = state?.error;
  if (error && !isContextOverflow(error)) throw new Error(`OpenCode session error: ${JSON.stringify(error)}`, { cause: error });
  return error;
}

/** Poll short control requests after prompt_async admission. Never hold an HTTP
 * response open for the entire multi-step employee turn (Node's 300s header
 * timeout is shorter than legitimate local inference + canonical tool work). */
export async function awaitSessionReply(client: Pick<OpencodeClient, 'session'>, sessionID: string,
  signal: AbortSignal, check: () => void = () => {}, intervalMs = 750, afterMessageId?: string,
  finalResponse?: FinalResponseRequest, sessionError?: SessionErrorState, surplus?: { recovery: SurplusCompaction; requestID: string; originalRequestID: string }): Promise<SessionMessagesResponse2[number]> {
  let nextSurplusCheckAt = 0;
  while (true) {
    signal.throwIfAborted(); check();
    checkSessionError(sessionError);
    try {
    const status = await observeControl('session.status', signal, check, control => client.session.status({}, { signal: control }));
    signal.throwIfAborted(); check(); checkSessionError(sessionError);
    if (!status.data || !status.response.ok) throw new Error('OpenCode session status unavailable');
    if (status.data[sessionID]?.type === 'busy' && surplus && !sessionError?.error && performance.now() >= nextSurplusCheckAt) {
      // Optional cleanup reads full history; normal status/error polling stays fast.
      nextSurplusCheckAt = performance.now() + 5000;
      const recovered = await surplus.recovery.recover(finalResponse?.receipt?.messageId ?? surplus.requestID, surplus.originalRequestID);
      signal.throwIfAborted(); check(); checkSessionError(sessionError);
      if (recovered) return recovered;
    }
    if (!status.data[sessionID] || status.data[sessionID].type === 'idle') {
      const messages = await observeControl('session.messages', signal, check, control => client.session.messages({ sessionID }, { signal: control }));
      signal.throwIfAborted(); check();
      let error = checkSessionError(sessionError);
      if (error) {
        // Overflow may have arrived after the first idle observation, while
        // the native loop already entered recovery. Reobserve before deciding.
        const current = await observeControl('overflow.session.status', signal, check, control => client.session.status({}, { signal: control }));
        signal.throwIfAborted(); check(); error = checkSessionError(sessionError);
        if (!current.data || !current.response.ok) throw new Error('OpenCode session status unavailable');
        if (current.data[sessionID] && current.data[sessionID].type !== 'idle') {
          await delay(intervalMs, undefined, { signal }).catch(error => { signal.throwIfAborted(); throw error; });
          continue;
        }
      }
      const last = messages.data?.at(-1);
      const finalId = finalResponse?.receipt?.messageId;
      const finalIndex = finalId ? messages.data?.findIndex(item => item.info.id === finalId) ?? -1 : -1;
      const parentId = last?.info.role === 'assistant' ? last.info.parentID : undefined;
      const parentIndex = parentId ? messages.data?.findIndex(item => item.info.id === parentId) ?? -1 : -1;
      const currentUserId = messages.data?.findLast(item => item.info.role === 'user')?.info.id;
      const recovered = last?.info.role === 'assistant' && !last.info.summary && last.info.finish
        && !['tool-calls', 'unknown'].includes(last.info.finish) && parentId === currentUserId && Boolean(currentUserId)
        && !last.parts.some(part => part.type === 'tool');
      if (last?.info.role === 'assistant' && (!afterMessageId || last.info.id !== afterMessageId)
        && (!finalId || finalIndex >= 0 && parentIndex >= finalIndex) && (last.info.time.completed || last.info.error)
        && (!error || last.info.error || recovered)) {
        if (sessionError && sessionError.error === error) sessionError.error = undefined;
        return last;
      }
      // OpenCode 1.18.30 processor.ts emits ContextOverflowError BEFORE the
      // busy prompt loop compacts. A terminal compaction instead stores an
      // assistant.error/finish:error; return that actual reply for provenance.
      // Never turn an unresolved idle overflow into success or a new prompt.
      if (error) throw new Error(`OpenCode session error: ${JSON.stringify(error)}`, { cause: error });
    }
    } catch (error) {
      if (!(error instanceof ControlObservationTimeout)) throw error;
      // Reobserve status too: a stale idle snapshot cannot establish completion.
      signal.throwIfAborted(); check(); checkSessionError(sessionError);
    }
    await delay(intervalMs, undefined, { signal }).catch(error => { signal.throwIfAborted(); throw error; });
  }
}

type Reply = SessionMessagesResponse2[number];
type Prompt = NonNullable<Parameters<OpencodeClient['session']['promptAsync']>[0]>;

/** An output limit is not a completed assignment. Continue at most twice inside
 * the original session, signal/deadline, process and cumulative gateway budgets. */
export async function completeSession(options: {
  client: Pick<OpencodeClient, 'session'>; prompt: Prompt; signal: AbortSignal;
  check?: () => void; intervalMs?: number; budget: () => { requests: number; steps: number; nativeStepLimit?: NativeStepLimit };
  onReply: (reply: Reply, continuations: number) => Promise<void>;
  onContinue?: (continuations: number, previousMessageId: string) => void;
  outputLimit?:1024|4096;
  finalResponse?: FinalResponseRequest;
  sessionError?: SessionErrorState;
  surplusCompaction?: { path: string; onReceipt: (receipt: Record<string, unknown>) => void };
}): Promise<Reply> {
  let previous: Reply | undefined;
  let originalRequestID: string | undefined;
  for (let continuations = 0; ; continuations++) {
    options.signal.throwIfAborted(); options.check?.(); checkSessionError(options.sessionError);
    const budget = options.budget();
    if (budget.requests >= 36) throw new RuntimeExecutionError('run_budget_exhausted', 'Employee run exhausted its 36 local inference requests');
    if (budget.steps >= 32) throw new RuntimeExecutionError('step_budget_exhausted', 'Employee run exhausted its 32 tool-enabled model steps');
    const controlSignal = () => AbortSignal.any([options.signal, AbortSignal.timeout(10000)]);
    const before = await observeControl('pre-dispatch.session.messages', options.signal, () => { options.check?.(); checkSessionError(options.sessionError); },
      control => options.client.session.messages({ sessionID: options.prompt.sessionID }, { signal: control }), true);
    if (!before.data) throw new Error('OpenCode pre-dispatch messages unavailable');
    const lastId = before.data.at(-1)?.info.id;
    if (previous && lastId !== previous.info.id) throw new Error('OpenCode conversation changed before output-limit continuation; refusing duplicate dispatch');
    if (previous) options.onContinue?.(continuations, previous.info.id);
    checkSessionError(options.sessionError);
    const requestID = options.surplusCompaction ? nativeRequestID() : undefined;
    originalRequestID ??= requestID;
    const recovery = options.surplusCompaction ? new SurplusCompaction({ ...options.surplusCompaction,
      client: options.client, sessionID: options.prompt.sessionID, signal: options.signal,
      sessionError: options.sessionError, check: () => { options.check?.(); } }) : undefined;
    await options.client.session.promptAsync({ ...options.prompt, ...(requestID ? { messageID: requestID } : {}),
      ...(options.finalResponse?.active ? { tools: options.finalResponse.tools } : {}), parts: previous ? [{ type: 'text', text:
      options.finalResponse?.active ? `Your final response reached its output limit. ${finalResponseInstruction} The original cumulative budgets still apply.` :
      `Your previous response reached its ${options.outputLimit??4096}-token output limit before completing. Continue the unfinished assignment in this same session using the retained evidence and existing files. Execute the remaining necessary tools now; avoid repeating completed reads or lengthy planning. Report only actual results. The original run time and inference/tool-step budgets still apply.` }] : options.prompt.parts }, { signal: controlSignal() });
    const reply = await awaitSessionReply(options.client, options.prompt.sessionID, options.signal, options.check, options.intervalMs, lastId, options.finalResponse, options.sessionError, recovery && requestID ? { recovery, requestID, originalRequestID: originalRequestID! } : undefined);
    await options.onReply(reply, continuations);
    // Preserve a real completed checkpoint, but never evade the native agent
    // step limit by injecting another user turn for an output continuation.
    if (options.budget().nativeStepLimit) return reply;
    if (reply.info.role !== 'assistant' || reply.info.error || reply.info.finish !== 'length') return reply;
    if (continuations >= 2) throw new RuntimeExecutionError('output_limit_exhausted', `Local model ended with finish=length at the ${options.outputLimit??4096}-token response cap after two same-session continuations; inspect retained completed tools and evidence before choosing subsequent work`);
    previous = reply;
  }
}
