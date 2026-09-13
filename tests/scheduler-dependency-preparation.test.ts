import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyStore } from '../src/storage/store.js';
import { CorporateBroker } from '../src/tools/broker.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import { executeSandboxed } from '../src/runtime/tool-process.js';
import { productToolEnvironment } from '../src/tools/dependencies.js';
import type { LocalRuntime } from '../src/runtime/index.js';
import type { ExecuteRequest } from '../src/runtime/types.js';

vi.mock('../src/runtime/tool-process.js', () => ({ executeSandboxed: vi.fn() }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, stat: (path: string, ...args: any[]) => actual.stat(String(path).endsWith('/ruby/3.4.8/bin/ruby') ? process.execPath : path, ...args) };
});
const owner = { kind: 'owner' } as const;
const mismatch = "The dependencies in your gemfile changed, but the lockfile can't be updated\nbecause frozen mode is set\n\nYou have added to the Gemfile:\n* fixture-gem (~> 2.0)\n\nYou have deleted from the Gemfile:\n* fixture-gem\n";
const deletedMismatch = mismatch.replace("The dependencies in your gemfile changed, but the lockfile can't be updated\nbecause frozen mode is set\n", "Some dependencies were deleted from your gemfile, but the lockfile can't be\nupdated because frozen mode is set\n");
let root: string, workspace: string, store: CompanyStore, broker: CorporateBroker, subject: Scheduler;
let assignmentId: string, runId: string, runtime: ReturnType<typeof vi.fn<(request: ExecuteRequest) => Promise<never>>>;
let checkResult: { code: number; stdout: string; stderr: string };
const gem = Buffer.from('Synthetic checksum-bound public gem transport; native commands are mocked.');
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'opencorp-frozen-lock-'))); workspace = join(root, 'workspaces/product'); mkdirSync(join(workspace, 'config'), { recursive: true });
  writeFileSync(join(workspace, 'Gemfile'), 'source "https://rubygems.org"\ngem "fixture-gem", "~> 2.0"\n');
  writeFileSync(join(workspace, 'Gemfile.lock'), `GEM\n  remote: https://rubygems.org/\n  specs:\n    fixture-gem (1.0.0)\n\nCHECKSUMS\n  fixture-gem (1.0.0) sha256=${createHash('sha256').update(gem).digest('hex')}\n\n`);
  writeFileSync(join(workspace, 'config/importmap.rb'), '');
  store = new CompanyStore(root); store.bootstrap();
  const ceo = store.list('employees').find(employee => store.level(employee.id) === 'ceo')!;
  const model = store.need('employees', ceo.id).modelId;
  store.put('models', { name: model, artifactIdentity: 'fixture-local', local: true, available: true, capabilities: ['tools'] });
  store.command(owner, { type: 'control', action: 'start' });
  const product = store.list('products').find(product => product.name.toLowerCase() === 'palettewow')!;
  const project = store.command(owner, { type: 'project.create', name: 'Synthetic dependency repair', productId: product.id, supervisorId: ceo.id,
    outcome: 'Inspect a fixture dependency constraint', acceptance: ['Actual independent evidence'], rationale: 'Bounded scheduler fixture' });
  store.update('projects', project.id, { workspace });
  const assignment = store.command(owner, { type: 'assignment.create', projectId: project.id, employeeId: ceo.id, supervisorId: ceo.id,
    kind: 'implementation', title: 'Repair retained fixture dependency files', instructions: 'Inspect the retained fixture change and complete the assigned implementation.', acceptance: ['A verified implementation artifact'] });
  assignmentId = assignment.id; runId = store.claimNext({ assignmentId, workspace })!.id;
  broker = new CorporateBroker(store, root); runtime = vi.fn(async () => { throw new Error('Fixture stops at native model dispatch'); });
  subject = new Scheduler(store, { execute: runtime, cancel: vi.fn(async () => {}) } as unknown as LocalRuntime, broker, 'http://127.0.0.1');
  checkResult = { code: 16, stdout: '', stderr: mismatch };
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(gem));
  vi.mocked(executeSandboxed).mockReset().mockImplementation(async options => ({
    ...(Array.isArray(options.command) && options.command.join(' ') === 'bundle install --local --jobs=4' ? checkResult : { code: 0, stdout: '', stderr: '' }),
    durationMs: 1,
  }));
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
const execute = () => (subject as any).execute(store.need('runs', runId));
function onInstall(callback: (options: Parameters<typeof executeSandboxed>[0]) => unknown | Promise<unknown>) {
  const native = vi.mocked(executeSandboxed).getMockImplementation()!;
  vi.mocked(executeSandboxed).mockImplementation(async options => {
    if (Array.isArray(options.command) && options.command.join(' ') === 'bundle install --local --jobs=4') await callback(options);
    return native(options);
  });
}

