import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import { CompanyStore, instructionsHash } from '../src/storage/store.js';
import { DomainError, type Actor, type EmployeeRun } from '../src/core/types.js';
import { CorporateBroker, brokerTools, corporateGuide } from '../src/tools/broker.js';
import { workerApp } from '../src/server/app.js';
import { managementOutcome } from '../src/scheduler/scheduler.js';
import { LocalRuntime, RuntimeExecutionError, type RuntimeEvent } from '../src/runtime/index.js';

// Real local inference and corporate persistence in an explicitly synthetic
// company. This fixture never constitutes autonomous product work or delivery.
const { values } = parseArgs({ options: { model: { type: 'string', default: 'nemotron' } }, strict: true, allowPositionals: false });
assert.ok(values.model === 'nemotron' || values.model === 'qwen-main', '--model must be nemotron or qwen-main');
const root = await mkdtemp(join(homedir(), '.local/share/opencorp-corporate-verification-'));
const workspace = join(root, 'workspaces', 'corporate-fixture');
await mkdir(workspace, { recursive: true });
const reportPath = join(root, 'corporate-runtime-verification.json');
const store = new CompanyStore(root);
const calls: Array<{ name: string; arguments: unknown; completed: boolean; error?: string }> = [];
const runtimeEvents: RuntimeEvent[] = [];
const controller = new AbortController();
const identicalFailureLimit = 3;
const allowedTools = new Set(['company_read', 'company_detail', 'company_help', 'knowledge_search', 'company_command', 'create_assignment', 'record_blocked_diagnosis']);

class FixtureBroker extends CorporateBroker {
  override async call(actor: Actor, name: string, args: any): Promise<any> {
    const call: (typeof calls)[number] = { name, arguments: args, completed: false };
    calls.push(call);
    try {
      // Advertise the exact full production catalog, but deny every external or
      // product adapter before invocation. Allowed tools use their real handlers.
      // Let malformed/missing discriminators reach production's non-mutating
      // invalid_command validation, so the model receives its real correction.
      if (!allowedTools.has(name) || name === 'company_command' && typeof args.command?.type === 'string' && !['employee.model', 'decision.create', 'assignment.update'].includes(args.command.type)) {
        throw new DomainError('fixture_scope', 'This disposable qualification permits only its corporate reads and requested management changes.', 403);
      }
      if (name === 'company_command' && args.command?.type === 'decision.create' && args.command.kind !== 'strategy') {
        throw new DomainError('fixture_scope', 'Only the requested fixture strategy decision is in scope.', 403);
      }
      const result = await super.call(actor, name, args);
      call.completed = true;
      console.log(JSON.stringify({ type: 'fixture.tool.completed', name }));
      return result;
    } catch (error) {
      call.error = error instanceof Error ? error.message : String(error);
      console.log(JSON.stringify({ type: 'fixture.tool.failed', name, error: call.error }));
      const identicalFailures = calls.filter(previous => previous.name === name && previous.error === call.error && isDeepStrictEqual(previous.arguments, args)).length;
      if (identicalFailures >= identicalFailureLimit) controller.abort(new Error(`Fixture stopped after ${identicalFailures} identical failed ${name} calls: ${call.error}`));
      throw error;
    }
  }
}

const broker = new FixtureBroker(store, root);
const runtime = new LocalRuntime({ dataRoot: root, onEvent: event => {
  // Keep prompt/part contents out of this concise qualification receipt.
  if (event.type.startsWith('runtime.inference.') || ['runtime.session.bound', 'runtime.agent.step_limit', 'runtime.budget.exhausted'].includes(event.type)) {
    runtimeEvents.push(event);
    store.emit(event.type, { runId: event.runId, payload: event.payload });
    if (['runtime.inference.started', 'runtime.inference.finished'].includes(event.type)) console.log(JSON.stringify(event));
  }
} });
let workerHost = '';
const server = serve({ fetch: workerApp(broker, () => workerHost).fetch, hostname: '127.0.0.1', port: 0 });
const report: Record<string, any> = {
  kind: 'disposable-real-corporate-runtime-qualification', root, startedAt: new Date().toISOString(),
  productionCompanyAccess: false, productOutcome: false, inferenceDeadlineMs: 15 * 60 * 1000,
  requestedModelId: values.model,
  identicalFailureLimit,
  catalogSha256: createHash('sha256').update(JSON.stringify(brokerTools)).digest('hex'),
  inputSchemasSha256: createHash('sha256').update(JSON.stringify(brokerTools.map(({ name, inputSchema }) => ({ name, inputSchema })))).digest('hex'),
  advertisedTools: brokerTools.map(tool => tool.name), fixtureAllowedTools: [...allowedTools],
};
let run: EmployeeRun | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
const interrupt = () => controller.abort(new Error('Corporate fixture received SIGINT; cancel the owned run and retain evidence.'));
const terminate = () => controller.abort(new Error('Corporate fixture received SIGTERM; cancel the owned run and retain evidence.'));
process.on('SIGINT', interrupt);
process.on('SIGTERM', terminate);

