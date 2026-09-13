import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { LocalRuntime, RuntimeExecutionError } from '../src/runtime/index.js';
import { expectedAction, nativeMetadata } from './verify-nemotron-profile.js';

const sourceSchema = z.object({ sourceId: z.literal('source-fixture-42') }).strict();
const actionSchema = z.object({ type: z.literal('position.propose'), sourceId: z.literal('source-fixture-42'),
  departmentId: z.literal('department-fixture-7'), headcount: z.literal(1), spending: z.literal(0) }).strict();
export const fixtureTools = [
  { name: 'fixture_source_read', description: 'Read the exact authorized source record before proposing an action.', inputSchema: z.toJSONSchema(sourceSchema) },
  { name: 'fixture_action', description: 'Validate and retain one disposable structured action. Correct validation errors and retry; this performs no real company action.', inputSchema: z.toJSONSchema(actionSchema) },
];
export function corporateFixture() {
  let sourceRead = false;
  const calls: Array<{ name: string; accepted: boolean; validationError: boolean }> = [];
  let action: unknown;
  return {
    calls,
    get action() { return action; },
    call(name: string, args: unknown) {
      try {
        let output: unknown;
        if (name === 'fixture_source_read') {
          sourceSchema.parse(args); sourceRead = true;
          output = { id: expectedAction.sourceId, departmentId: expectedAction.departmentId, authorizedHeadcount: 1, spendingLimit: 0 };
        } else if (name === 'fixture_action') {
          const parsed = actionSchema.parse(args);
          if (!sourceRead) throw new Error('Read fixture_source_read before submitting an action.');
          if (action) throw new Error('An action is already retained; do not duplicate it.');
          action = parsed; output = { retained: true, receipt: 'FIXTURE_ACTION_RECORDED' };
        } else throw new Error('Unknown fixture tool');
        calls.push({ name, accepted: true, validationError: false });
        return { content: [{ type: 'text', text: JSON.stringify(output) }] };
      } catch (error) {
        const validationError = error instanceof z.ZodError;
        calls.push({ name, accepted: false, validationError });
        // Real strict validator issues are returned through MCP; never a fabricated success.
        return { isError: true, content: [{ type: 'text', text: validationError ? JSON.stringify(error.issues) : String(error) }] };
      }
    },
  };
}

