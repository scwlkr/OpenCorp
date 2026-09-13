import { ResourceAdmissionError } from '../src/runtime/resource-budget.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyStore } from '../src/storage/store.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import { CorporateBroker } from '../src/tools/broker.js';
import { workplaceCommand } from '../src/core/workplace.js';
import type { LocalRuntime, ExecuteRequest, RuntimeResult } from '../src/runtime/index.js';

const owner = { kind: 'owner' } as const;
let root: string, store: CompanyStore, scheduler: Scheduler;
const admitted = new Map<string, { request: ExecuteRequest; complete: (text: string) => void }>();
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'opencorp-concurrent-scheduler-')); store = new CompanyStore(root); store.bootstrap();
  store.command(owner, { type: 'control', action: 'start' }); store.update('policy', store.policy.id, { maxInference: 3 });
  const ceo = store.list('employees').find(employee => store.level(employee.id) === 'ceo')!;
  store.put('models', { id: ceo.modelId, name: ceo.modelId, available: true, local: true, sizeClass: 'large', artifactIdentity: 'fixture-strong' });
  store.put('models', { id: 'qwen3:0.6b', name: 'qwen3:0.6b', available: true, local: true, sizeClass: 'micro', artifactIdentity: 'fixture-micro' });
  const execute = async (request: ExecuteRequest): Promise<RuntimeResult> => {
    const sessionId = `session-${request.runId}`; await request.onSession?.(sessionId); request.signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      request.signal?.addEventListener('abort', () => reject(new Error('Fixture cancelled')), { once: true });
      admitted.set(request.runId, { request, complete: text => resolve({ sessionId, text, modelId: request.modelId, artifactIdentity: 'fixture-identity',
        usage: { inputTokens: 5, outputTokens: 5, requests: 1, durationMs: 1 }, messagesPath: join(root, 'fixture-messages.json'), diagnosticsPath: join(root, 'fixture-result.json'),
        completion: { finishReason: 'stop', continuations: 0, outputLimit: 4096, exhausted: false } }) });
    });
  };
  const runtime = { execute, status: () => ({ inferenceSlots: 3, resources: { maxSocialTurns: 2 } }), cancel: async () => {}, stop: async () => {}, recoverTools: async () => ({ status: 'absent', jobs: [] }) } as unknown as LocalRuntime;
  scheduler = new Scheduler(store, runtime, new CorporateBroker(store, root), 'http://127.0.0.1:1'); await scheduler.recover();
  vi.spyOn(scheduler, 'initialize').mockResolvedValue(); vi.spyOn(scheduler as any, 'reconcileOrganization').mockImplementation(() => {}); vi.spyOn(scheduler as any, 'deliveryEvents').mockResolvedValue(undefined);
  const peers = store.list('employees').filter(employee => employee.id !== ceo.id).slice(0, 2);
  const channel = workplaceCommand(store, owner, { type: 'workplace.channel.create', name: 'Fixture common room' }) as { id: string };
  workplaceCommand(store, owner, { type: 'workplace.configure', maxConcurrentSocial: 2 });
  workplaceCommand(store, owner, { type: 'workplace.event.create', title: 'Fixture conversation', purpose: 'Exercise bounded social scheduling', channelId: channel.id,
    hostId: peers[0].id, participantIds: [peers[1].id], scheduledAt: new Date(Date.now() - 1000).toISOString() });
  store.command(owner, { type: 'assignment.create', employeeId: ceo.id, title: 'Fixture Owner conversation', instructions: 'Reply briefly to the Owner', kind: 'conversation', acceptance: ['An attributed final reply'], priority: 10 });
});
afterEach(async () => { await scheduler.shutdown(); store.close(); rmSync(root, { recursive: true, force: true }); admitted.clear(); vi.restoreAllMocks(); });

