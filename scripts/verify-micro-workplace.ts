import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, constants } from 'node:fs';
import { copyFile, link, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { cpus, freemem, homedir, loadavg, totalmem } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { OwnerClient, dataDirectory } from '../src/cli/client.js';
import type { Assignment, CompanySnapshot, Employee, EmployeeRun } from '../src/core/types.js';
import { recordSocialResponse, socialContext, socialSystemPrompt, workplaceCommand, type WorkplaceEvent } from '../src/core/workplace.js';
import { LocalRuntime, RuntimeExecutionError, executeSandboxed, MODEL_ALIASES, type LocalModel, type RuntimeEvent, type RuntimeResult } from '../src/runtime/index.js';
import { CompanyStore } from '../src/storage/store.js';
import { localModelSelectionId } from '../src/runtime/ollama.js';
import { microWorkplaceStrongProfile, assertMicroStrongProfileEvidence, microWorkplaceEvidence, microReadEvidence, microWorkplaceStage } from './micro-workplace-evidence.js';
import { observeHostMemory } from '../src/runtime/resource-budget.js';

// Finite qualification only. The real company's API is read-only; there is no
// configurable output root, install, download, production command, or scheduler.
const { values } = parseArgs({ strict: true, allowPositionals: false, options: {
  stage: { type: 'string', default: 'all' }, 'source-data-root': { type: 'string' }, 'model-store': { type: 'string', multiple: true },
  'micro-model': { type: 'string', default: 'micro-06' }, 'strong-model': { type: 'string', default: 'qwen-main' },
  'turn-timeout-seconds': { type: 'string', default: '180' }, 'min-free-gib': { type: 'string', default: '2' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('verify-micro-workplace.ts [--stage initial|ten|all|mixed-ten] [--source-data-root PATH] [--model-store PATH ...] [--micro-model micro-06|micro-17|micro-4] [--strong-model qwen-main|nemotron|qwen-main-48k] [--turn-timeout-seconds 30..300] [--min-free-gib 1..32]\nReads an already paused/stopped live company with its owned inference pools stopped. Initial stage requires six real employees; ten/all require ten; mixed-ten requires eleven. Reuses existing local weights only. Runs isolated 5-person birthday, 10-person office-party, then 5-micro + 1-strong productive fixture trials and one serial micro native-read fixture. Retains actual messages and raw timing evidence in a new private qualification directory. Initial runs five-birthday, five+strong, and micro native-read; ten runs only ten-office-party; all runs the original trials; mixed-ten runs ten social turns released after strong generated content begins, with one productive fixture. No production writes or model downloads.');
  process.exit(0);
}
const stage = values.stage!, plan = microWorkplaceStage(stage);
const requestedTrials = [...plan.trials, ...(plan.microTool ? ['micro-native-read'] : [])];
assert.equal(process.versions.node, '24.20.0', 'Use pinned Node 24.20.0');
assert.ok(['micro-06', 'micro-17', 'micro-4'].includes(values['micro-model']!));
const strongProfile = microWorkplaceStrongProfile(values['strong-model']!);
const timeoutMs = Number(values['turn-timeout-seconds']) * 1000, reserveBytes = Number(values['min-free-gib']) * 1024 ** 3;
assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 30000 && timeoutMs <= 300000, 'Turn timeout must be 30–300 seconds');
assert.ok(Number.isFinite(reserveBytes) && reserveBytes >= 1024 ** 3 && reserveBytes <= 32 * 1024 ** 3, 'Free-memory reserve must be 1–32 GiB');
const sourceRoot = await realpath(dataDirectory(values['source-data-root']));
const root = await mkdtemp(join(homedir(), '.local/share/opencorp-micro-workplace-'));
assert.ok(relative(sourceRoot, await realpath(root)).startsWith('..'), 'Qualification root must be outside the production data root');
const client = new OwnerClient(sourceRoot), owner = { kind: 'owner' } as const;
const store = new CompanyStore(root), staging = join(root, 'source-models'), reportPath = join(root, 'qualification.json');
const report: Record<string, any> = { kind: 'isolated-real-employee-identity-micro-qualification', root, sourceRoot, startedAt: new Date().toISOString(),
  stage, requestedTrials, allContractTrialsIncluded: stage === 'all', productionWrites: false, newProductionHires: false, modelDownloads: false, actualProductionEvent: false, productDelivery: false,
  host: { platform: process.platform, architecture: process.arch, cpu: cpus()[0]?.model, totalMemoryBytes: totalmem() },
  requestedMicroModel: values['micro-model'], requestedStrongModel: values['strong-model'], timeoutMs, reserveBytes, trials: [], qualified: false,
  reviewRequired: 'Read actual messages for coherence, compare observed stream interleaving and host pressure, and independently review before selecting a production concurrency limit.' };
const signal = new AbortController();
const interrupt = () => signal.abort(new Error('Qualification interrupted; stop owned processes and retain evidence'));
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
let currentRuntime: LocalRuntime | undefined;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const save = () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
const systemRead = promisify(execFile);

function assertSourceIdle(snapshot: CompanySnapshot): void {
  assert.ok(['paused', 'stopped'].includes(snapshot.company.state), 'Live company must already be paused/stopped; this script does not change production controls');
  assert.ok(!snapshot.runs.some(run => ['running', 'cancelling', 'queued', 'uncertain'].includes(run.status)), 'Live employee runs must already be quiescent');
  const runtime = snapshot.resources.runtime;
  assert.ok(!runtime?.activeRuns?.length, 'Production runtime still retains active employee turns');
  assert.ok(runtime?.ollama?.running === false && (!runtime.microOllama || runtime.microOllama.running === false), 'Production inference pools must already be stopped to avoid duplicate resident weights; the Owner API can remain online');
}

/** Copies only selected immutable model artifacts into private staging. */
async function stageModels(): Promise<void> {
  const sources = values['model-store']?.length ? values['model-store'].map(path => resolve(path)) :
    [join(sourceRoot, 'runtime/ollama/models'), join(sourceRoot, 'runtime/ollama-micro/models'), join(homedir(), '.ollama/models')];
  report.modelSources = [];
  for (const id of [values['micro-model']!, ...(plan.needsStrongModel ? [strongProfile.sourceId] : [])] as Array<keyof typeof MODEL_ALIASES>) {
    const alias = MODEL_ALIASES[id], [name, version] = alias.split(':');
    let imported = false;
    for (const source of sources) {
      signal.signal.throwIfAborted();
      const manifest = join(source, 'manifests/registry.ollama.ai/library', name, version);
      let raw: Buffer;
      try { assert.ok((await lstat(manifest)).isFile(), 'Manifest must be a regular file'); raw = await readFile(manifest); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      const parsed = JSON.parse(raw.toString()) as { config: { digest: string; size: number }; layers: Array<{ digest: string; size: number }> };
      assert.ok(Array.isArray(parsed.layers) && parsed.config, 'Invalid source model manifest');
      await mkdir(join(staging, 'blobs'), { recursive: true, mode: 0o700 });
      for (const blob of [...parsed.layers, parsed.config]) {
        assert.match(blob.digest, /^sha256:[a-f0-9]{64}$/); assert.ok(Number.isSafeInteger(blob.size) && blob.size >= 0);
        const filename = blob.digest.replace(':', '-'), from = join(source, 'blobs', filename), to = join(staging, 'blobs', filename);
        const entry = await lstat(from); assert.ok(entry.isFile() && entry.size === blob.size, `Incomplete source layer ${filename}`);
        try { await link(from, to); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EXDEV') await copyFile(from, to, constants.COPYFILE_FICLONE);
          else if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          assert.equal((await lstat(to)).size, blob.size);
        }
      }
      const target = join(staging, 'manifests/registry.ollama.ai/library', name, version);
      await mkdir(dirname(target), { recursive: true }); await writeFile(target, raw, { mode: 0o600 });
      report.modelSources.push({ id, alias, source, manifestDigest: hash(raw), bytes: parsed.layers.reduce((sum, blob) => sum + blob.size, 0) });
      imported = true; break;
    }
    assert.ok(imported, `Existing local ${alias} weights are required. Supply --model-store; this script never downloads models.`);
  }
}

function cloneIdentity(snapshot: CompanySnapshot): Employee[] {
  const active = snapshot.employees.filter(employee => employee.status === 'active');
  assert.ok(active.length >= plan.minimumEmployees, `${plan.minimumEmployees} actual persistent employees are required for ${stage}; live company currently has ${active.length}`);
  store.put('company', { id: randomUUID(), name: `${snapshot.company.name} — isolated qualification copy`, state: 'running', bootstrap: 'qualification',
    mandate: 'Explicitly isolated qualification scenarios; no production decisions, delivery, events, or new hires.', sourceCompanyId: snapshot.company.id, qualification: true });
  store.put('policy', { ...snapshot.policy, id: randomUUID(), revision: 1, companyId: store.company.id, maxInference: 11, nativeJobs: 1, localOnly: true, spendingLimit: 0, allowedRepositories: [], concurrencyQualification: undefined, qualification: true });
  for (const department of snapshot.departments) store.put('departments', department);
  for (const position of snapshot.positions) store.put('positions', position);
  for (const employee of snapshot.employees) store.put('employees', { ...employee, qualificationCopy: true, sourceCompanyId: snapshot.company.id, sourceModelId: employee.modelId });
  for (const appointment of snapshot.appointments) store.put('appointments', appointment);
  for (const version of snapshot.roleVersions) store.put('roleVersions', version);
  report.source = { companyId: snapshot.company.id, state: snapshot.company.state, activeEmployeeCount: active.length, observedAt: new Date().toISOString(),
    identitySha256: hash(JSON.stringify({ employees: snapshot.employees, positions: snapshot.positions, departments: snapshot.departments, appointments: snapshot.appointments })) };
  report.participants = active.slice(0, plan.minimumEmployees).map(employee => ({ id: employee.id, name: employee.name, positionId: employee.positionId, departmentId: employee.departmentId, formedAt: employee.createdAt }));
  return active.slice(0, plan.minimumEmployees);
}

async function trial(name: string, participants: Employee[], count: 5 | 10, mixed: boolean): Promise<void> {
  signal.signal.throwIfAborted(); assertSourceIdle(await client.state());
  const startedAt = Date.now(), deadline = new AbortController(), turnSignal = AbortSignal.any([signal.signal, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(new Error('Bounded trial deadline reached')), timeoutMs + 60000);
  const gated = name === 'mixed-productive-and-ten';
  let strongRunId: string | undefined, releaseSocial!: () => void;
  const strongContent = new Promise<void>(resolve => { releaseSocial = resolve; });
  const events: RuntimeEvent[] = [], samples: Record<string, unknown>[] = [];
  const evidence: Record<string, any> = { name, count, mixed, startedAt: new Date(startedAt).toISOString(), runs: [], samples,
    kind: 'qualification-only attributed employee turns', schedulerQualification: false, directRuntimeDispatch: true };
  report.trials.push(evidence); await save();
  const runtime = currentRuntime = new LocalRuntime({ dataRoot: root, modelStore: staging,
    resourceBudget: { maxConcurrentTurns: count + 1, maxSocialTurns: count, maxLoadedModels: 2, minFreeMemoryBytes: reserveBytes },
    onEvent: event => {
      if (gated && event.runId === strongRunId && event.type === 'runtime.inference.first_content' && evidence.socialReleaseAt === undefined) { evidence.socialReleaseAt = Date.now(); evidence.strongFirstContent = event.payload; releaseSocial(); }
      events.push(event); store.emit(event.type, { runId: event.runId, payload: event.payload }); appendFileSync(join(root, `${name}.events.jsonl`), JSON.stringify({ at: Date.now(), ...event }) + '\n', { mode: 0o600 }); },
  });
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= runtime.stop();
  const cancelRuntime = () => { void stop().catch(error => { evidence.stopError = String(error); signal.abort(error); }); };
  turnSignal.addEventListener('abort', cancelRuntime, { once: true });
  let sampleTask: Promise<void> | undefined;
  let sampling = false, sampleTimer: ReturnType<typeof setInterval> | undefined;
  const sample = async () => {
    if (sampling) return; sampling = true;
    const at = Date.now(), memory = observeHostMemory(), observation: Record<string, any> = { at, freeMemoryBytes: freemem(), totalMemoryBytes: totalmem(), hostMemory: memory, loadAverage: loadavg() };
    try {
      const source = await client.state(AbortSignal.timeout(5000)); observation.ownerResponseMs = Date.now() - at; assertSourceIdle(source);
      if (process.platform === 'darwin') {
        const reads = await Promise.allSettled([
          systemRead('/usr/bin/vm_stat', [], { timeout: 2000, maxBuffer: 65536 }),
          systemRead('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { timeout: 2000, maxBuffer: 4096 }),
          systemRead('/usr/sbin/sysctl', ['-n', 'vm.swapusage'], { timeout: 2000, maxBuffer: 4096 }),
        ]);
        observation.vmStat = reads[0].status === 'fulfilled' ? reads[0].value.stdout : String(reads[0].reason);
        observation.memoryPressureLevel = reads[1].status === 'fulfilled' ? Number(reads[1].value.stdout.trim()) : null;
        observation.swapUsage = reads[2].status === 'fulfilled' ? reads[2].value.stdout : String(reads[2].reason);
      }
      if ((memory.available ?? memory.free) < reserveBytes || memory.pressure === 'elevated' || observation.memoryPressureLevel >= 2) throw new Error('Observed host memory reserve/pressure refusal');
    } catch (error) { observation.error = String(error); deadline.abort(error); }
    finally { samples.push(observation); sampling = false; }
  };
  const sampleOnce = () => sampleTask ??= sample().finally(() => { sampleTask = undefined; });
  try {
    await sampleOnce(); turnSignal.throwIfAborted();
    sampleTimer = setInterval(() => void sampleOnce(), 5000);
    const models = (await runtime.models()).filter((model): model is LocalModel => model.local); turnSignal.throwIfAborted();
    for (const model of models) store.put('models', { ...model, id: localModelSelectionId(model), name: localModelSelectionId(model) === model.id ? model.name : model.sourceAlias, sizeClass: model.id.startsWith('micro-') ? 'micro' : 'large' });
    const micro = models.find(model => model.id === values['micro-model']), strong = models.find(model => model.id === values['strong-model']);
    assert.ok(micro && (!mixed || strong), 'Exact local artifacts required by this trial must be present'); evidence.models = { micro, ...(mixed ? { strong } : {}) }; evidence.runtime = runtime.status();
    const channel = workplaceCommand(store, owner, { type: 'workplace.channel.create', name: 'Qualification common room' }) as { id: string };
    workplaceCommand(store, owner, { type: 'workplace.configure', maxConcurrentSocial: count, microModelId: micro.sourceAlias });
    const created = workplaceCommand(store, owner, { type: 'workplace.event.create', title: `${name}: isolated qualification context`,
      purpose: gated ? 'Suggest one playful feature for an imaginary virtual break room and briefly say why. Describe it as an idea, not an existing place or completed work. Another employee is performing an isolated coding fixture.' : mixed ? 'Share a brief thought while another employee performs an explicitly isolated coding fixture.' : count === 5 ? 'A fictional AI birthday gathering used only to qualify local conversational turns.' : 'An explicitly simulated office party for local conversation qualification. The conversation topic is an imaginary virtual break room: suggest one playful feature and briefly say why you would choose it. Describe it as an idea, not an existing place or completed work.',
      channelId: channel.id, hostId: participants[0].id, participantIds: participants.slice(1, count).map(employee => employee.id),
      eventType: count === 5 && !mixed ? 'fictional_birthday' : 'office_party', subjectEmployeeId: count === 5 && !mixed ? participants[0].id : undefined,
      scheduledAt: new Date().toISOString(), durationMinutes: Math.ceil(timeoutMs / 60000) + 2, maxTurnsPerParticipant: 1, recurrence: 'none' }) as WorkplaceEvent;
    // Direct fixture activation is explicit. It does not claim scheduler/event-trigger qualification.
    const event = store.update('experiences', created.id, { status: 'active', occurrence: 1, startedAt: new Date().toISOString(), activeUntil: new Date(Date.now() + timeoutMs + 60000).toISOString(), qualification: true });
    evidence.eventId = event.id;
    const tasks: Array<{ assignment: Assignment; employee: Employee; model: LocalModel }> = participants.slice(0, count).map(employee => ({ employee, model: micro,
      assignment: store.put('assignments', { employeeId: employee.id, supervisorId: employee.homeManagerId ?? employee.id, projectId: null, title: `${name}: ${employee.name}`,
        instructions: `This is an explicitly isolated AI workplace qualification scenario, not a real company event or human biography. ${event.purpose} Write one natural two-to-four sentence chat message in your own voice. Do not invent completed work or shared memories. No tools, assignments, artifacts, or claims that this happened in the production company.`,
        acceptance: [], dependencies: [], status: 'queued', priority: -100, attempts: 0, corrections: 0, kind: 'social', availableAt: new Date().toISOString(), accepted: true,
        payload: { eventId: event.id, channelId: channel.id, occurrence: 1, turn: 1, modelId: micro.sourceAlias }, qualification: true }) }));
    if (mixed) {
      const employee = participants[count];
      store.update('employees', employee.id, { modelId: localModelSelectionId(strong!), qualificationModelOverride: true });
      tasks.push({ employee, model: strong!, assignment: store.put('assignments', { employeeId: employee.id, supervisorId: employee.homeManagerId ?? employee.id, projectId: null,
        title: 'Build a qualification department-summary utility', instructions: 'Create department-summary.mjs in this fixture workspace. Read departments.json with Node fs and print one JSON object {departments,employees}, counting array entries and summing their employees fields. Run it with node department-summary.mjs and inspect the actual output. No extra files or dependencies. This is a bounded coding fixture, not production software or company delivery.',
        acceptance: ['The employee-created utility computes actual fixture counts'], dependencies: [], status: 'queued', priority: 10, attempts: 0, corrections: 0, kind: 'implementation', availableAt: new Date().toISOString(), accepted: true, qualification: true }) });
    }
    let bound = 0, release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const waitForPeers = async () => {
      if (++bound === (gated ? count : tasks.length)) release();
      await new Promise<void>((resolve, reject) => {
        const cancel = () => reject(turnSignal.reason); turnSignal.addEventListener('abort', cancel, { once: true });
        void barrier.then(() => { turnSignal.removeEventListener('abort', cancel); resolve(); });
        if (turnSignal.aborted) cancel();
      });
    };
    if (gated) tasks.sort((a, b) => Number(b.assignment.kind === 'implementation') - Number(a.assignment.kind === 'implementation'));
    const results = await Promise.all(tasks.map(async task => {
      let run: EmployeeRun | undefined, heartbeat: ReturnType<typeof setInterval> | undefined;
      const began = Date.now(), outcome: Record<string, any> = { employeeId: task.employee.id, assignmentId: task.assignment.id, modelId: task.model.id, beganAt: began };
      evidence.runs.push(outcome);
      try {
        turnSignal.throwIfAborted();
        if (gated && task.assignment.kind === 'social') await new Promise<void>((resolve, reject) => {
          const cancel = () => reject(turnSignal.reason); turnSignal.addEventListener('abort', cancel, { once: true });
          void strongContent.then(() => { turnSignal.removeEventListener('abort', cancel); resolve(); });
          if (turnSignal.aborted) cancel();
        });
        const workspace = join(root, 'workspaces', task.assignment.id); await mkdir(workspace, { recursive: true });
        if (task.assignment.kind === 'implementation') await writeFile(join(workspace, 'departments.json'), JSON.stringify([{ name: 'Research', employees: 3 }, { name: 'Operations', employees: 4 }, { name: 'Culture', employees: 2 }]));
        run = store.claimNext({ assignmentId: task.assignment.id, workspace }); assert.ok(run, 'Qualification assignment was not admitted'); outcome.runId = run.id; outcome.bindingPath = join(root, 'runtime/employees', run.id, 'binding.json'); outcome.contextTokens = task.assignment.kind === 'social' ? 16384 : strongProfile.contextTokens;
        if (gated && task.assignment.kind === 'implementation') { strongRunId = run.id; evidence.strongRunId = run.id; }
        heartbeat = setInterval(() => { try { store.heartbeat(run!.id); } catch (error) { deadline.abort(error); } }, 10000);
        const result = await runtime.execute({ runId: run.id, employeeId: task.employee.id, workspace, modelId: task.model.id,
          workload: task.assignment.kind === 'social' ? 'social' : 'productive', contextTokens: task.assignment.kind === 'social' ? 16384 : strongProfile.contextTokens, timeoutMs, signal: turnSignal,
          system: task.assignment.kind === 'social' ? socialSystemPrompt(store, task.assignment.id) : `You are ${task.employee.name}, actual persistent AI employee ${task.employee.id}, temporarily represented in an isolated qualification copy. Role: ${task.employee.role.slice(0,1200)}. Perform the requested coding fixture using native tools in the supplied workspace; do not claim production delivery.`,
          prompt: `${task.assignment.instructions}\n${task.assignment.kind === 'social' ? `Recent actual qualification chat:\n${socialContext(store, task.assignment.id)}` : ''}`,
          onSession: async sessionId => { store.bindSession(run!.id, sessionId, workspace); if (!gated || task.assignment.kind === 'social') await waitForPeers(); },
        });
        if (task.assignment.kind !== 'social') assertMicroStrongProfileEvidence(task.model, result, JSON.parse(await readFile(outcome.bindingPath, 'utf8')));
        assert.ok(result.usage.requests > 0 && result.text.trim() && !result.completion.exhausted, 'Actual completed local-model output is required');
        outcome.result = result;
        store.update('runs', run.id, { text: result.text, modelIdentity: result.artifactIdentity, usage: result.usage, messagesPath: result.messagesPath, runtimeCompletion: result.completion, runtimeDiagnosticsPath: result.diagnosticsPath });
        if (task.assignment.kind === 'social') recordSocialResponse(store, run.id, result.text);
        else await checkProductiveFixture(run, workspace, result, outcome, turnSignal);
        store.finishRun(run.id, { status: 'succeeded', text: result.text, managementResult: { summary: 'Actual isolated qualification output retained; not production delivery.' } });
        outcome.status = store.need('runs', run.id).status;
        if (gated && task.assignment.kind === 'implementation' && evidence.socialReleaseAt === undefined) deadline.abort(new Error('Strong task ended without observed generated content; social turns were not released'));
      } catch (error) {
        if (gated || bound < tasks.length) deadline.abort(error);
        outcome.error = String(error); outcome.status = turnSignal.aborted ? 'interrupted' : 'failed';
        if (error instanceof RuntimeExecutionError) outcome.runtimeFailure = error.evidence ?? error.result;
        if (run) store.finishRun(run.id, { status: outcome.status, error: outcome.error });
      } finally { if (heartbeat) clearInterval(heartbeat); outcome.settledAt = Date.now(); outcome.durationMs = Date.now() - began; }
      return outcome;
    }));
    evidence.completedTurns = results.filter(result => result.status === 'succeeded').length;
    evidence.messages = store.list('messages').filter(message => message.eventId === event.id);
    store.update('experiences', event.id, { status: 'completed', endedAt: new Date().toISOString(), actualMessageCount: evidence.messages.length, qualificationResult: 'Session ended; inspect actual outputs and failures' });
  } catch (error) { evidence.error = String(error); evidence.observedRefusal = turnSignal.aborted ? String(turnSignal.reason) : null; }
  finally {
    clearTimeout(timer); if (sampleTimer) clearInterval(sampleTimer);
    evidence.cancellationReason = deadline.signal.aborted ? String(deadline.signal.reason) : null;
    deadline.abort(new Error('Bounded trial ended')); await sampleTask;
    try { await stop(); evidence.ownedPoolsStopped = true; } catch (error) { evidence.ownedPoolsStopped = false; evidence.stopError = String(error); signal.abort(error); }
    turnSignal.removeEventListener('abort', cancelRuntime);
    currentRuntime = undefined; evidence.overlap = microWorkplaceEvidence(events);
    if (gated) {
      evidence.publicOutputOverlap = microWorkplaceEvidence(events, true);
      evidence.strongSocialPublicInterleavedPairs = evidence.publicOutputOverlap.interleavedPairs.filter((pair: { firstRunId: string; secondRunId: string }) => pair.firstRunId === strongRunId || pair.secondRunId === strongRunId);
    }
    evidence.finishedAt = new Date().toISOString();
    await writeFile(join(root, `${name}.json`), JSON.stringify(evidence, null, 2), { mode: 0o600 }); await save();
    console.log(JSON.stringify({ name, completedTurns: evidence.completedTurns ?? 0, peakContentStreams: evidence.overlap.peakOverlappingContentStreams, error: evidence.error, root }));
  }
}

/** Separate narrow tool/role qualification; social-model success does not imply tool support. */
async function microToolTrial(employee: Employee): Promise<void> {
  signal.signal.throwIfAborted(); assertSourceIdle(await client.state());
  const deadline = new AbortController(), turnSignal = AbortSignal.any([signal.signal, deadline.signal]);
  const runtime = currentRuntime = new LocalRuntime({ dataRoot: root, modelStore: staging,
    resourceBudget: { maxConcurrentTurns: 1, maxSocialTurns: 1, maxLoadedModels: 1, minFreeMemoryBytes: reserveBytes } });
  const evidence: Record<string, any> = { kind: 'isolated-micro-native-read', employeeId: employee.id, startedAt: new Date().toISOString(), passed: false, productionWrites: false };
  report.microToolTrial = evidence; await save();
  let run: EmployeeRun | undefined, heartbeat: ReturnType<typeof setInterval> | undefined, sampling = false;
  let stopping: Promise<void> | undefined; const stop = () => stopping ??= runtime.stop();
  const cancel = () => { void stop().catch(error => { evidence.stopError = String(error); signal.abort(error); }); };
  turnSignal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => deadline.abort(new Error('Micro native-read trial deadline reached')), timeoutMs + 60000);
  const sourceTimer = setInterval(() => { if (sampling) return; sampling = true;
    void client.state(AbortSignal.timeout(5000)).then(snapshot => { assertSourceIdle(snapshot); const memory = observeHostMemory();
      if ((memory.available ?? memory.free) < reserveBytes || memory.pressure === 'elevated') throw new Error('Micro native-read host memory refusal');
    }).catch(error => deadline.abort(error)).finally(() => { sampling = false; });
  }, 5000);
  try {
    const model = (await runtime.models()).find(model => model.id === values['micro-model']); assert.ok(model, 'Exact installed micro model required');
    evidence.model = model; evidence.advertisedToolSupport = model.capabilities.includes('tools');
    store.put('models', { ...model, id: model.sourceAlias, name: model.sourceAlias });
    store.update('employees', employee.id, { modelId: model.sourceAlias, qualificationModelOverride: true });
    const assignment = store.put('assignments', { employeeId: employee.id, supervisorId: employee.homeManagerId ?? employee.id, projectId: null,
      title: 'Read a departmental queue record for isolated micro tool qualification', kind: 'assessment', instructions: 'Read queue.json using the native read tool; return only the exact JSON record.',
      acceptance: ['Actual completed native read and accurate fixture values'], dependencies: [], status: 'queued', priority: 10, attempts: 0, corrections: 0, availableAt: new Date().toISOString(), accepted: true, qualification: true });
    const workspace = join(root, 'workspaces', assignment.id), file = join(workspace, 'queue.json');
    const expected = { requestId: randomUUID(), department: 'Research', pendingItems: 7 };
    await mkdir(workspace, { recursive: true }); await writeFile(file, JSON.stringify(expected), { mode: 0o600 });
    turnSignal.throwIfAborted(); run = store.claimNext({ assignmentId: assignment.id, workspace }); assert.ok(run, 'Micro fixture assignment admission failed');
    evidence.runId = run.id; evidence.assignmentId = assignment.id; evidence.fixture = { file, sha256: hash(JSON.stringify(expected)) };
    heartbeat = setInterval(() => { try { store.heartbeat(run!.id); } catch (error) { deadline.abort(error); } }, 10000);
    const result = await runtime.execute({ runId: run.id, employeeId: employee.id, workspace, modelId: model.id, workload: 'productive', contextTokens: 16384, timeoutMs, signal: turnSignal,
      system: `You are ${employee.name}, persistent AI employee ${employee.id}, in an isolated qualification copy. Perform a narrow department queue lookup using the native read tool. No writes, external effects, or claims of production delivery.`,
      prompt: `Use the native read tool to read ${file}. Return only one JSON object containing exactly the file's requestId, department, and pendingItems values. Do not guess the values.`,
      onSession: sessionId => { store.bindSession(run!.id, sessionId, workspace); } });
    evidence.result = result;
    store.update('runs', run.id, { text: result.text, modelIdentity: result.artifactIdentity, usage: result.usage, messagesPath: result.messagesPath, runtimeCompletion: result.completion, runtimeDiagnosticsPath: result.diagnosticsPath });
    assert.ok(result.usage.requests > 0 && !result.completion.exhausted, 'Actual completed local micro inference required');
    evidence.check = microReadEvidence(JSON.parse(await readFile(result.messagesPath, 'utf8')), result.sessionId, file, expected, result.text);
    assert.equal(hash(await readFile(file)), evidence.fixture.sha256, 'Read-only fixture source changed');
    turnSignal.throwIfAborted(); store.finishRun(run.id, { status: 'succeeded', text: result.text, managementResult: { summary: 'Observed isolated native read and exact departmental record; narrow capability only.' } });
    evidence.passed = true;
  } catch (error) {
    evidence.error = String(error); evidence.status = turnSignal.aborted ? 'interrupted' : 'failed';
    if (error instanceof RuntimeExecutionError) evidence.runtimeFailure = error.evidence ?? error.result;
    if (run) store.finishRun(run.id, { status: evidence.status, error: evidence.error });
  } finally {
    clearTimeout(timer); clearInterval(sourceTimer); if (heartbeat) clearInterval(heartbeat);
    try { await stop(); evidence.ownedPoolsStopped = true; } catch (error) { evidence.stopError = String(error); evidence.ownedPoolsStopped = false; signal.abort(error); }
    turnSignal.removeEventListener('abort', cancel); currentRuntime = undefined; evidence.finishedAt = new Date().toISOString();
    await save(); console.log(JSON.stringify({ name: 'micro-native-read', passed: evidence.passed, error: evidence.error, root }));
  }
}

async function checkProductiveFixture(run: EmployeeRun, workspace: string, result: RuntimeResult, outcome: Record<string, any>, turnSignal: AbortSignal): Promise<void> {
  const file = join(workspace, 'department-summary.mjs'); assert.ok((await lstat(file)).isFile(), 'Employee utility missing');
  const code = await readFile(file), checks = [];
  for (const data of [[{ name: 'Research', employees: 3 }, { name: 'Operations', employees: 4 }, { name: 'Culture', employees: 2 }], [{ name: 'Support', employees: 11 }, { name: 'Design', employees: 7 }], []]) {
    await writeFile(join(workspace, 'departments.json'), JSON.stringify(data));
    const verified = await executeSandboxed({ dataRoot: root, workspace, command: [process.execPath, 'department-summary.mjs'], timeoutMs: 10000, signal: turnSignal });
    checks.push({ data, verified }); assert.equal(verified.code, 0, verified.stderr);
    assert.deepEqual(JSON.parse(verified.stdout), { departments: data.length, employees: data.reduce((sum, department) => sum + department.employees, 0) });
  }
  outcome.productiveFixtureCheck = { file, sha256: hash(code), checks, productionArtifact: false, independentlyReviewed: false };
  store.put('artifacts', { assignmentId: run.assignmentId, employeeId: run.employeeId, projectId: null, runId: run.id, kind: 'analysis', uri: file, identity: hash(code),
    summary: 'Actual employee-created qualification utility; requires independent review and is not production delivery.', checks, qualification: true, modelIdentity: result.artifactIdentity });
}

try {
  const snapshot = await client.state(); assertSourceIdle(snapshot); const employees = cloneIdentity(snapshot);
  await stageModels(); await save();
  for (const name of plan.trials) await trial(name, employees, name === 'ten-office-party' || name === 'mixed-productive-and-ten' ? 10 : 5, name.startsWith('mixed-productive-and-'));
  if (plan.microTool) await microToolTrial(employees[0]);
  report.executedTrials = [...report.trials.filter((item: Record<string, any>) => item.finishedAt).map((item: Record<string, any>) => item.name), ...(report.microToolTrial?.finishedAt ? ['micro-native-read'] : [])];
  report.finishedFiniteTrials = JSON.stringify(report.executedTrials) === JSON.stringify(requestedTrials);
  report.executionChecksPassed = report.finishedFiniteTrials && report.trials.every((item: Record<string, any>) => item.completedTurns === item.count + (item.mixed ? 1 : 0) && item.ownedPoolsStopped);
  report.microToolSupportPassed = plan.microTool ? report.microToolTrial?.passed === true && report.microToolTrial?.ownedPoolsStopped === true : null;
  if (!report.executionChecksPassed || plan.microTool && !report.microToolSupportPassed) process.exitCode = 1;
} catch (error) { report.error = String(error); process.exitCode = 1; }
finally {
  signal.abort(new Error('Qualification finished'));
  try { await currentRuntime?.stop(); } catch (error) { report.stopError = String(error); process.exitCode = 1; }
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
  report.executedTrials = [...report.trials.filter((item: Record<string, any>) => item.finishedAt).map((item: Record<string, any>) => item.name), ...(report.microToolTrial?.finishedAt ? ['micro-native-read'] : [])];
  report.finishedAt = new Date().toISOString(); report.runs = store.list('runs'); report.messages = store.list('messages'); report.events = store.list('experiences').filter(record => record.kind === 'workplace.event');
  await save(); store.close(); console.log(`Retained qualification evidence: ${reportPath}`);
}
