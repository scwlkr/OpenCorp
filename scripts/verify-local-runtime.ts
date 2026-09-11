import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';
import { LocalRuntime, executeSandboxed, type RuntimeEvent, type RuntimeResult } from '../src/runtime/index.js';

// This is a disposable integration fixture, never a product outcome. Product
// authorship and independent delivery are exercised by verify:acceptance.
const root = process.env.OPENCORP_RUNTIME_VERIFY_DIR ?? await mkdtemp(join(homedir(), '.local/share/opencorp-runtime-verification-'));
const workspace = join(root, 'workspaces', 'local-runtime');
await mkdir(workspace, { recursive: true });
const events: RuntimeEvent[] = [];
const runtime = new LocalRuntime({ dataRoot: root, onEvent: (event) => {
  events.push(event);
  if (['runtime.session.bound', 'runtime.inference.started', 'runtime.inference.finished'].includes(event.type)) console.log(JSON.stringify(event));
} });
const results: Record<string, unknown> = { startedAt: new Date().toISOString(), root, kind: 'disposable-real-runtime-check' };
const resultsPath = join(root, 'local-runtime-verification.json');

async function run(modelId: string, role: string, prompt: string, options: { contextTokens?: 16384 | 32768; imagePaths?: string[] } = {}): Promise<RuntimeResult> {
  const result = await runtime.execute({ runId: randomUUID(), employeeId: `verification-${role}`, workspace, modelId,
    system: `You are the ${role} in a disposable OpenCorp integration test. Use actual tools and inspect their output. Do not use corporate tools. ${role === 'reviewer' ? 'Independently review the existing implementation; do not edit it.' : ''}`,
    prompt, timeoutMs: 15 * 60 * 1000, ...options });
  assert.ok(result.usage.requests > 0, 'A real local inference request must occur');
  assert.ok(result.sessionId && result.artifactIdentity && result.messagesPath);
  return result;
}

try {
  results.models = await runtime.installModels();
  await writeFile(join(workspace, 'unique.mjs'), 'export function unique(values) { throw new Error("Implement stable deduplication"); }\n');
  await writeFile(join(workspace, 'unique.test.mjs'), `import assert from 'node:assert/strict';import {unique} from './unique.mjs';
assert.deepEqual(unique([]),[]);assert.deepEqual(unique([3,1,3,2,1]),[3,1,2]);assert.deepEqual(unique(['a','a','b']),['a','b']);
const source=[1,2,1];unique(source);assert.deepEqual(source,[1,2,1]);console.log('4 stable deduplication checks passed');\n`);
  results.implementation = await run('qwen-main', 'engineer',
    'Read unique.mjs and unique.test.mjs. Implement unique(values) preserving first occurrence order without modifying the input. Edit only unique.mjs. Run node unique.test.mjs and report the actual outcome.');
  const checked = await executeSandboxed({ dataRoot: root, workspace, command: [process.execPath, 'unique.test.mjs'] });
  assert.equal(checked.code, 0, checked.stderr);
  results.canonicalFixtureCheck = checked;
  const beforeReview = await readFile(join(workspace, 'unique.mjs'), 'utf8');
  results.review = await run('nemotron', 'reviewer',
    'Independently read unique.mjs and unique.test.mjs. Run node unique.test.mjs. Inspect whether the implementation preserves order and does not mutate the input. Report ACCEPT or REJECT with reasons from the actual code and checks. Do not edit files.', { contextTokens: 32768 });
  assert.equal(await readFile(join(workspace, 'unique.mjs'), 'utf8'), beforeReview, 'Independent reviewer must not silently modify the author artifact');
  assert.match((results.review as RuntimeResult).text, /ACCEPT/i);

  const screenshot = join(root, 'vision-browser.png');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
    await page.setContent('<html><body style="margin:0;background:#fff;font-family:Arial;padding:48px"><h1>OpenCorp visual check</h1><div style="display:flex;gap:90px;align-items:center"><div style="width:280px;height:200px;background:#157a3c;color:white;display:grid;place-items:center;font-size:90px">42</div><div style="width:180px;height:180px;border-radius:50%;background:#dc2626"></div></div><p style="font-size:28px">Two shapes, one number.</p></body></html>');
    await page.screenshot({ path: screenshot });
  } finally { await browser.close(); }
  results.vision = await run('small', 'visual-inspector',
    'Inspect the attached actual browser screenshot. What number is in the green rectangle? What shape and color is to its right? Answer from the image itself in one sentence. No tools needed.', { imagePaths: [screenshot] });
  assert.match((results.vision as RuntimeResult).text, /42/);
  assert.match((results.vision as RuntimeResult).text, /red/i);
  assert.match((results.vision as RuntimeResult).text, /circle/i);

  let cancellationBound!: () => void;
  const bound = new Promise<void>((resolve) => { cancellationBound = resolve; });
  const cancelId = randomUUID();
  const late = runtime.execute({ runId: cancelId, employeeId: 'verification-cancellation', workspace, modelId: 'small',
    system: 'Use the requested tool.', prompt: 'Run bash sleep 60, then write late-response.txt.',
    onSession: cancellationBound, timeoutMs: 120000 });
  const observed = late.then(() => false, () => true);
  await bound;
  const cancelStart = Date.now(); await runtime.cancel(cancelId);
  assert.ok(await observed, 'Cancelled run cannot report success');
  assert.ok(Date.now() - cancelStart < 5000, 'Cancellation must not wait on model response');
  results.cancellation = { passed: true, elapsedMs: Date.now() - cancelStart };
  results.passed = true;
} catch (error) {
  results.passed = false;
  results.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  await runtime.stop();
  results.finishedAt = new Date().toISOString(); results.events = events;
  await writeFile(resultsPath, JSON.stringify(results, null, 2), { mode: 0o600 });
  console.log(`Runtime verification record: ${resultsPath}`);
}
