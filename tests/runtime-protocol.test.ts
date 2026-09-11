import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNativeStepLimitProtocol } from '../src/core/runtime-protocol.js';
import { CompanyStore } from '../src/storage/store.js';
import { CorporateBroker } from '../src/tools/broker.js';
import { ownerApp } from '../src/server/app.js';
import type { LocalRuntime } from '../src/runtime/index.js';
import type { Scheduler } from '../src/scheduler/scheduler.js';
import type { Actor } from '../src/core/types.js';

const marker = readFileSync(new URL('./fixtures/opencode-1.18.30-max-steps.txt', import.meta.url), 'utf8');
const completion = { finishReason: 'stop', continuations: 0, outputLimit: 4096, exhausted: true,
  nativeStepLimit: { limit: 32, request: 33, toolEnabledSteps: 29 } };

describe('exact native protocol classification', () => {
  it('recognizes the actual 750-character echo only with the observed native boundary', () => {
    expect(marker).toHaveLength(750); expect(isNativeStepLimitProtocol(marker, completion)).toBe(true);
  });
  it.each([
    ['Genuine partial summary: source was committed; independent review remains.', completion],
    [`The provider returned this quoted marker:\n${marker}`, completion],
    [`${marker}\nActual employee summary follows.`, completion],
    [`${marker}\n`, completion],
    [marker, undefined], [marker, { exhausted: true }], [marker, { nativeStepLimit: {} }],
    [marker, { nativeStepLimit: { limit: 32, request: 0, toolEnabledSteps: 29 } }],
    [marker, { nativeStepLimit: { limit: 32, request: 33, toolEnabledSteps: 0 } }],
    [marker, { nativeStepLimit: { limit: 99, request: 33, toolEnabledSteps: 29 } }],
  ])('preserves summaries, quotations, differences and unconfirmed boundaries', (text, boundary) => {
    expect(isNativeStepLimitProtocol(text, boundary)).toBe(false);
  });
});

