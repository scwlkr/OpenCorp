import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, realpathSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { CompanyStore } from '../src/storage/store.js';
import { ProductReleases, type ReleasePackage } from '../src/tools/releases.js';
import type { WorkspaceManager } from '../src/tools/workspaces.js';
import type { Actor, Artifact, Project } from '../src/core/types.js';
import type { checked } from '../src/tools/process.js';
import type { executeSandboxed } from '../src/runtime/index.js';
const owner = { kind: 'owner' } as const;
const reviewed = 'b'.repeat(40), merged = 'a'.repeat(40), tree = 'c'.repeat(40), model = 'wlkr-management-qwen3.8-27b-q4-k-m:latest';
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const workflow = 'name: CI\non: [push, release]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: make test\n';
let root: string, store: CompanyStore, project: Project, artifact: Artifact, actor: Actor, adapter: ProductReleases;
let writes: string[], tag: any, remote: any, assets: any[], privacy: boolean, changedTree: boolean, failBeforeTag: boolean, loseAssetResponse: boolean, pauseAfterTag: boolean;
let releaseConfiguration:unknown;
let sandbox: ReturnType<typeof vi.fn<typeof executeSandboxed>>;
let run: typeof checked;
beforeEach(() => {
  releaseConfiguration=undefined;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'opencorp-release-'))); store = new CompanyStore(root); store.bootstrap();
  store.put('models', { name: model, artifactIdentity: 'local-only', local: true, available: true, capabilities: ['tools'] }); store.command(owner, { type: 'control', action: 'start' });
  const ceo = store.list('employees').find((employee) => store.level(employee.id) === 'ceo')!, product = store.list('products').find((product) => product.name === 'WalkLang')!;
  const mirror = join(root, 'repositories', 'product.git'); mkdirSync(mirror, { recursive: true });
  store.update('products', product.id, { binding: { repository: 'test-owner/WalkLang', public: true, defaultBranch: 'main', mirror } });
  project = store.command(owner, { type: 'project.create', name: 'Correct compiler edge case', productId: product.id, outcome: 'Deliver corrected behavior', acceptance: ['Canonical verifier passes'], supervisorId: ceo.id, rationale: 'Observed product defect' });
  const position = store.command(owner, { type: 'position.create', title: 'Compiler worker', level: 'worker', responsibilities: 'Fix compiler' });
  const worker = store.command(owner, { type: 'employee.hire', name: 'Compiler author', positionId: position.id, homeManagerId: ceo.id, modelId: model });
  const implementation = store.command(owner, { type: 'assignment.create', projectId: project.id, employeeId: worker.id, supervisorId: ceo.id, title: 'Correct defect', instructions: 'Implement and verify', acceptance: ['Correct output'], kind: 'implementation' });
  const assignment = store.command(owner, { type: 'assignment.create', projectId: project.id, employeeId: ceo.id, supervisorId: ceo.id, title: 'Release reviewed correction', instructions: 'Use actual reviewed artifacts', acceptance: ['Publish verified release'], kind: 'management' });
  const tracked = store.put('runs', { employeeId: ceo.id, assignmentId: assignment.id, modelId: model, policyRevision: store.policy.revision, workspace: '', sessionId: 'release-session', status: 'running', attempt: 1, leaseUntil: new Date(Date.now() + 60000).toISOString(), heartbeatAt: new Date().toISOString(), tokenRevoked: false });
  actor = { kind: 'employee', employeeId: ceo.id, runId: tracked.id, policyRevision: store.policy.revision };
  artifact = store.put('artifacts', { assignmentId: implementation.id, projectId: project.id, employeeId: worker.id, runId: 'author-run', uri: `https://github.com/test-owner/WalkLang/commit/${reviewed}`, identity: reviewed, kind: 'commit', summary: 'Correct actual defect', checks: [{ source: 'canonical-verifier', identity: reviewed, status: 'passed' }], verification: { identity: reviewed, passed: true, receiptId: 'actual-receipt' } });
  store.put('reviews', { artifactId: artifact.id, artifactIdentity: reviewed, employeeId: ceo.id, runId: 'independent-review', verdict: 'approved', rationale: 'Inspected actual diff and tests', checks: artifact.checks });
  project = store.update('projects', project.id, { delivery: { state: 'merged', artifactId: artifact.id, prNumber: 42, mergeCommit: merged } });
  writes = []; tag = undefined; remote = undefined; assets = []; privacy = false; changedTree = false; failBeforeTag = false; loseAssetResponse = false; pauseAfterTag = false;
  sandbox = vi.fn(async (options) => {
    const version = String(options.command).match(/export WALK_VERSION='([^']+)'/)![1];
    const platform = process.platform === 'darwin' ? 'darwin' : 'linux', arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const out = join(options.workspace, '.opencorp-release-output'); mkdirSync(out, { recursive: true });
    const names = [`walk-${version}-${platform}-${arch}`, `walk-runtime-${version}.tar.gz`, `walktop-${version}-${platform}-${arch}`];
    for (const name of names) writeFileSync(join(out, name), `controlled package fixture: ${name}`);
    writeFileSync(join(out, 'SHA256SUMS'), names.map((name) => `${hash(readFileSync(join(out, name)))}  ${name}`).join('\n') + '\n');
    return { code: 0, stdout: 'Controlled sandbox adapter success', stderr: '' };
  });
  run = async (file, args, options = {}) => {
    if (file === 'git') {
      if (args.includes('fetch')) return '';
      if (args.includes('ls-tree')) return '.github/workflows/ci.yml';
      if (args.includes('show')) return workflow;
      if (args.includes('worktree')) { const workspace=args[args.indexOf('--detach') + 1];mkdirSync(workspace, { recursive: true });if(releaseConfiguration){mkdirSync(join(workspace,'.opencorp'));writeFileSync(join(workspace,'.opencorp/product.json'),JSON.stringify(releaseConfiguration));} return ''; }
      if (args.includes('--absolute-git-dir')) return mirror;
      if (args.includes('rev-parse')) return changedTree && args.at(-1)?.startsWith(reviewed) ? 'd'.repeat(40) : tree;
    }
    if (file !== 'gh') throw new Error(`Unexpected command ${file}`);
    if (args.includes('user')) return 'test-owner';
    const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET';
    const endpoint = args.find((part) => part.startsWith('repos/') || part.startsWith('https://uploads.'))!;
    if (method !== 'GET') {
      writes.push(`${method} ${endpoint}`);
      const body = options.input ? JSON.parse(options.input) : undefined;
      if (endpoint.endsWith('/git/refs')) { if (failBeforeTag) throw new Error('Transport failed before tag observation'); tag = { object: { type: 'commit', sha: body.sha } }; if (pauseAfterTag) store.command(owner, { type: 'control', action: 'pause' }); return JSON.stringify(tag); }
      if (method === 'POST' && endpoint.endsWith('/releases')) { remote = { id: 10, ...body, html_url: 'https://github.com/test-owner/WalkLang/releases/tag/v6.3.4' }; return JSON.stringify(remote); }
      if (endpoint.startsWith('https://uploads.')) { const path = args[args.indexOf('--input') + 1]; const asset = { id: assets.length + 1, name: basename(path), state: 'uploaded', size: readFileSync(path).length, digest: `sha256:${hash(readFileSync(path))}`, browser_download_url: `https://github.com/test-owner/WalkLang/releases/download/v6.3.4/${basename(path)}` }; assets.push(asset); if (loseAssetResponse) { loseAssetResponse = false; throw new Error('Disconnected after asset was uploaded'); } return JSON.stringify(asset); }
      if (method === 'PATCH') { remote = { ...remote, ...body }; return JSON.stringify(remote); }
      throw new Error(`Unexpected mutation ${method} ${endpoint}`);
    }
    if (endpoint === 'repos/test-owner/WalkLang') return JSON.stringify({ full_name: 'test-owner/WalkLang', private: privacy, default_branch: 'main' });
    if (endpoint.includes('/pulls/')) return JSON.stringify({ merged: true, head: { sha: reviewed }, base: { ref: 'main' }, merge_commit_sha: merged });
    if (endpoint.includes('/commits/')) return JSON.stringify({ sha: merged });
    if (endpoint.includes('/compare/')) return JSON.stringify({ status: 'identical' });
    if (endpoint.includes('/git/ref/')) { if (!tag) throw new Error('gh: Not Found (HTTP 404)'); return JSON.stringify(tag); }
    if (endpoint.includes('/assets?')) return JSON.stringify([assets]);
    if (endpoint.includes('/releases?')) return JSON.stringify([remote ? [remote] : []]);
    throw new Error(`Unexpected request ${args.join(' ')}`);
  };
  const workspaces = { head: async () => merged, git: async () => '' } as unknown as WorkspaceManager;
  adapter = new ProductReleases(store, workspaces, { run, sandbox });
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
const prepare = () => adapter.prepare(actor, { artifactId: artifact.id, version: 'v6.3.4', notes: 'Correct the reviewed compiler edge case.' });

