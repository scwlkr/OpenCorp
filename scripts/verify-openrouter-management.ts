import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import type { EmployeeRun } from '../src/core/types.js';
import { DirectFree } from '../src/runtime/direct-free.js';
import { directFreeProvider } from '../src/core/inference-policy.js';
import { directFreeConfig } from '../src/server/direct-free-config.js';
import type { RuntimeOptions } from '../src/runtime/types.js';
import type { ProviderBackoff } from '../src/core/provider-backoff.js';
import { CompanyStore } from '../src/storage/store.js';
import { CorporateBroker } from '../src/tools/broker.js';
import { workerApp } from '../src/server/app.js';
import { LocalRuntime, type RuntimeEvent } from '../src/runtime/index.js';
import { OpenRouterFree, isExactFreeModelId } from '../src/runtime/openrouter.js';
import { setupReasoningManagementFixture } from './qwen-reasoning-management-fixture.js';
import { estimatedRequestTokens } from '../src/runtime/provider-rate-budget.js';
import { managementOutcome } from '../src/scheduler/scheduler.js';

// Explicit isolated nonsensitive fixture only. The parent transport reads the
// dedicated zero-limit OpenRouter key or audited direct free-tier key; no production
// company records or local models are used.
const { values } = parseArgs({ options: { 'nonsensitive-fixture': { type: 'boolean' }, model: { type: 'string', default: 'nvidia/nemotron-3.5-lightning:free' } }, strict: true });
assert.equal(values['nonsensitive-fixture'], true, 'Requires explicit isolated nonsensitive fixture authorization: --nonsensitive-fixture');
const direct=directFreeProvider(values.model);
assert.ok(direct||isExactFreeModelId(values.model), 'Qualification requires an exact approved free-provider model ID');
const root = await mkdtemp(join(homedir(), '.local/share/opencorp-openrouter-qualification-'));
const workspace = join(root, 'workspace'); await mkdir(workspace);
const store = new CompanyStore(root);
const broker = new CorporateBroker(store, root);
const controller = new AbortController();
const events: RuntimeEvent[] = [];
let thoughtOnlyLength = false;
let providerBackoff: ProviderBackoff | undefined;
const modelId = values.model;
const options:RuntimeOptions = { dataRoot: root, ...(direct?{directFree:directFreeConfig(join(homedir(), '.local/share/opencorp'),[modelId])}:{}), openRouterFree: { modelIds: [modelId], noByokVerified: true as const, cooldown: { read: () => providerBackoff, write: (value: ProviderBackoff | undefined) => { providerBackoff = value; } }, readApiKey: async () => (await readFile(join(homedir(), '.local/share/opencorp/credentials/openrouter-free.key'), 'utf8')).trim() } };
const runtime = new LocalRuntime({ ...options, onEvent: event => {
  if (!event.type.startsWith('runtime.inference.')) return;
  events.push(event); // These events contain timing/count metadata, never reasoning text.
  const data = event.payload as Record<string, any>;
  if (event.type === 'runtime.inference.failed' && (direct || [400,401,403,404,429].includes(data.upstreamStatus))) {
    controller.abort(new Error(`Free provider failure (${data.upstreamStatus ?? data.code}); qualification stopped without another inference request.`));
  }
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
  const directOptions=direct?options.directFree?.[direct]:undefined;
  if(direct)assert.ok(directOptions,'Protected direct free-provider setup absent');
  const models = direct&&directOptions?await new DirectFree(direct,directOptions).models():await new OpenRouterFree(options.openRouterFree!).models();
  const model = models.find(item => item.id === modelId); assert.ok(model, 'Selected model must have a freshly verified free endpoint');
  report.selectedModel = { id: model.id, alias: model.alias, contextTokens: model.contextTokens, artifactIdentity: model.artifactIdentity, inferenceProfile: model.inferenceProfile, ...('tierVerification' in model?{tierVerification:model.tierVerification,tierVerifiedAt:model.tierVerifiedAt,tierExpiresAt:model.tierExpiresAt}:{}) };
  const fixture = setupReasoningManagementFixture(store, models, model, workspace);
  const { ceo, original, failed, department, task } = fixture; run = fixture.run;
  heartbeat = setInterval(() => store.heartbeat(run!.id), 30_000);
  const actor={kind:'employee',employeeId:ceo.id,runId:run.id,policyRevision:run.policyRevision} as const;
  const system=`Synthetic management qualification. Use the exact advertised corporate_ tool names and JSON schemas. Begin with corporate_company_help for this bound diagnosis, then read the exact original and failed run. Preserve acceptance; use corporate_revise_and_retry_assignment with your own corrected instructions and rationale when justified. End after the actual correction and retry receipt.`,prompt=`Inspect original assignment ${original.id} and failed run ${failed.id}. This synthetic failure omitted the target department; the intended target is actual fixture department ${department.id}. Inspect that department. Author your own concrete revised instructions and rationale, preserving acceptance, then use revise_and_retry_assignment if the evidence supports retry. If a genuine remaining obstacle prevents retry, record an accurate blocked diagnosis with evidence instead. Do not complete or execute the subordinate assignment, change its acceptance, or create substitute work. Summarize actual receipts and end.`;
  report.knownPacketEstimatedTokens=estimatedRequestTokens({messages:[{role:'system',content:system},{role:'user',content:prompt}],tools:broker.toolsFor(actor).map(tool=>({type:'function',function:{name:`corporate_${tool.name}`,description:tool.description,parameters:tool.inputSchema}})),max_tokens:4096});
  report.estimateScope='UTF-8 bytes/3 plus unchanged 4096 output; excludes native-added instructions and subsequent tool results. Actual request admission remains authoritative.';
  const result = await runtime.execute({ runId: run.id, employeeId: ceo.id, modelId: model.id, workspace, contextTokens: 32768, ...(direct?{directFreeModels:[modelId]}:{openRouterFreeModels:[modelId]}), timeoutMs: report.deadlineMs, corporateOnly: true,
    signal: controller.signal, brokerUrl: `http://${host}/mcp/${run.id}`, token: broker.mint(run), onSession: sessionId => { store.bindSession(run!.id, sessionId, workspace); },
    system, prompt });
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
  assert.equal(binding.model.contextTokens, 32768);
  assert.equal(binding.model.artifactIdentity, model.artifactIdentity);
  store.finishRun(run.id, { status: 'succeeded', modelIdentity: result.artifactIdentity, usage: result.usage, messagesPath: result.messagesPath, runtimeDiagnosticsPath: result.diagnosticsPath, managementResult: outcome });
  report.passed = true; report.verified = { runId: run.id, originalAssignmentId: original.id, correction: retained.faultCorrections.at(-1), retry: retained.retryDecisions.at(-1), outcome, artifactIdentity: result.artifactIdentity, usage: result.usage };
} catch (error) {
  const cause = controller.signal.aborted ? controller.signal.reason : error;
  report.error = cause instanceof Error ? cause.message : String(cause); process.exitCode = 1;
  if (run) store.finishRun(run.id, { status: 'failed', error: report.error });
} finally {
  if (heartbeat) clearInterval(heartbeat);
  await runtime.stop(); await broker.cancel();
  await new Promise<void>(resolve => server.close(() => resolve()));
  report.thoughtOnlyLength = thoughtOnlyLength; report.events = events;
  report.providerBackoff = providerBackoff;
  await writeFile(join(root, 'qualification.json'), JSON.stringify(report, null, 2));
  store.close(); process.off('SIGINT', stop); process.off('SIGTERM', stop);
  console.log(JSON.stringify({ root, passed: report.passed, thoughtOnlyLength, error: report.error }));
}