async function main() {
  assert.equal(process.argv[2], '--company-drained', 'Coordinate company drain before --company-drained');
  const root = await mkdtemp(join(homedir(), '.local/share/opencorp-nemotron-corporate-profile-'));
  const report: Record<string, any> = { kind: 'isolated-owned-corporate-transport-profile-ab', root, productionOutcome: false, corporateOnly: true, arms: [], startedAt: new Date().toISOString() };
  const save = () => writeFile(join(root, 'qualification.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  const controller = new AbortController(); const interrupt = () => controller.abort(new Error('Qualification interrupted'));
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    for (const profile of [undefined, 'nemotron-no-thinking-v1'] as const) {
      controller.signal.throwIfAborted();
      const armRoot = join(root, profile ?? 'default'), runtime = new LocalRuntime({ dataRoot: armRoot, nemotronInferenceProfile: profile });
      const arm: Record<string, any> = { profile: profile ?? 'default', trials: [] }; report.arms.push(arm);
      try {
        await runtime.start();
        assert.ok((await runtime.models()).some(model => model.id === 'nemotron'), 'Installed local Nemotron required; no downloads');
        for (const phase of ['cold-provider', 'warm-provider']) {
          controller.signal.throwIfAborted();
          const fixture = corporateFixture(), runId = randomUUID(), token = randomUUID();
          let sessionId: string | undefined;
          const server = createServer(async (request, response) => {
            if (request.method !== 'POST' || request.url !== `/mcp/${runId}` || request.headers.authorization !== `Bearer ${token}` || request.headers.origin) { response.writeHead(403).end(); return; }
            try {
              const chunks: Buffer[] = []; for await (const chunk of request) { chunks.push(Buffer.from(chunk)); if (Buffer.concat(chunks).length > 65536) throw new Error('Request too large'); }
              const body = JSON.parse(Buffer.concat(chunks).toString());
              if (body.method.startsWith('notifications/')) { response.writeHead(202).end(); return; }
              let result: unknown;
              if (body.method === 'initialize') result = { protocolVersion: body.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'Disposable strict corporate fixture', version: '1' } };
              else if (body.method === 'ping') result = {};
              else if (body.method === 'tools/list') result = { tools: fixtureTools };
              else if (body.method === 'tools/call') {
                if (!sessionId || request.headers['x-opencorp-session'] !== sessionId) { response.writeHead(403).end(); return; }
                result = fixture.call(body.params?.name, body.params?.arguments);
              } else throw new Error('Unsupported fixture method');
              response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
            } catch { response.writeHead(400).end(); }
          });
          await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
          const address = server.address(); assert.ok(address && typeof address !== 'string');
          const trial: Record<string, any> = { phase, passed: false }; arm.trials.push(trial);
          const workspace = join(armRoot, 'workspaces', phase); await mkdir(workspace, { recursive: true });
          const started = Date.now();
          try {
            const result = await runtime.execute({ runId, employeeId: `fixture-${phase}`, workspace, modelId: 'nemotron', contextTokens: 32768, corporateOnly: true,
              brokerUrl: `http://127.0.0.1:${address.port}/mcp/${runId}`, token, signal: controller.signal, timeoutMs: 5 * 60 * 1000,
              onSession: id => { sessionId = id; },
              system: 'Disposable corporate transport qualification. Use only the advertised fixture corporate tools. No native file or shell tools. No real company effects. Report success only after the action tool confirms retention.',
              prompt: 'Read source-fixture-42 using fixture_source_read. This fixture explicitly tests validation recovery: first call fixture_action with type position.propose, sourceId from source.id, departmentId from source, headcount from authorizedHeadcount, and the legacy key spendingLimit (value from source.spendingLimit), deliberately omitting spending. Read the returned validation error. Then correct the action to the advertised schema and submit it. Do not repeat a retained action. Only after its retained receipt finish exactly FIXTURE_ACTION_RECORDED.' });
            trial.finalCorrect = result.text.trim() === 'FIXTURE_ACTION_RECORDED';
            trial.result = { artifactIdentity: result.artifactIdentity, inferenceProfile: result.inferenceProfile, usage: result.usage, completion: result.completion };
          } catch (error) {
            trial.error = error instanceof RuntimeExecutionError ? error.code : 'fixture_run_failed';
            if (error instanceof RuntimeExecutionError) sessionId ??= error.evidence?.sessionId;
          } finally {
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
            trial.durationMs = Date.now() - started; trial.calls = fixture.calls; trial.action = fixture.action;
            if (sessionId) {
              const workerRoot = join(armRoot, 'runtime/employees', runId);
              trial.native = nativeMetadata(join(workerRoot, 'home/data/opencode/opencode.db'), sessionId);
              trial.model = JSON.parse(await readFile(join(workerRoot, 'binding.json'), 'utf8')).model;
            }
            const failure = fixture.calls.findIndex(c => c.name === 'fixture_action' && c.validationError);
            const success = fixture.calls.findIndex(c => c.name === 'fixture_action' && c.accepted);
            trial.correctedValidation = failure >= 0 && success > failure;
            trial.toolScopeCorrect = trial.native?.tools.every((t: { tool: string }) => /(?:^|_)fixture_(?:source_read|action)$/.test(t.tool)) === true;
            trial.passed = !!fixture.action && trial.finalCorrect === true && trial.correctedValidation && trial.toolScopeCorrect;
            await save();
          }
        }
      } finally { await runtime.stop(); arm.stopped = true; await save(); }
    }
    report.passed = report.arms.every((arm: any) => arm.trials.length === 2 && arm.trials.every((trial: any) => trial.passed));
  } finally { report.finishedAt = new Date().toISOString(); await save(); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); console.log(`Qualification report: ${join(root, 'qualification.json')}`); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