describe('controlled product release pipeline', () => {
  it('builds only through native sandbox at the final version and retains immutable package receipts', async () => {
    const release = await prepare(); expect(release.releaseState).toBe('ready'); expect(release.sourceCommit).toBe(merged); expect(release.sourceTree).toBe(tree); expect(release.assets).toHaveLength(4); expect(writes).toEqual([]);
    expect(sandbox).toHaveBeenCalledTimes(1); const command = String(sandbox.mock.calls[0][0].command); expect(command).toContain("export WALK_VERSION='v6.3.4'"); expect(command).toContain('make -j4 walk test'); expect(command).toContain('make conformance'); expect(command).toContain('scripts/release.sh'); expect(command).toContain('--version');
    expect(await prepare()).toEqual(release); expect(sandbox).toHaveBeenCalledTimes(1);
  });
  it('publishes separate durable tag, draft, each asset and final metadata effects exactly once', async () => {
    const release = await prepare(); const published = await adapter.publish(actor, { releaseId: release.id }); expect(published.releaseState).toBe('published'); expect(remote.draft).toBe(false); expect(assets).toHaveLength(4);
    expect(store.list('actions')).toHaveLength(7); expect(store.list('actions').every((action) => action.status === 'succeeded' && action.cost === 0)).toBe(true);
    const count = writes.length; await adapter.publish(actor, { releaseId: release.id }); expect(writes).toHaveLength(count);
  });
  it('preserves a completed tag but blocks every subsequent release mutation after pause', async () => {
    const release = await prepare(); pauseAfterTag = true; await expect(adapter.publish(actor, { releaseId: release.id })).rejects.toThrow();
    expect(writes).toHaveLength(1); expect(remote).toBeUndefined(); expect(store.list('actions')[0].status).toBe('succeeded');
  });
  it('reconciles a lost upload response using actual provider digest without duplicate upload', async () => {
    const release = await prepare(); loseAssetResponse = true; await expect(adapter.publish(actor, { releaseId: release.id })).rejects.toThrow(/requires provider reconciliation/); expect(assets).toHaveLength(1);
    expect(store.list('actions').some((action) => action.status === 'uncertain')).toBe(true);
    await adapter.publish(actor, { releaseId: release.id }); expect(assets).toHaveLength(4); expect(writes.filter((write) => write.includes('uploads.github.com'))).toHaveLength(4);
  });
  it('retries only once after conclusive absence and retains repeated uncertainty', async () => {
    const release = await prepare(); failBeforeTag = true;
    await expect(adapter.publish(actor, { releaseId: release.id })).rejects.toThrow(); await expect(adapter.publish(actor, { releaseId: release.id })).rejects.toThrow(); await expect(adapter.publish(actor, { releaseId: release.id })).rejects.toThrow(/no automatic retry/);
    expect(writes).toHaveLength(2); expect(store.list('actions')[0].status).toBe('uncertain');
  });
  it('rejects altered package bytes and conflicting tags without external writes', async () => {
    const release = await prepare(); const asset = release.assets[0]; chmodSync(asset.path, 0o600); writeFileSync(asset.path, 'changed bytes');
    await expect(adapter.publish(actor, { releaseId: release.id })).rejects.toThrow(/changed/); expect(writes).toEqual([]);
  });
  it('never overwrites an existing tag or unverifiable asset', async () => {
    const release = await prepare(); tag = { object: { type: 'commit', sha: 'e'.repeat(40) } }; await expect(adapter.publish(actor, { releaseId: release.id })).rejects.toThrow(/never overwrite/); expect(writes).toEqual([]);
    tag = undefined; loseAssetResponse = true; await expect(adapter.publish(actor, { releaseId: release.id })).rejects.toThrow(); assets[0].digest = 'sha256:wrong'; const before = writes.length;
    await expect(adapter.publish(actor, { releaseId: release.id })).rejects.toThrow(/unverified bytes/); expect(writes).toHaveLength(before);
  });
  it('rejects source drift, missing independent review, version injection, and unknown charging before build', async () => {
    changedTree = true; await expect(prepare()).rejects.toThrow(/differs/); changedTree = false;
    await expect(adapter.prepare(actor, { artifactId: artifact.id, version: 'v6;curl evil', notes: 'Correction' })).rejects.toThrow(/concrete version/);
    privacy = true; await expect(prepare()).rejects.toThrow(/cost has not been established/); expect(store.list('actions')[0].status).toBe('blocked'); privacy = false;
    store.update('reviews', store.list('reviews')[0].id, { verdict: 'changes_requested' }); await expect(prepare()).rejects.toThrow(/Independent review/); expect(sandbox).not.toHaveBeenCalled(); expect(writes).toEqual([]);
  });
  it('preserves failed build evidence and allows only a bounded fresh preparation attempt', async () => {
    sandbox.mockResolvedValue({ code: 1, stdout: '', stderr: 'Compiler failure' });
    await expect(prepare()).rejects.toThrow(/build\/checks failed/); const first = store.list('artifacts').find((item) => item.kind === 'release-package')!;
    expect(first.releaseState).toBe('failed'); expect(readFileSync(join(root, 'releases', first.id, 'build.log'), 'utf8')).toContain('Compiler failure');
    await expect(prepare()).rejects.toThrow(); expect(store.list('artifacts').filter((item) => item.kind === 'release-package')).toHaveLength(2);
    await expect(prepare()).rejects.toThrow(/retry limit/); expect(sandbox).toHaveBeenCalledTimes(2); expect(writes).toEqual([]);
  });
  it('does not issue final publish when a foreign extra asset appears in the draft', async () => {
    const release = await prepare(); loseAssetResponse = true; await expect(adapter.publish(actor, { releaseId: release.id })).rejects.toThrow();
    assets.push({ id: 100, name: 'unrelated.bin', state: 'uploaded', size: 5, digest: 'sha256:unrelated' });
    await expect(adapter.publish(actor, { releaseId: release.id })).rejects.toThrow(/exactly match/);
    expect(writes.some((write) => write.startsWith('PATCH'))).toBe(false); expect(remote.draft).toBe(true);
  });
  it('uses the shared native-build lock and rejects publication under a stale run policy', async () => {
    const lock = new Map([['other-build', new AbortController()]]); const locked = new ProductReleases(store, {} as WorkspaceManager, { effects: lock, run, sandbox });
    await expect(locked.prepare(actor, { artifactId: artifact.id, version: 'v6.3.4', notes: 'Correction' })).rejects.toThrow(/native build/);
    const release: ReleasePackage = await prepare(); store.command(owner, { type: 'policy.update', reassessMinutes: 45 }); await expect(adapter.publish(actor, { releaseId: release.id })).rejects.toThrow(); expect(writes).toEqual([]);
  });
});