describe('concurrent scheduler lifecycle', () => {
  it('starts distinct employee turns, retains social chat without work artifacts, and preserves the productive run', async () => {
    await scheduler.tick(); await vi.waitFor(() => expect(admitted.size).toBe(3));
    const social = [...admitted.values()].filter(entry => entry.request.workload === 'social');
    const productive = [...admitted.values()].find(entry => entry.request.workload === 'productive')!;
    expect(social).toHaveLength(2);
    expect(new Set([...admitted.values()].map(entry => entry.request.employeeId)).size).toBe(3);
    for (const entry of social) {
      expect(entry.request.modelId).toBe('qwen3:0.6b'); expect(entry.request.brokerUrl).toBeUndefined();
      expect(entry.request.system).not.toContain('Final prose is not a deliverable'); expect(entry.request.contextTokens).toBe(16384);
      entry.complete(`Actual fixture reply from ${entry.request.employeeId}.`);
    }
    await vi.waitFor(() => expect(store.list('messages').filter(message => message.channelId)).toHaveLength(2));
    expect(store.list('assignments').filter(assignment => assignment.kind === 'social').every(assignment => assignment.status === 'completed')).toBe(true);
    expect(store.list('artifacts')).toEqual([]);
    expect(store.need('runs', productive.request.runId).status).toBe('running');
    productive.complete('Acknowledged.'); await vi.waitFor(() => expect(store.need('runs', productive.request.runId).status).toBe('succeeded'));
  });
  it('aborts every active controller on pause and never posts cancelled social output', async () => {
    await scheduler.tick(); await vi.waitFor(() => expect(admitted.size).toBe(3));
    store.command(owner, { type: 'control', action: 'pause' }); await scheduler.pause();
    expect([...admitted.values()].every(entry => entry.request.signal?.aborted)).toBe(true);
    await vi.waitFor(() => expect(store.list('runs').every(run => run.status === 'interrupted')).toBe(true));
    expect(store.list('messages').filter(message => message.channelId)).toHaveLength(0);
    expect(store.list('assignments').some(assignment => assignment.schedulerKey?.startsWith('fault:'))).toBe(false);
  });
});

it('runs social turns serially after productive work at a one-slot qualified limit',async()=>{
 store.update('policy',store.policy.id,{maxInference:1});
 await scheduler.tick();await vi.waitFor(()=>expect(admitted.size).toBe(1));
 const productive=[...admitted.values()][0]!;expect(productive.request.workload).toBe('productive');productive.complete('Acknowledged.');
 await vi.waitFor(()=>expect(store.need('runs',productive.request.runId).status).toBe('succeeded'));
 await vi.waitFor(async()=>{await scheduler.tick();expect(admitted.size).toBe(2);});
 const first=[...admitted.values()][1]!;expect(first.request.workload).toBe('social');first.complete('Hello colleagues.');
 await vi.waitFor(()=>expect(store.need('runs',first.request.runId).status).toBe('succeeded'));
 await vi.waitFor(async()=>{await scheduler.tick();expect(admitted.size).toBe(3);});
 const second=[...admitted.values()][2]!;expect(second.request.workload).toBe('social');expect(second.request.employeeId).not.toBe(first.request.employeeId);second.complete('Good to see you.');
 await vi.waitFor(()=>expect(store.need('runs',second.request.runId).status).toBe('succeeded'));
 expect(store.list('messages').filter(message=>message.channelId)).toHaveLength(2);expect(store.list('artifacts')).toHaveLength(0);
});

 it('retains resource refusals in the timed queue without failed work or diagnostic assignments',async()=>{
  vi.spyOn(scheduler.runtime,'execute').mockRejectedValue(new ResourceAdmissionError('Observed host memory pressure'));
  await scheduler.tick();await vi.waitFor(()=>expect(store.list('runs').length).toBeGreaterThan(0));
  await vi.waitFor(()=>expect(store.list('runs').every(r=>r.status==='interrupted')).toBe(true));
  const waiting=store.list('assignments').filter(a=>a.resourceWait);expect(waiting.length).toBeGreaterThan(0);
  expect(waiting.every(a=>a.status==='queued'&&Date.parse(a.availableAt)>Date.now())).toBe(true);
  expect(store.list('assignments').some(a=>a.schedulerKey?.startsWith('fault:'))).toBe(false);
 });