try {
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  workerHost = `127.0.0.1:${address.port}`;
  store.bootstrap();
  const owner = { kind: 'owner' } as const;
  // Fixture construction narrows its private allowlist; the public policy command correctly forbids changing the release envelope.
  store.update('policy', store.policy.id, { allowedRepositories: [] });
  store.update('company', store.company.id, { mandate: 'Disposable corporate tool integration fixture. No real products, external actions, spending or actual product outcomes.' });
  for (const product of store.list('products')) store.update('products', product.id, { name: `Fixture ${product.id}`, repository: join(root, 'unregistered-products', product.id) });
  controller.signal.throwIfAborted();
  const models = await runtime.installModels();
  controller.signal.throwIfAborted();
  for (const model of models) store.put('models', { ...model, id: model.sourceAlias, name: model.sourceAlias });
  const selectedModel = models.find(model => model.id === values.model);
  const small = models.find(model => model.id === 'small');
  assert.ok(selectedModel && small, 'Installed actual selected management and small artifacts are required');
  assert.deepEqual(selectedModel.inferenceProfile, values.model === 'qwen-main' ? { id: 'qwen-no-thinking-v1', reasoningEffort: 'none' } : undefined);
  report.selectedModel = { id: selectedModel.id, sourceAlias: selectedModel.sourceAlias, inferenceProfile: selectedModel.inferenceProfile };
  store.command(owner, { type: 'control', action: 'start' });
  const ceo = store.list('employees').find(employee => store.level(employee.id) === 'ceo');
  assert.ok(ceo);
  store.command(owner, { type: 'employee.model', employeeId: ceo.id, modelId: selectedModel.sourceAlias, rationale: 'Run this disposable corporate qualification on the selected actual local management model.' });
  const position = store.command(owner, { type: 'position.create', title: 'Fixture note writer', level: 'worker', responsibilities: 'Write bounded fixture notes when assigned.' });
  const employee = store.command(owner, { type: 'employee.hire', name: 'Fixture subordinate', positionId: position.id, homeManagerId: ceo.id, modelId: selectedModel.sourceAlias });
  const project = store.command(owner, { type: 'project.create', name: 'Disposable management recovery', outcome: 'Exercise real scoped corporate commands in this fixture.', acceptance: ['Fixture note exists', 'External contributor acceptance is observed'], supervisorId: ceo.id, rationale: 'Synthetic qualification scenario only.' });
  const productProject = store.command(owner, { type: 'project.create', productId: store.list('products')[0].id, name: 'Disposable PR selection', outcome: 'Retain an explicit synthetic PR selection without dispatching product work.', acceptance: ['Exact nested selection survives the actual management tool wire'], supervisorId: ceo.id, rationale: 'Synthetic schema qualification only; no provider or product execution.' });
  const selectedPullRequest = { number: 7, headSha: 'a'.repeat(40) };
  const pullRequestTitle = 'Inspect the selected synthetic PR';
  const original = store.command(owner, { type: 'assignment.create', employeeId: employee.id, projectId: project.id, title: 'Original broad fixture assignment', instructions: 'Write a fixture note and obtain acceptance by an external contributor.', acceptance: project.acceptance, kind: 'implementation' });
  store.update('assignments', original.id, { status: 'blocked', blockedReason: 'Synthetic missing checkpoint', attempts: 1 });
  const failed = store.put('runs', { employeeId: employee.id, assignmentId: original.id, modelId: employee.modelId, status: 'failed', attempt: 1, tokenRevoked: true, error: 'Synthetic retained failure: no external contributor acceptance exists. No model or implementation was run for this setup record.' });
  const title = 'Write the fixture note only';
  const acceptance = ['fixture-note.md explains the synthetic scenario', 'The note makes no external acceptance claim'];
  const instructions = 'In the fixture workspace, write fixture-note.md explaining the synthetic scenario. Check its contents. Do not claim external contributor acceptance.';
  const remainingPrerequisite = 'An external contributor must actually accept the original fixture note before the broad original assignment can complete.';
  const strategySubject = 'Fixture nested payload qualification';
  // The native Qwen JSON grammar preserves declared property order. Avoid
  // contradicting it with an instruction to copy an object in a different order.
  const payload = { failedRunId: failed.id, failedAssignmentId: original.id, disposition: 'blocked', remainingPrerequisite };
  const task = store.command(owner, { type: 'assignment.create', employeeId: ceo.id, projectId: project.id, title: 'Qualify corporate management recovery', kind: 'management', instructions: 'Read the retained synthetic failure and perform the explicitly requested management changes using real corporate tools.', acceptance: ['Model change and finite assignment are recorded by this run', 'Exact nested strategy fields survive', 'Original acceptance is preserved with a recorded blocked disposition'] });
  store.update('assignments', task.id, { schedulerKey: `fault:${failed.id}`, payload: { failedRunId: failed.id, failedAssignmentId: original.id, baselineModelId: employee.modelId, baselineInstructionsHash: instructionsHash(original.instructions), baselineBlockedReason: 'Synthetic missing checkpoint' } });
  run = store.claimNext({ assignmentId: task.id, workspace });
  assert.ok(run, 'Actual tracked diagnosis must be claimed');
  assert.ok(store.faultContext(run.id), 'Fixture must satisfy the real trusted diagnosis predicate');
  const token = broker.mint(run);
  heartbeat = setInterval(() => store.heartbeat(run!.id), 30_000);
  report.fixture = { runId: run.id, assignmentId: task.id, employeeId: ceo.id, subordinateId: employee.id, projectId: project.id, failedRunId: failed.id, originalAssignmentId: original.id, productProjectId: productProject.id, selectedPullRequest };
  console.log(JSON.stringify({ type: 'fixture.started', root, runId: run.id, catalogSha256: report.catalogSha256 }));
  const result = await runtime.execute({ runId: run.id, employeeId: ceo.id, workspace, modelId: selectedModel.sourceAlias, contextTokens: 32768, timeoutMs: 15 * 60 * 1000,
    signal: controller.signal,
    brokerUrl: `http://${workerHost}/mcp/${run.id}`, token, onSession: sessionId => { store.bindSession(run!.id, sessionId, workspace); },
    system: `You are the active CEO in a disposable OpenCorp corporate-runtime qualification. Every record here is synthetic fixture state. Use corporate tools for the requested persistent changes. Do not use native file/shell tools, product tools, browser, public network, releases or communications. Finish once the requested receipts exist.\n${corporateGuide}`,
    prompt: `Read company_detail for original assignment ${original.id} and failed run ${failed.id}. Then complete all six fixture actions below using actual tools. Do not implement the assigned note or import a PR yourself; no subsequent assignment will be executed by this script. The PR selection in step 6 is synthetic fixture metadata supplied here, not an actual provider PR; do not call a product adapter.
1. Use company_command employee.model to change subordinate employeeId ${employee.id} from ${selectedModel.sourceAlias} to modelId ${small.sourceAlias}. Include a concise nonempty rationale about bounded fixture note work. Put type, employeeId, modelId and rationale directly inside command.
2. Use create_assignment with direct employeeId ${employee.id}, projectId ${project.id}, title ${JSON.stringify(title)}, instructions ${JSON.stringify(instructions)}, acceptance ${JSON.stringify(acceptance)}, kind "implementation", dependencies ${JSON.stringify([original.id])}, payload ${JSON.stringify({sourceAssignmentId:original.id})}. This deliberately models the observed mistaken completion dependency; step 5 must correct that edge using the returned new assignment ID. Preserve the original broad acceptance.
3. Use company_command with type "decision.create" directly inside command, beside kind "strategy", subject ${JSON.stringify(strategySubject)}, a concise nonempty rationale, and exactly this nested payload: ${JSON.stringify(payload)}. The decision payload has exactly four keys: failedRunId, failedAssignmentId, disposition, remainingPrerequisite. sourceAssignmentId belongs only to step 2; do not reuse it for this decision. Copy the shown payload object verbatim; all four keys must be retained in the actual decision.
4. Use record_blocked_diagnosis with a new precise blockedReason explaining the external acceptance prerequisite, an evidence-based rationale, and remainingPrerequisite ${JSON.stringify(remainingPrerequisite)}. Do not requeue or complete the broad original assignment.
5. Use company_command with type "assignment.update" directly inside command, for the NEW finite assignment created in step 2 (use its actual returned ID), with dependencies [] and a nonempty rationale explaining that the original assignment is provenance, not a completion prerequisite for its finite subset. Do not change the original assignment dependencies or acceptance.
6. Use create_assignment with direct employeeId ${employee.id}, projectId ${productProject.id}, title ${JSON.stringify(pullRequestTitle)}, instructions "Inspect and verify only the explicitly assigned PR candidate; preserve its external authorship.", acceptance ["The exact selected candidate is independently reviewed with its external authorship preserved"], kind "implementation", dependencies [], payload ${JSON.stringify({pullRequest:selectedPullRequest})}. This creates only a tracked synthetic management assignment. Do not dispatch or import it. Confirm all six tool receipts, summarize briefly, and end the run.` });
  controller.signal.throwIfAborted();
  report.runtime = { sessionId: result.sessionId, modelId: result.modelId, artifactIdentity: result.artifactIdentity, inferenceProfile: result.inferenceProfile, usage: result.usage, messagesPath: result.messagesPath, diagnosticsPath: result.diagnosticsPath, completion: result.completion };
  const currentRun = store.need('runs', run.id);
  const changedEmployee = store.need('employees', employee.id);
  assert.equal(changedEmployee.modelId, small.sourceAlias);
  assert.equal(changedEmployee.modelChange.runId, run.id);
  assert.equal(changedEmployee.modelChange.priorModelId, selectedModel.sourceAlias);
  const created = store.list('assignments').filter(assignment => assignment.id !== task.id && assignment.title === title);
  assert.equal(created.length, 1, 'Exactly one finite assignment must be created');
  assert.deepEqual({ employeeId: created[0].employeeId, projectId: created[0].projectId, supervisorId: created[0].supervisorId, instructions: created[0].instructions, acceptance: created[0].acceptance, kind: created[0].kind, status: created[0].status, accepted: created[0].accepted }, { employeeId: employee.id, projectId: project.id, supervisorId: ceo.id, instructions, acceptance, kind: 'implementation', status: 'queued', accepted: true });
  assert.deepEqual(created[0].payload, { sourceAssignmentId: original.id }, 'Typed assignment payload fields must survive the complete tool wire');
  assert.deepEqual(created[0].dependencies, [], 'Actual management must correct the deliberately held subset');
  const selected = store.list('assignments').filter(assignment => assignment.title === pullRequestTitle);
  assert.equal(selected.length, 1, 'Exactly one synthetic existing-PR assignment must be selected');
  assert.deepEqual({ employeeId: selected[0].employeeId, projectId: selected[0].projectId, supervisorId: selected[0].supervisorId, kind: selected[0].kind, status: selected[0].status, dependencies: selected[0].dependencies, payload: selected[0].payload }, { employeeId: employee.id, projectId: productProject.id, supervisorId: ceo.id, kind: 'implementation', status: 'queued', dependencies: [], payload: {pullRequest:selectedPullRequest} }, 'Nested PR selection must survive the actual model, native MCP and production command handler');
  assert.equal(selected[0].pullRequestCandidate, undefined, 'This management fixture must not prepare or import a candidate');
  assert.ok(!store.list('runs').some(item => item.assignmentId === selected[0].id), 'Selected synthetic product work must remain undispatched');
  assert.ok(created[0].dependencyDecisions?.some((entry: any) => entry.actorId === ceo.id && entry.runId === run!.id && isDeepStrictEqual(entry.priorDependencies, [original.id]) && isDeepStrictEqual(entry.dependencies, []) && entry.priorStatus === 'queued' && entry.status === 'queued' && entry.rationale?.trim()), 'Dependency correction requires an actual current-run audit with preserved original edges');
  const strategies = store.list('decisions').filter(decision => decision.subject === strategySubject);
  assert.equal(strategies.length, 1);
  assert.equal(strategies[0].runId, run.id);
  assert.deepEqual(strategies[0].payload, payload, 'Named nested payload fields must survive the complete provider/tool wire');
  const retainedOriginal = store.need('assignments', original.id);
  assert.equal(retainedOriginal.status, 'blocked');
  assert.deepEqual(retainedOriginal.acceptance, original.acceptance);
  assert.deepEqual(retainedOriginal.dependencies, original.dependencies);
  assert.notEqual(retainedOriginal.blockedReason, 'Synthetic missing checkpoint');
  const receipt = (type: string, id: string) => currentRun.corporateCommands.some((command: { type: string; id: string }) => command.type === type && command.id === id);
  assert.ok(receipt('employee.model', employee.id) && receipt('assignment.create', created[0].id) && receipt('assignment.create', selected[0].id) && receipt('decision.create', strategies[0].id) && receipt('assignment.update', original.id) && receipt('assignment.update', created[0].id), 'Every mutation must have a receipt from the actual bound run');
  for (const name of ['create_assignment', 'record_blocked_diagnosis']) assert.ok(calls.some(call => call.name === name && call.completed), `${name} must actually execute`);
  const outcome = managementOutcome(store, store.need('assignments', task.id), currentRun);
  assert.ok(outcome.passed, outcome.summary);
  assert.deepEqual(result.inferenceProfile, selectedModel.inferenceProfile);
  assert.ok(result.usage.requests > 0 && result.usage.requests <= 36);
  const bound = JSON.parse(await readFile(join(root, 'runtime', 'employees', run.id, 'binding.json'), 'utf8'));
  assert.equal(bound.sessionId, currentRun.sessionId);
  assert.equal(currentRun.modelId, selectedModel.sourceAlias);
  assert.equal(bound.model.sourceAlias, currentRun.modelId);
  assert.equal(bound.model.contextTokens, 32768);
  assert.equal(bound.model.artifactIdentity, result.artifactIdentity);
  assert.deepEqual(bound.model.inferenceProfile, selectedModel.inferenceProfile);
  const starts = runtimeEvents.filter(event => event.type === 'runtime.inference.started');
  assert.equal(starts.length, result.usage.requests);
  for (const event of starts) {
    const data = event.payload as any;
    assert.deepEqual(data.inferenceProfile, selectedModel.inferenceProfile);
    assert.equal(data.artifactIdentity, result.artifactIdentity);
    if (data.employeeSystem) assert.equal(data.employeeSystem.present, true);
  }
  const messages = JSON.parse(await readFile(result.messagesPath, 'utf8'));
  const toolParts = messages.flatMap((message: { parts: any[] }) => message.parts).filter((part: any) => part.type === 'tool');
  assert.ok(toolParts.length > 0);
  assert.ok(toolParts.every((part: any) => part.tool.startsWith('corporate_') || part.tool === 'todowrite'), 'Management fixture must not use native file, shell or external tools; session checklist metadata is permitted');
  assert.ok(calls.every(call => allowedTools.has(call.name)), 'No external or product adapter may be attempted');
  assert.equal(store.list('actions').length, 0);
  assert.equal(store.list('artifacts').length, 0);
  store.finishRun(run.id, { status: 'succeeded', modelIdentity: result.artifactIdentity, usage: result.usage, messagesPath: result.messagesPath, runtimeDiagnosticsPath: result.diagnosticsPath, managementResult: outcome });
  report.verified = { employeeModelChange: changedEmployee.modelChange, finiteAssignmentId: created[0].id, dependencyDecisions: created[0].dependencyDecisions, nestedStrategyId: strategies[0].id, originalAssignmentStatus: retainedOriginal.status, selectedPullRequestAssignmentId: selected[0].id, selectedPullRequest: selected[0].payload.pullRequest, pullRequestSelectionOnly: true, pullRequestImported: false, managementOutcome: outcome, corporateCommands: currentRun.corporateCommands, actionCount: 0, artifactCount: 0 };
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message : String(error);
  if (error instanceof RuntimeExecutionError) report.runtimeFailure = { code: error.code, evidence: error.evidence, result: error.result };
  if (run) store.finishRun(run.id, { status: 'failed', error: report.error });
  throw error;
} finally {
  if (heartbeat) clearInterval(heartbeat);
  const cleanup = await Promise.allSettled([runtime.stop(), broker.cancel()]);
  if ('closeAllConnections' in server) server.closeAllConnections();
  cleanup.push(...await Promise.allSettled([new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))]));
  report.finishedAt = new Date().toISOString();
  if (controller.signal.aborted) report.cancellationReason = String(controller.signal.reason);
  report.calls = calls;
  report.events = runtimeEvents;
  report.companyDatabase = join(root, 'company.sqlite');
  try { store.close(); } catch (error) { cleanup.push({ status: 'rejected', reason: error }); }
  const cleanupFailures = cleanup.filter(result => result.status === 'rejected').map(result => String(result.reason));
  if (cleanupFailures.length) { report.passed = false; report.cleanupFailures = cleanupFailures; }
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`Corporate runtime verification record: ${reportPath}`);
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', terminate);
}
if (report.cleanupFailures?.length) throw new Error(`Corporate fixture cleanup failed: ${report.cleanupFailures.join('; ')}`);