describe('implementation access after a proven frozen Bundler lock mismatch', () => {
  it.each([mismatch, deletedMismatch])('admits the actual editor with honest failure evidence for %s', async diagnostic => {
    checkResult.stderr = diagnostic;
    const before = ['Gemfile', 'Gemfile.lock'].map(name => readFileSync(join(workspace, name)));
    await execute();
    expect(runtime, store.need('runs', runId).error).toHaveBeenCalledOnce();
    const request = runtime.mock.calls[0][0];
    expect(request.toolEnvironment?.variables.BUNDLE_FROZEN).toBe('true');
    expect(request.system).toContain('dependencies are not installed'); expect(request.system).toContain('frozen mode is set');
    const preparation = store.need('runs', runId).dependencyPreparation;
    expect(preparation).toMatchObject({ installed: false, repair: { kind: 'bundler_frozen_lock_mismatch', code: 16, command: 'bundle install --local --jobs=4' } });
    expect(preparation.repair.diagnostics).toContain('fixture-gem (~> 2.0)');
    expect(JSON.parse(readFileSync(preparation.receiptPath, 'utf8')).installed).toBe(false);
    expect(await productToolEnvironment({ workspace, dataRoot: root })).toBeUndefined();
    expect(['Gemfile', 'Gemfile.lock'].map(name => readFileSync(join(workspace, name)))).toEqual(before);
    expect(store.list('artifacts')).toEqual([]); expect(store.list('actions')).toEqual([]);
    // The per-workspace receipt is replaceable, but this run's cause and exact
    // source digest must remain readable after a later preparation succeeds.
    writeFileSync(preparation.receiptPath, JSON.stringify({ installed: true, lockDigest: 'later-lock' }));
    expect(store.need('runs', runId).dependencyPreparation).toEqual(preparation);
  });

  it.each([mismatch, deletedMismatch].flatMap(diagnostic => [1, 124, 130].map(code => ({ diagnostic, code }))))('does not admit another failure/cancellation code $code even with matching prose', async ({code, diagnostic}) => {
    checkResult.stderr = diagnostic; checkResult.code = code; await execute();
    expect(runtime).not.toHaveBeenCalled(); expect(store.need('runs', runId).dependencyPreparation.repair).toBeUndefined();
  });

  it.each(['Could not find fixture-gem in locally installed gems', 'Cannot write a changed lockfile while frozen.', "The lockfile does not have a valid platform.\n"])('does not admit another Bundler exit16: %s', async diagnostic => {
    checkResult.stderr = diagnostic; await execute();
    expect(runtime).not.toHaveBeenCalled(); expect(store.need('runs', runId).dependencyPreparation).toMatchObject({ installed: false });
    expect(store.need('runs', runId).dependencyPreparation.repair).toBeUndefined();
  });

  it.each(['import', 'ruby --version', 'bundle --version'])('does not skip failed prerequisite stage %s', async stage => {
    const native = vi.mocked(executeSandboxed).getMockImplementation()!;
    vi.mocked(executeSandboxed).mockImplementation(async options => {
      const command = Array.isArray(options.command) ? options.command.join(' ') : options.command;
      if (stage === 'import' ? command.includes('copyFileSync') : command === stage) return checkResult;
      return native(options);
    });
    await execute(); expect(runtime).not.toHaveBeenCalled();
    expect(store.need('runs', runId).dependencyPreparation.repair).toBeUndefined();
    expect(vi.mocked(executeSandboxed).mock.calls.some(([options]) => Array.isArray(options.command) && options.command.join(' ') === 'bundle install --local --jobs=4')).toBe(false);
  });

  it.each(['url', 'checksum', 'missing-checksums'])('keeps the %s dependency boundary before any editor admission', async boundary => {
    const lockPath = join(workspace, 'Gemfile.lock');
    if (boundary === 'url') writeFileSync(lockPath, readFileSync(lockPath, 'utf8').replace('https://rubygems.org/', 'https://private.invalid/'));
    if (boundary === 'missing-checksums') writeFileSync(lockPath, readFileSync(lockPath, 'utf8').split('\nCHECKSUMS\n')[0]);
    if (boundary === 'checksum') vi.mocked(globalThis.fetch).mockResolvedValue(new Response('wrong artifact bytes'));
    await execute(); expect(runtime).not.toHaveBeenCalled(); expect(executeSandboxed).not.toHaveBeenCalled();
    expect(store.need('runs', runId).dependencyPreparation.repair).toBeUndefined();
  });

  it('does not admit a run when owned process cleanup is uncertain', async () => {
    onInstall(() => { throw new Error('Owned process absence unconfirmed'); });
    await execute(); expect(runtime).not.toHaveBeenCalled();
    expect(store.need('runs', runId).dependencyPreparation.repair).toBeUndefined();
  });

  it.each(['pause', 'cancel'])('prevents native dispatch after %s during awaited preparation', async mode => {
    onInstall(async options => {
      if (mode === 'pause') store.command(owner, { type: 'control', action: 'pause' });
      else { await subject.pause(); expect(options.signal?.aborted).toBe(true); }
    });
    await execute(); expect(runtime).not.toHaveBeenCalled();
    expect(store.need('runs', runId)).toMatchObject({ status: 'interrupted', dependencyPreparation: { installed: false } });
    expect(store.list('assignments').some(assignment => assignment.schedulerKey === `fault:${runId}`)).toBe(false);
  });

  it.each(['employee', 'instructions', 'blocked'])('preserves a late Owner %s change instead of dispatching the old editor', async change => {
    const original = store.need('assignments', assignmentId), other = store.list('employees').find(employee => employee.id !== original.employeeId)!;
    const update = change === 'employee' ? { employeeId: other.id } : change === 'instructions' ? { instructions: 'Owner replacement scope, preserved.' } : { status: 'blocked', blockedReason: 'Owner hold, preserved.' };
    onInstall(() => store.command(owner, { type: 'assignment.update', assignmentId, ...update, rationale: 'Explicit fixture Owner change during dependency preparation' }));
    await execute(); expect(runtime).not.toHaveBeenCalled();
    expect(store.need('assignments', assignmentId)).toMatchObject(update);
    expect(store.need('runs', runId)).toMatchObject({ status: 'interrupted', ...(change === 'blocked' ? {} : { runtimeFailureCode: 'checkpoint_superseded' }) });
    expect(store.list('assignments').some(assignment => assignment.schedulerKey === `fault:${runId}`)).toBe(false);
  });

  it('preserves a project parked by its Owner while preparation was pending', async () => {
    const projectId = store.need('assignments', assignmentId).projectId!;
    onInstall(() => store.command(owner, { type: 'project.update', projectId, status: 'parked', rationale: 'Owner deferred this fixture project' }));
    await execute(); expect(runtime).not.toHaveBeenCalled();
    expect(store.need('projects', projectId).status).toBe('parked');
    expect(store.need('runs', runId)).toMatchObject({ status: 'interrupted', runtimeFailureCode: 'checkpoint_superseded' });
    expect(store.list('assignments').some(assignment => assignment.schedulerKey === `fault:${runId}`)).toBe(false);
  });

  it.each(['review', 'selected-pr', 'candidate', 'imported-artifact'])('does not grant repair admission to %s work', async kind => {
    const assignment = store.need('assignments', assignmentId), project = store.need('projects', assignment.projectId!);
    if (kind === 'review') store.update('assignments', assignmentId, { kind: 'review' });
    if (kind === 'selected-pr') store.update('assignments', assignmentId, { payload: { pullRequest: { number: 1, headSha: 'fixture' } } });
    if (kind === 'candidate') store.update('assignments', assignmentId, { pullRequestCandidate: { assignmentId, workspace: { workspace } } });
    if (kind === 'imported-artifact') {
      const artifact = store.put('artifacts', { assignmentId, projectId: project.id, employeeId: assignment.employeeId, runId, kind: 'commit', identity: 'fixture',
        reviewWorkspace: { workspace, gitDir: join(workspace, '.git'), mirror: join(root, 'mirror.git'), branch: 'fixture-pr', baseCommit: 'a'.repeat(40) },
        sourcePullRequest: { repository: 'fixture/public', number: 1, url: 'https://github.com/fixture/public/pull/1', authorLogin: 'external-fixture',
          baseRef: 'main', baseSha: 'a'.repeat(40), headRepository: 'fixture/public', headRef: 'fixture-pr', headSha: 'b'.repeat(40), observedAt: new Date().toISOString() } });
      store.update('assignments', assignmentId, { payload: { artifactId: artifact.id } });
    }
    // Candidate provenance has its own independently tested preflight; this
    // fixture isolates the stricter failed-dependency admission boundary.
    vi.spyOn(broker.workspaces, 'preparePullRequest').mockResolvedValue(project);
    vi.spyOn(broker.workspaces, 'forAssignment').mockReturnValue(project);
    await execute(); expect(runtime).not.toHaveBeenCalled();
    expect(store.need('runs', runId).dependencyPreparation).toMatchObject({ installed: false, repair: { kind: 'bundler_frozen_lock_mismatch' } });
  });

  it('bounds and redacts diagnostics without replacing the actual frozen failure', async () => {
    checkResult.stderr += `\nAuthorization: Bearer fixture-secret\n${'x'.repeat(8000)}`;
    await execute(); expect(runtime).toHaveBeenCalledOnce();
    const repair = store.need('runs', runId).dependencyPreparation.repair;
    expect(repair.diagnostics.length).toBeLessThanOrEqual(4000); expect(repair.diagnostics).not.toContain('fixture-secret');
    expect(repair.diagnostics).toContain('[REDACTED]'); expect(runtime.mock.calls[0][0].system).not.toContain('fixture-secret');
  });
});
