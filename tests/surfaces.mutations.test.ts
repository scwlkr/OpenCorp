import { describe, expect, it, vi } from 'vitest';
import { verifyChatReceipt, verifyControlReceipt, waitForControlReceipt } from './surfaces.mutations.js';
import type { CompanySnapshot } from '../src/core/types.js';

function state(): CompanySnapshot {
  return { company: { id: 'actual-company', state: 'paused' }, policy: { localOnly: true, spendingLimit: 0 },
    positions: [{ id: 'ceo-position', level: 'ceo' }], employees: [{ id: 'ceo-id', positionId: 'ceo-position', status: 'active' }],
    runs: [], messages: [], assignments: [] } as unknown as CompanySnapshot;
}
describe('actual surface mutation receipt verification', () => {
  it('requires the command result and independently read backend to agree on company and lifecycle', () => {
    const before = state(), response = state(), observed = state(); before.company.state = 'running';
    expect(verifyControlReceipt('compiled-cli', 'pause', before, response, observed).afterState).toBe('paused');
    response.company.id = 'unrelated-company'; expect(() => verifyControlReceipt('compiled-cli', 'pause', before, response, observed)).toThrow(/different company/);
    response.company.id = before.company.id; observed.company.state = 'running'; expect(() => verifyControlReceipt('webui', 'pause', before, response, observed)).toThrow(/requested state/);
    observed.company.state = 'paused'; observed.runs = [{ status: 'cancelling' }] as CompanySnapshot['runs']; expect(() => verifyControlReceipt('webui', 'pause', before, response, observed)).toThrow(/active work/);
  });
  it('rejects policy weakening even when a surface returned the expected control state', () => {
    const before = state(), response = state(), observed = state(); observed.policy.spendingLimit = 1;
    expect(() => verifyControlReceipt('webui', 'pause', before, response, observed)).toThrow();
    observed.policy.spendingLimit = 0; response.policy.localOnly = false; expect(() => verifyControlReceipt('compiled-cli', 'pause', before, response, observed)).toThrow();
  });
  it('waits for revoked preparation to finish before issuing a control receipt', async () => {
    const before = state(), response = state(); before.company.state = 'running';
    response.runs = [{ id: 'preparing-run', status: 'cancelling', tokenRevoked: true, runtimeDispatch: 'claimed', sessionId: null }] as unknown as CompanySnapshot['runs'];
    let cleanupFinished = false;
    const timer = setTimeout(() => { cleanupFinished = true; }, 150);
    const read = vi.fn(async () => {
      const observed = structuredClone(response);
      if (cleanupFinished) observed.runs[0].status = 'interrupted';
      return observed;
    });
    try {
      const receipt = await waitForControlReceipt('webui', 'pause', before, response, read);
      expect(cleanupFinished).toBe(true); expect(read.mock.calls.length).toBeGreaterThan(1);
      expect(receipt.revokedRunIds).toEqual(['preparing-run']);
    } finally { clearTimeout(timer); }
  });
  it.each(['queued', 'running', 'cancelling'] as const)('rejects an unrevoked %s response without waiting for a later terminal state', async status => {
    const response = state(); response.runs = [{ id: 'unsafe-run', status, tokenRevoked: false }] as CompanySnapshot['runs'];
    const read = vi.fn(async () => state());
    await expect(waitForControlReceipt('compiled-cli', 'pause', state(), response, read)).rejects.toThrow(/unrevoked authority/);
    expect(read).not.toHaveBeenCalled();
  });
  it('rejects new admission, lost run records, policy drift, or restored authority during cleanup', async () => {
    const response = state(); response.runs = [{ id: 'preparing-run', status: 'cancelling', tokenRevoked: true }] as CompanySnapshot['runs'];
    for (const mutate of [
      (copy: CompanySnapshot) => { copy.runs.push({ ...copy.runs[0], id: 'new-run', status: 'interrupted' }); },
      (copy: CompanySnapshot) => { copy.runs = []; },
      (copy: CompanySnapshot) => { copy.runs[0].tokenRevoked = false; },
      (copy: CompanySnapshot) => { copy.policy.localOnly = false; },
      (copy: CompanySnapshot) => { copy.policy.spendingLimit = 1; },
      (copy: CompanySnapshot) => { copy.company.state = 'running'; },
    ]) {
      const observed = structuredClone(response); mutate(observed);
      await expect(waitForControlReceipt('webui', 'pause', state(), response, async () => observed)).rejects.toThrow();
    }
  });
  it.each(['nonterminal', 'unresponsive'] as const)('bounds %s cleanup observation to 12 seconds', async mode => {
    vi.useFakeTimers();
    try {
      const response = state(); response.runs = [{ id: 'preparing-run', status: 'cancelling', tokenRevoked: true }] as CompanySnapshot['runs'];
      let signal: AbortSignal | undefined;
      const pending = waitForControlReceipt('compiled-cli', 'pause', state(), response, async current => {
        signal = current;
        if (mode === 'unresponsive') return new Promise<CompanySnapshot>(() => {});
        return structuredClone(response);
      });
      const rejected = expect(pending).rejects.toThrow(/within 12000ms/);
      await vi.advanceTimersByTimeAsync(12_000); await rejected;
      expect(signal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('requires a new attributed retained message and its exact queued response assignment', () => {
    const before = state(), observed = state(), message = { id: 'message-id', senderId: 'owner', recipientId: 'ceo-id', projectId: null, content: 'Acknowledgment-only interface check' };
    observed.messages = [message] as CompanySnapshot['messages'];
    observed.assignments = [{ id: 'response-assignment', employeeId: 'ceo-id', projectId: null, kind: 'conversation', status: 'queued', accepted: true, payload: { messageId: message.id } }] as unknown as CompanySnapshot['assignments'];
    expect(verifyChatReceipt('webui', before, message, observed, message.content)).toMatchObject({ messageId: message.id, assignmentId: 'response-assignment', delivery: 'persisted_response_queued' });
    for (const mutate of [
      (copy: CompanySnapshot) => { copy.messages = []; },
      (copy: CompanySnapshot) => { copy.messages[0].recipientId = 'unrelated-employee'; },
      (copy: CompanySnapshot) => { copy.assignments[0].payload.messageId = 'different-message'; },
      (copy: CompanySnapshot) => { copy.assignments[0].status = 'completed'; },
      (copy: CompanySnapshot) => { copy.assignments.push(structuredClone(copy.assignments[0])); },
      (copy: CompanySnapshot) => { copy.company.state = 'running'; },
    ]) { const copy = structuredClone(observed); mutate(copy); expect(() => verifyChatReceipt('compiled-cli', before, message, copy, message.content)).toThrow(); }
    before.messages = [message] as CompanySnapshot['messages']; expect(() => verifyChatReceipt('webui', before, message, observed, message.content)).toThrow(/new durable message/);
  });
});
