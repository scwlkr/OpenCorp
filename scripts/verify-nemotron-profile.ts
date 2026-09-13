import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { LocalRuntime, RuntimeExecutionError } from '../src/runtime/index.js';

export const expectedAction = { type: 'position.propose', sourceId: 'source-fixture-42', departmentId: 'department-fixture-7', headcount: 1, spending: 0 };
export function correctAction(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const action = value as Record<string, unknown>;
  return Object.keys(action).length === Object.keys(expectedAction).length && Object.entries(expectedAction).every(([key, expected]) => action[key] === expected);
}

// SQL projects metadata only: reasoning text is never selected or copied into this report.
export function nativeMetadata(databasePath: string, sessionId: string) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return {
      messages: db.prepare(`SELECT json_extract(data,'$.agent') agent, json_extract(data,'$.finish') finish,
        json_extract(data,'$.tokens.input') inputTokens, json_extract(data,'$.tokens.output') outputTokens,
        json_extract(data,'$.time.completed')-json_extract(data,'$.time.created') durationMs
        FROM message WHERE session_id=? AND json_extract(data,'$.role')='assistant' ORDER BY time_created`).all(sessionId),
      reasoning: db.prepare(`SELECT count(*) parts, sum(json_extract(data,'$.time.end')-json_extract(data,'$.time.start')) durationMs
        FROM part WHERE session_id=? AND json_extract(data,'$.type')='reasoning'`).get(sessionId),
      tools: db.prepare(`SELECT json_extract(data,'$.tool') tool, json_extract(data,'$.state.status') status,
        json_extract(data,'$.state.input.filePath') filePath FROM part WHERE session_id=? AND json_extract(data,'$.type')='tool' ORDER BY time_created`).all(sessionId) as Array<{tool: string; status: string; filePath: string | null}>,
    };
  } finally { db.close(); }
}

async function main() {
  assert.equal(process.argv[2], '--company-drained', 'Start only after the owner coordinator has drained the company: --company-drained');
  const root = await mkdtemp(join(homedir(), '.local/share/opencorp-nemotron-profile-'));
  const report: Record<string, any> = { root, kind: 'isolated-native-tool-profile-ab', productionOutcome: false, startedAt: new Date().toISOString(), arms: [] };
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error('Qualification interrupted'));
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const record = async () => writeFile(join(root, 'qualification.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  try {
    for (const profile of [undefined, 'nemotron-no-thinking-v1'] as const) {
      controller.signal.throwIfAborted();
      const armRoot = join(root, profile ?? 'default');
      const arm: Record<string, any> = { profile: profile ?? 'default', trials: [], bindings: [] }; report.arms.push(arm);
      const runtime = new LocalRuntime({ dataRoot: armRoot, nemotronInferenceProfile: profile, onEvent: event => {
        if (event.type === 'runtime.session.bound') arm.bindings.push(event.payload);
      } });
      try {
        // models() only imports installed source artifacts; unlike installModels(), it cannot pull a missing model.
        await runtime.start();
        assert.ok((await runtime.models()).some(model => model.id === 'nemotron'), 'Installed Nemotron required; downloads forbidden');
        for (const phase of ['cold-provider', 'warm-provider']) {
          controller.signal.throwIfAborted();
          const employeeId = `fixture-${phase}`, workspace = join(armRoot, 'workspaces', employeeId);
          await mkdir(workspace, { recursive: true });
          await writeFile(join(workspace, 'index.json'), JSON.stringify({ sourcePath: 'source.json' }));
          await writeFile(join(workspace, 'source.json'), JSON.stringify({ id: 'source-fixture-42', departmentId: 'department-fixture-7', authorizedHeadcount: 1, spendingLimit: 0 }));
          const trial: Record<string, any> = { phase, passed: false }; arm.trials.push(trial);
          const runId = randomUUID();
          let sessionId: string | undefined;
          const started = Date.now();
          try {
            const result = await runtime.execute({ runId, employeeId, workspace, modelId: 'nemotron', contextTokens: 32768,
              timeoutMs: 5 * 60 * 1000, signal: controller.signal, onSession: id => { sessionId = id; },
              system: 'Disposable native tool qualification. Use native read and write tools only. No shell, external access or corporate tools. Produce only the requested fixture action; do not claim real company work.',
              prompt: 'Use the read tool to inspect missing-source.json first. It is intentionally absent: recover by reading index.json, then use its exact sourcePath to read the source. Write action.json with exactly type="position.propose", sourceId from source.id, departmentId from source, headcount from authorizedHeadcount, spending from spendingLimit. No extra fields. Finish with exactly: FIXTURE_ACTION_RECORDED. Only write action.json.' });
            trial.result = { artifactIdentity: result.artifactIdentity, inferenceProfile: result.inferenceProfile, usage: result.usage, completion: result.completion, diagnosticsPath: result.diagnosticsPath };
            const action = JSON.parse(await readFile(join(workspace, 'action.json'), 'utf8'));
            trial.actionCorrect = correctAction(action);
            trial.finalCorrect = result.text.trim() === 'FIXTURE_ACTION_RECORDED';
          } catch (error) {
            trial.error = error instanceof Error ? error.message : String(error);
            if (error instanceof RuntimeExecutionError) { sessionId ??= error.evidence?.sessionId; trial.failureCode = error.code; }
          } finally {
            trial.durationMs = Date.now() - started;
            if (sessionId) {
              const workerRoot = join(armRoot, 'runtime/employees', runId);
              trial.native = nativeMetadata(join(workerRoot, 'home/data/opencode/opencode.db'), sessionId);
              trial.model = JSON.parse(await readFile(join(workerRoot, 'binding.json'), 'utf8')).model;
            }
            const tools = trial.native?.tools as ReturnType<typeof nativeMetadata>['tools'] | undefined;
            trial.recoveredMissingSource = tools?.some(t => t.tool === 'read' && t.status === 'error' && t.filePath !== null && resolve(workspace, t.filePath) === join(workspace, 'missing-source.json')) === true
              && tools.some(t => t.tool === 'read' && t.status === 'completed' && t.filePath !== null && resolve(workspace, t.filePath) === join(workspace, 'index.json'))
              && tools.some(t => t.tool === 'read' && t.status === 'completed' && t.filePath !== null && resolve(workspace, t.filePath) === join(workspace, 'source.json'));
            trial.toolScopeCorrect = tools?.every(t => t.tool === 'read' || t.tool === 'write' && t.filePath !== null && resolve(workspace, t.filePath) === join(workspace, 'action.json')) === true
              && tools.some(t => t.tool === 'write' && t.status === 'completed' && t.filePath !== null && resolve(workspace, t.filePath) === join(workspace, 'action.json'));
            trial.passed = trial.toolScopeCorrect && trial.actionCorrect === true && trial.finalCorrect === true && trial.recoveredMissingSource;
            await record();
          }
        }
      } finally { await runtime.stop(); arm.stopped = true; await record(); }
    }
    report.passed = report.arms.every((arm: any) => arm.trials.length === 2 && arm.trials.every((trial: any) => trial.passed));
  } finally {
    report.finishedAt = new Date().toISOString(); await record();
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    console.log(`Qualification report: ${join(root, 'qualification.json')}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
