import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { CompanyStore } from '../src/storage/store.js';
import { ownerApp } from '../src/server/app.js';
import { CorporateBroker } from '../src/tools/broker.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import type { LocalRuntime } from '../src/runtime/index.js';
import { withOwnerMutationSurfaces } from '../tests/surfaces.browser.js';

// Production browser bundle + compiled CLI + actual Owner API/storage. Only
// dispatch is inert: this disposable regression cannot run models or products.
const root = await mkdtemp(join(tmpdir(), 'opencorp-surface-controls-fixture-'));
const store = new CompanyStore(root); store.bootstrap();
const broker = new CorporateBroker(store, root);
let preparation: AbortController | undefined;
const cleanups: Promise<void>[] = [];
const runtime = { configureResources:async()=>{}, status: () => ({ activeRuns: [], ollama: { running: false } }) } as unknown as LocalRuntime;
const scheduler = Object.assign(new Scheduler(store,runtime,broker,'http://localhost'), { start() {}, async pause() { preparation?.abort(); } });
// Reproduce cancellation before an inference session exists. The real control
// command revokes authority immediately; dependency cleanup drains afterward.
const preparingRun = () => {
  const employee = store.list('employees').find(item => store.level(item.id) === 'ceo')!;
  const assignment = store.command({ kind: 'owner' }, { type: 'assignment.create', employeeId: employee.id, supervisorId: employee.id,
    title: 'Disposable preparation cancellation regression', instructions: 'No model or product work', acceptance: ['Observe cancellation'], kind: 'management' });
  store.update('assignments', assignment.id, { status: 'running', attempts: 1 });
  const run = store.put('runs', { employeeId: employee.id, assignmentId: assignment.id, modelId: employee.modelId,
    policyRevision: store.policy.revision, workspace: root, sessionId: null, runtimeDispatch: 'claimed', status: 'running', attempt: 1,
    leaseUntil: new Date(Date.now() + 60_000).toISOString(), heartbeatAt: new Date().toISOString(), tokenRevoked: false });
  preparation = new AbortController();
  cleanups.push(new Promise<void>(resolve => preparation!.signal.addEventListener('abort', () => {
    setTimeout(() => { store.finishRun(run.id, { status: 'interrupted', error: 'Disposable delayed preparation cleanup' }); resolve(); }, 300);
  }, { once: true })));
  return run;
};
let url = '';
const server = serve({ fetch: ownerApp({ store, broker, scheduler, runtime, getUrl: () => url }).fetch, hostname: '127.0.0.1', port: 0 });
try {
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const address = server.address(); assert.ok(address && typeof address !== 'string'); url = `http://127.0.0.1:${address.port}`;
  await writeFile(join(root, 'discovery.json'), JSON.stringify({ url, pid: process.pid }), { mode: 0o600 });
  const evidence = await withOwnerMutationSurfaces(root, join(root, 'evidence'), async ({ web, cli }) => {
    await web.control('start');
    const webRun = preparingRun(), paused = await web.control('pause');
    assert.deepEqual(paused.revokedRunIds, [webRun.id]); assert.equal(store.need('runs', webRun.id).status, 'interrupted');
    await web.chat('Disposable WebUI transport acknowledgment only.');
    await cli.chat('Disposable compiled CLI transport acknowledgment only.');
    await web.control('resume'); await cli.control('pause'); await web.control('stop');
    await cli.control('start');
    const cliRun = preparingRun(), stopped = await cli.control('stop');
    assert.deepEqual(stopped.revokedRunIds, [cliRun.id]); assert.equal(store.need('runs', cliRun.id).status, 'interrupted');
    await cli.control('resume');
  });
  assert.equal(evidence.passed, true);
  for (const surface of ['webui', 'compiled-cli']) {
    for (const action of ['start', 'pause', 'resume', 'stop']) assert.ok(evidence.controls.some(item => item.surface === surface && item.action === action));
    const chat = evidence.chats.find(item => item.surface === surface); assert.ok(chat);
    assert.equal(store.need('messages', chat.messageId).content, chat.content); assert.equal(store.need('assignments', chat.assignmentId).status, 'queued');
  }
  assert.equal(store.list('messages').length, 2); assert.equal(store.list('runs').length, 2);
  for (const run of store.list('runs')) { assert.equal(run.status, 'interrupted'); assert.equal(run.tokenRevoked, true); assert.equal(run.sessionId, null); assert.equal(run.usage, undefined); }
  assert.equal(store.list('actions').length, 0); assert.equal(store.list('artifacts').length, 0);
  console.log('Production WebUI and compiled CLI control/chat fixture passed; no inference or product work.');
} finally {
  preparation?.abort(); await Promise.all(cleanups);
  await broker.cancel(); if ('closeAllConnections' in server) server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  store.close(); await rm(root, { recursive: true, force: true });
}