describe('historical employee narrative projections', () => {
  let root: string, store: CompanyStore, broker: CorporateBroker;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'opencorp-protocol-projection-')); store = new CompanyStore(root); store.bootstrap(); broker = new CorporateBroker(store, root); });
  afterEach(async () => { await broker.cancel(); store.close(); rmSync(root, { recursive: true, force: true }); });

  function history() {
    const employee = store.list('employees').find(item => store.level(item.id) === 'ceo')!;
    const assignment = store.put('assignments', { employeeId: employee.id, supervisorId: employee.id, projectId: null, title: 'Retained checkpoint', kind: 'management', status: 'completed', instructions: 'Original instructions', acceptance: ['Original checkpoint'], dependencies: [], priority: 1, attempts: 1, corrections: 0, availableAt: new Date().toISOString() });
    const run = store.put('runs', { assignmentId: assignment.id, employeeId: employee.id, modelId: employee.modelId, status: 'succeeded', tokenRevoked: true, text: marker, runtimeCompletion: completion });
    const message = store.put('messages', { senderId: employee.id, recipientId: employee.id, projectId: null, runId: run.id, content: marker });
    const experience = store.put('experiences', { employeeId: employee.id, authorId: employee.id, runId: run.id, summary: `${assignment.title}: ${marker}`, source: `run:${run.id}`, learned: 'Inspect retained checks.' });
    store.emit('runtime.completion.checkpoint', { runId: run.id, payload: { text: marker, completion } });
    return { employee, assignment, run, message, experience };
  }

  it('excludes exact linked copies from Owner state, messages API and employee reads while retaining raw history', async () => {
    const { employee, run, message, experience } = history();
    const ordinary = store.put('messages', { senderId: employee.id, recipientId: employee.id, projectId: null, runId: null, content: 'Actual employee discussion remains.' });
    const snapshot = store.snapshot(); expect(snapshot.messages).toEqual([ordinary]); expect(snapshot.experiences).toEqual([]);
    expect(snapshot.runs.find(item => item.id === run.id)).toEqual(run);
    expect(snapshot.events.some(event => event.type === 'runtime.completion.checkpoint' && event.payload.payload.text === marker)).toBe(true);
    const url = 'http://127.0.0.1:41300';
    const app = ownerApp({ store, broker, runtime: { status: () => ({}) } as unknown as LocalRuntime, scheduler: {} as Scheduler, getUrl: () => url });
    const headers = { host: '127.0.0.1:41300', authorization: `Bearer ${readFileSync(join(root, 'owner-token'), 'utf8').trim()}` };
    const apiMessages = await app.request(`${url}/api/v1/messages`, { headers }); expect(apiMessages.status).toBe(200); expect(await apiMessages.json()).toEqual([ordinary]);
    const apiState = await app.request(`${url}/api/v1/state`, { headers }); expect(apiState.status).toBe(200); expect(await apiState.json()).toMatchObject({ messages: [ordinary], experiences: [] });
    store.update('company', store.company.id, { state: 'running' });
    const readerAssignment = store.put('assignments', { employeeId: employee.id, supervisorId: employee.id, projectId: null, kind: 'management', status: 'running' });
    const reader = store.put('runs', { employeeId: employee.id, assignmentId: readerAssignment.id, modelId: employee.modelId, policyRevision: store.policy.revision, status: 'running', tokenRevoked: false, sessionId: 'reader-session', workspace: root, heartbeatAt: new Date().toISOString(), leaseUntil: new Date(Date.now() + 60000).toISOString() });
    const actor: Actor = { kind: 'employee', employeeId: employee.id, runId: reader.id, policyRevision: store.policy.revision };
    expect((await broker.call(actor, 'company_read', { collection: 'experiences' })).items).toEqual([]);
    await expect(broker.call(actor, 'company_detail', { collection: 'experiences', id: experience.id })).rejects.toMatchObject({ code: 'evidence_forbidden' });
    expect((await broker.call(actor, 'company_read', { collection: 'messages' })).items.map((item: { id: string }) => item.id)).toEqual([ordinary.id]);
    expect(store.need('messages', message.id)).toEqual(message); expect(store.need('experiences', experience.id)).toEqual(experience); expect(store.need('runs', run.id)).toEqual(run);
    expect(store.list('messages')).toHaveLength(2); expect(store.list('experiences')).toHaveLength(1);
  });

  it.each(['missing-limit', 'different-run-output', 'missing-run', 'different-employee', 'different-project', 'quoted-marker', 'different-source', 'different-title'])('preserves historical records with %s', variant => {
    const { run, message, experience } = history();
    if (variant === 'missing-limit') store.update('runs', run.id, { runtimeCompletion: { exhausted: true } });
    if (variant === 'different-run-output') store.update('runs', run.id, { text: 'Genuine summary with a completed checkpoint.' });
    if (variant === 'missing-run') { store.update('messages', message.id, { runId: 'another-run' }); store.update('experiences', experience.id, { runId: 'another-run' }); }
    if (variant === 'different-employee') { store.update('messages', message.id, { senderId: 'another-employee' }); store.update('experiences', experience.id, { authorId: 'another-employee' }); }
    if (variant === 'different-project') store.update('messages', message.id, { projectId: 'another-project' });
    if (variant === 'quoted-marker') { store.update('messages', message.id, { content: `Quoted provider text:\n${marker}` }); store.update('experiences', experience.id, { summary: `Quoted provider text:\n${marker}` }); }
    if (variant === 'different-source') store.update('experiences', experience.id, { source: 'run:another-run' });
    if (variant === 'different-title') store.update('experiences', experience.id, { summary: `Other quoted subject: ${marker}` });
    const state = store.snapshot();
    if (!['different-source', 'different-title'].includes(variant)) expect(state.messages).toEqual([store.need('messages', message.id)]);
    if (variant !== 'different-project') expect(state.experiences).toEqual([store.need('experiences', experience.id)]);
    expect(store.list('messages')).toHaveLength(1); expect(store.list('experiences')).toHaveLength(1);
  });
});
