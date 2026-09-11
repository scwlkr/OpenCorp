import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type { CompanySnapshot } from '../src/core/types.js';
import { sourceRoot } from '../src/server/paths.js';

export type OwnerControl = 'start' | 'pause' | 'resume' | 'stop';
export type ChatTarget = { employeeId?: string; projectId?: string };
export type OwnerSurface = 'webui' | 'compiled-cli';

/** Full JSON capture: a truncated command response must fail qualification. */
export async function invokeCompiledOwnerCLI(dataRoot: string, args: string[]): Promise<any> {
  const { stdout, stderr } = await promisify(execFile)(process.execPath,
    [join(sourceRoot, 'dist/cli/index.js'), '--data-dir', dataRoot, '--json', ...args],
    { timeout: 35_000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(stderr, '', 'Compiled CLI emitted unexpected diagnostics');
  return JSON.parse(stdout);
}

export async function ownerMutationSourceIdentity() {
  const paths = ['src/web/main.tsx', 'src/web/artifacts.tsx', 'src/web/api.ts', 'src/web/style.css', 'src/cli/index.ts', 'src/cli/client.ts',
    'tests/surfaces.browser.ts', 'tests/surfaces.mutations.ts', 'dist/cli/index.js', 'dist/cli/client.js', 'dist/web/index.html'];
  for (const name of await readdir(join(sourceRoot, 'dist/web/assets'))) if (/\.(js|css)$/.test(name)) paths.push(`dist/web/assets/${name}`);
  const files: Record<string, string> = {};
  for (const path of paths.sort()) files[path] = createHash('sha256').update(await readFile(join(sourceRoot, path))).digest('hex');
  return { fingerprint: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files };
}

const activeRun = (run: CompanySnapshot['runs'][number]) => ['queued', 'running', 'cancelling'].includes(run.status);

function verifyControlState(surface: OwnerSurface, action: OwnerControl, before: CompanySnapshot, state: CompanySnapshot) {
  const expected = action === 'pause' ? 'paused' : action === 'stop' ? 'stopped' : 'running';
  assert.equal(state.company.id, before.company.id, 'Surface mutation reached a different company');
  assert.equal(state.company.state, expected, `${surface} ${action} did not reach the requested state`);
  assert.equal(state.policy.localOnly, true); assert.equal(state.policy.spendingLimit, 0);
  if (expected !== 'running') for (const run of state.runs.filter(activeRun)) assert.equal(run.tokenRevoked, true, 'Pause/stop left active work with unrevoked authority');
  return expected;
}

function verifyControlObservation(surface: OwnerSurface, action: OwnerControl, before: CompanySnapshot, response: CompanySnapshot, observed: CompanySnapshot) {
  const expected = verifyControlState(surface, action, before, observed);
  if (expected !== 'running') {
    const responseIds = new Set(response.runs.map(run => run.id));
    assert.ok(observed.runs.every(run => responseIds.has(run.id)), 'Pause/stop admitted new work after its response');
    for (const run of response.runs.filter(activeRun)) assert.ok(observed.runs.some(item => item.id === run.id), 'Cancellation lost its durable run record');
  }
  return expected;
}

export function verifyControlReceipt(surface: OwnerSurface, action: OwnerControl, before: CompanySnapshot, response: CompanySnapshot, observed: CompanySnapshot) {
  verifyControlState(surface, action, before, response);
  const expected = verifyControlObservation(surface, action, before, response, observed);
  if (expected !== 'running') assert.ok(!observed.runs.some(activeRun), 'Pause/stop left active work');
  return { surface, action, companyId: before.company.id, beforeState: before.company.state, afterState: expected,
    revokedRunIds: expected === 'running' ? [] : response.runs.filter(activeRun).map(run => run.id), apiMethod: 'POST', apiPath: '/api/v1/control' };
}

/** Revocation is immediate; asynchronous preparation/effect cleanup must drain within 12 seconds. */
export async function waitForControlReceipt(surface: OwnerSurface, action: OwnerControl, before: CompanySnapshot, response: CompanySnapshot, readState: (signal: AbortSignal) => Promise<CompanySnapshot>) {
  const expected = verifyControlState(surface, action, before, response);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new Error(`${surface} ${action}: active work did not reach an observed terminal state within 12000ms`)); controller.abort(); }, 12_000);
  });
  const observe = async () => {
    while (true) {
      const observed = await readState(controller.signal); controller.signal.throwIfAborted();
      verifyControlObservation(surface, action, before, response, observed);
      if (expected === 'running' || !observed.runs.some(activeRun)) return verifyControlReceipt(surface, action, before, response, observed);
      await delay(100, undefined, { signal: controller.signal });
    }
  };
  try { return await Promise.race([observe(), deadline]); }
  finally { clearTimeout(timer!); controller.abort(); }
}

export function verifyChatReceipt(surface: OwnerSurface, before: CompanySnapshot, message: any, observed: CompanySnapshot, content: string, target: ChatTarget = {}) {
  assert.ok(['paused', 'stopped'].includes(before.company.state), 'Submit acceptance messages only in the coordinated paused/stopped window');
  assert.equal(observed.company.id, before.company.id, 'Chat reached a different company');
  assert.equal(observed.company.state, before.company.state, 'Chat submission changed company lifecycle');
  const ceo = before.employees.find(employee => employee.status === 'active' && before.positions.find(position => position.id === employee.positionId)?.level === 'ceo');
  const recipientId = target.employeeId ?? ceo?.id; assert.ok(recipientId, 'Chat needs a real active recipient');
  assert.ok(message?.id && !before.messages.some(item => item.id === message.id), 'Chat must return a new durable message');
  const retained = observed.messages.find(item => item.id === message.id);
  assert.ok(retained, 'Submitted chat is absent from persistent company state');
  for (const item of [message, retained]) {
    assert.equal(item.senderId, 'owner'); assert.equal(item.recipientId, recipientId);
    assert.equal(item.projectId ?? null, target.projectId ?? null); assert.equal(item.content, content.trim());
  }
  const assignments = observed.assignments.filter(assignment => assignment.kind === 'conversation' && assignment.payload?.messageId === message.id);
  assert.equal(assignments.length, 1, 'Chat must create exactly one response assignment');
  const assignment = assignments[0]; assert.equal(assignment.employeeId, recipientId); assert.equal(assignment.projectId, target.projectId ?? null);
  assert.equal(assignment.status, 'queued', 'Submission evidence must distinguish the queued response from an actual answer');
  assert.equal(assignment.accepted, true);
  return { surface, companyId: before.company.id, messageId: message.id as string, assignmentId: assignment.id, recipientId,
    projectId: target.projectId ?? null, content: content.trim(), assignmentStatus: assignment.status, delivery: 'persisted_response_queued', apiMethod: 'POST', apiPath: '/api/v1/chat' };
}
