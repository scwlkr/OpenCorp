import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import type { EmployeeRun } from '../src/core/types.js';
import { CompanyStore } from '../src/storage/store.js';
import { CorporateBroker, corporateGuide } from '../src/tools/broker.js';
import { workerApp } from '../src/server/app.js';
import { LocalRuntime, type RuntimeEvent } from '../src/runtime/index.js';
import { OwnedOllama } from '../src/runtime/ollama.js';
import { setupReasoningManagementFixture } from './qwen-reasoning-management-fixture.js';
import { managementOutcome } from '../src/scheduler/scheduler.js';

// Explicitly run only in a reviewed, drained company window. No production
// credentials or store are opened, and no model download/install API is used.
const { values } = parseArgs({ options: { 'company-drained': { type: 'boolean' } }, strict: true });
assert.equal(values['company-drained'], true, 'Requires an explicitly authorized drained-company window: --company-drained');
const root = await mkdtemp(join(homedir(), '.local/share/opencorp-qwen-reasoning-qualification-'));
const workspace = join(root, 'workspace'); await mkdir(workspace);
const store = new CompanyStore(root);
const broker = new CorporateBroker(store, root);
const controller = new AbortController();
const events: RuntimeEvent[] = [];
let thoughtOnlyLength = false;
const options = { dataRoot: root, modelStore: join(homedir(), '.local/share/opencorp/runtime/ollama/models') };
const runtime = new LocalRuntime({ ...options, onEvent: event => {
  if (!event.type.startsWith('runtime.inference.')) return;
  events.push(event); // These events contain timing/count metadata, never reasoning text.
  const data = event.payload as Record<string, any>;
  if (event.type === 'runtime.inference.observed' && data.finishReason === 'length' && !data.publicContentSamples?.length) {
    thoughtOnlyLength = true;
    controller.abort(new Error('Thought-only output exhausted the unchanged 4096-token total budget; qualification failed without extension.'));
  }
} });
let host = '';
const server = serve({ fetch: workerApp(broker, () => host).fetch, hostname: '127.0.0.1', port: 0 });
let run: EmployeeRun | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
const report: Record<string, any> = { root, syntheticFixture: true, productionAccess: false, outputTokenLimit: 4096, deadlineMs: 15 * 60 * 1000, passed: false };
const stop = () => controller.abort(new Error('Qualification interrupted'));
process.on('SIGINT', stop); process.on('SIGTERM', stop);
try {
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); host = `127.0.0.1:${address.port}`;
  // Inventory only: copies existing owned artifacts, never pulls new weights.
  const inventory = new OwnedOllama(options);
  let models;
  try { models = await inventory.models(49152); } finally { await inventory.stop(); }
  const model = models.find(item => item.id === 'qwen-low-reasoning-48k'); assert.ok(model, 'Installed template must explicitly support low reasoning');
  report.selectedModel = { id: model.id, alias: model.alias, contextTokens: model.contextTokens, artifactIdentity: model.artifactIdentity, inferenceProfile: model.inferenceProfile };
  const fixture = setupReasoningManagementFixture(store, models, model, workspace);
  const { ceo, original, failed, department, task } = fixture; run = fixture.run;
  heartbeat = setInterval(() => store.heartbeat(run!.id), 30_000);
  const result = await runtime.execute({ runId: run.id, employeeId: ceo.id, modelId: model.id, workspace, contextTokens: 49152, timeoutMs: report.deadlineMs, corporateOnly: true,
    signal: controller.signal, brokerUrl: `http://${host}/mcp/${run.id}`, token: broker.mint(run), onSession: sessionId => { store.bindSession(run!.id, sessionId, workspace); },
    system: `You are the actual manager in an isolated synthetic qualification. Use real corporate tools. Do not claim employee work was executed. End once the assigned management action has a retained receipt.\n${corporateGuide}`,
    prompt: `Inspect original assignment ${original.id} and failed run ${failed.id}. This synthetic failure omitted the target department; the intended target is actual fixture department ${department.id}. Inspect that department. Author your own concrete revised instructions and rationale, preserving acceptance, then use revise_and_retry_assignment if the evidence supports retry. If a genuine remaining obstacle prevents retry, record an accurate blocked diagnosis with evidence instead. Do not complete or execute the subordinate assignment, change its acceptance, or create substitute work. Summarize actual receipts and end.` });
  controller.signal.throwIfAborted();
  const retained = store.need('assignments', original.id);
  const outcome = managementOutcome(store, store.need('assignments', task.id), store.need('runs', run.id));
  assert.ok(outcome.passed, outcome.summary);
  assert.deepEqual(retained.acceptance, original.acceptance);
  assert.equal(retained.status, 'queued', 'This resolvable fixture requires a genuine correction/retry; blocked disposition is retained but does not qualify it.');
  assert.notEqual(retained.instructions, original.instructions);
  assert.equal(retained.faultCorrections.at(-1).runId, run.id);
  assert.equal(retained.retryDecisions.at(-1).runId, run.id);
  assert.deepEqual(result.inferenceProfile, model.inferenceProfile);
  assert.equal(result.artifactIdentity, model.artifactIdentity);
  const binding = JSON.parse(await readFile(join(root, 'runtime', 'employees', run.id, 'binding.json'), 'utf8'));
  assert.equal(binding.model.id, model.id);
  assert.equal(binding.model.contextTokens, 49152);
  assert.equal(binding.model.artifactIdentity, model.artifactIdentity);
  store.finishRun(run.id, { status: 'succeeded', modelIdentity: result.artifactIdentity, usage: result.usage, messagesPath: result.messagesPath, runtimeDiagnosticsPath: result.diagnosticsPath, managementResult: outcome });
  report.passed = true; report.verified = { runId: run.id, originalAssignmentId: original.id, correction: retained.faultCorrections.at(-1), retry: retained.retryDecisions.at(-1), outcome, artifactIdentity: result.artifactIdentity, usage: result.usage };
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1;
  if (run) store.finishRun(run.id, { status: 'failed', error: report.error });
} finally {
  if (heartbeat) clearInterval(heartbeat);
  await runtime.stop(); await broker.cancel();
  await new Promise<void>(resolve => server.close(() => resolve()));
  report.thoughtOnlyLength = thoughtOnlyLength; report.events = events;
  await writeFile(join(root, 'qualification.json'), JSON.stringify(report, null, 2));
  store.close(); process.off('SIGINT', stop); process.off('SIGTERM', stop);
  console.log(JSON.stringify({ root, passed: report.passed, thoughtOnlyLength, error: report.error }));
}