it.each(['Useful helper','WalkLang'])('packages configured %s at reviewed source and rejects asset paths before executing', async (name) => {
  store.update('products',project.productId!,{name});
  const config={release:{target:'github-release',command:'node package.mjs',assets:['helper.zip']}};
  releaseConfiguration=config;
  adapter.workspaces.readBlob=vi.fn(async()=>JSON.stringify(config));
  sandbox.mockImplementation(async(options)=>{const out=join(options.workspace,'.opencorp-release-output');mkdirSync(out);writeFileSync(join(out,'helper.zip'),'configured product');writeFileSync(join(out,'SHA256SUMS'),`${hash('configured product')}  helper.zip\n`);return {code:0,stdout:'',stderr:''};});
  const release=await prepare();expect(release.assets.map(a=>a.name)).toEqual(['SHA256SUMS','helper.zip']);
  expect(adapter.workspaces.readBlob).toHaveBeenCalledWith(expect.any(String),merged,'.opencorp/product.json');
  expect(sandbox.mock.calls[0][0]).toMatchObject({command:"export OPENCORP_RELEASE_VERSION='v6.3.4'; node package.mjs"});
  config.release.assets=['../escape'];sandbox.mockClear();
  await expect(adapter.prepare(actor,{artifactId:artifact.id,version:'v6.3.5',notes:'Next release'})).rejects.toThrow(/flat asset names/);
  expect(sandbox).not.toHaveBeenCalled();expect(writes).toEqual([]);
});
