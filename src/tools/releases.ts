import { prepareProductDependencies } from './dependencies.js';
import {deliveryFor} from '../core/delivery.js';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CompanyStore } from '../storage/store.js';
import { DomainError, type Actor, type Artifact } from '../core/types.js';
import { WorkspaceManager, safeChild } from './workspaces.js';
import { checked, brokerEnvironment, redact } from './process.js';
import { executeSandboxed } from '../runtime/index.js';
import { assertFreeWorkflow } from './github.js';

export interface ReleaseAsset { name: string; path: string; size: number; sha256: string }
export interface ReleasePackage extends Artifact {
  kind: 'release-package'; sourceArtifactId: string; sourceCommit: string; sourceTree: string;
  version: string; notes: string; productId: string; repository: string; assets: ReleaseAsset[];
  releaseState: 'building' | 'ready' | 'failed' | 'published'; packageDigest?: string; remoteRef?: string;
}
type Dependencies = { run?: typeof checked; sandbox?: typeof executeSandboxed; effects?: Map<string, AbortController> };
type Observation = { remoteRef: string; result: any } | undefined;
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const versionPattern = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/;
const commitPattern = /^[a-f0-9]{40,64}$/;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const costEvidence = 'Existing public GitHub repository: ordinary Git refs/releases/assets and unchanged standard hosted Actions only; package builds run locally with all network denied.';

/** Broker-only release effects. Never expose its credentials or package spool to workers. */
export class ProductReleases {
  private run: typeof checked; private sandbox: typeof executeSandboxed; private effects: Map<string, AbortController>;
  constructor(public store: CompanyStore, public workspaces: WorkspaceManager, options: Dependencies = {}) {
    this.run = options.run ?? checked; this.sandbox = options.sandbox ?? executeSandboxed; this.effects = options.effects ?? new Map();
  }
  async cancel() { for (const controller of this.effects.values()) controller.abort(); }
  private scope(actor: Actor, artifactId: string) {
    this.store.validateActor(actor, true);
    if (actor.kind !== 'employee') throw new DomainError('run_required', 'A tracked employee run is required.', 403);
    const run = this.store.need('runs', actor.runId), assignment = this.store.need('assignments', run.assignmentId);
    const project = this.store.need('projects', assignment.projectId!); const artifact = this.store.need('artifacts', artifactId);
    if (!project.productId || artifact.projectId !== project.id || artifact.kind !== 'commit') throw new DomainError('release_scope', 'Release source must be a commit artifact in this assignment project.', 403);
    const product = this.store.need('products', project.productId);
    if (!commitPattern.test(artifact.identity) || !this.store.hasApprovedArtifact(artifact.assignmentId, artifact.identity) || !artifact.checks.length || artifact.checks.some((check: any) => check.status !== 'passed' || check.source !== 'canonical-verifier' || check.identity !== artifact.identity)) throw new DomainError('review_required', 'Independent review and canonical verifier receipts for the exact source commit are required.', 403);
    if (!product.binding?.repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(product.binding.repository)) throw new DomainError('not_connected', 'Refresh the product GitHub binding first.', 409);
    const delivery=deliveryFor(project,artifact.id);
    if (delivery?.state !== 'merged' || !Number.isInteger(delivery.prNumber)) throw new DomainError('merge_required', 'Release source must have completed the reviewed product merge workflow.', 409);
    return { project, product, artifact, run, delivery, repo: String(product.binding.repository) };
  }
  private async json(path: string, absent = false): Promise<any> {
    try { return JSON.parse(await this.run('gh', ['api', path])); }
    catch (error) { if (absent && error instanceof Error && /\(HTTP 404\)/.test(error.message)) return undefined; throw error; }
  }
  private async pages(path: string): Promise<any[]> { const pages = JSON.parse(await this.run('gh', ['api', path, '--paginate', '--slurp'])); if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) throw new Error('Malformed GitHub pagination response'); return pages.flat(); }
  private async eligibility(actor: Actor, input: ReturnType<ProductReleases['scope']>) {
    const { repo, product, artifact, delivery } = input;
    const [account, current, pr] = await Promise.all([this.run('gh', ['api', 'user', '--jq', '.login']), this.json(`repos/${repo}`), this.json(`repos/${repo}/pulls/${delivery.prNumber}`)]);
    if (account !== repo.split('/')[0] || current.full_name?.toLowerCase() !== repo.toLowerCase()) throw new DomainError('identity_mismatch', 'Connected identity does not match this product.', 403);
    if (current.archived || current.disabled) throw new DomainError('release_repository_unavailable', 'The product repository is archived or disabled.', 409);
    if (current.private !== false) {
      this.store.prepareAction(actor, { kind: 'release', productId: product.id, artifactId: artifact.id, artifactIdentity: artifact.identity, target: `${repo}:release-capacity`, dedupeKey: `release-capacity:${artifact.id}`, content: { actualHead: artifact.identity, checksPassed: true, prerequisite: 'Confirm private repository Actions and release charging before enabling this channel.' }, cost: null, costEvidence: '' });
      throw new DomainError('cost_unconfirmed', 'Private repository Actions/release cost has not been established; this adapter supports public zero-cost delivery only.', 409);
    }
    if (!pr.merged || pr.head?.sha !== artifact.identity || pr.base?.ref !== current.default_branch || !commitPattern.test(pr.merge_commit_sha || '')) throw new DomainError('merge_changed', 'Live provider merge does not match the reviewed source.', 409);
    const sourceCommit: string = pr.merge_commit_sha;
    const live = await this.json(`repos/${repo}/commits/${encodeURIComponent(current.default_branch)}`);
    const ancestry = await this.json(`repos/${repo}/compare/${sourceCommit}...${live.sha}`);
    if (!['ahead', 'identical'].includes(ancestry.status)) throw new DomainError('merge_missing', 'Release source is not on the current default branch.', 409);
    // Read-only fetch of the immutable provider commit; no product checkout is changed.
    const mirror = safeChild(join(this.store.dataRoot, 'repositories'), product.binding.mirror);
    await this.run('git', ['--git-dir', mirror, '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', 'fetch', `https://github.com/${repo}.git`, sourceCommit], { env: { ...brokerEnvironment(), GIT_CONFIG_GLOBAL: '/dev/null' }, timeoutMs: 120000 });
    const git = (args: string[]) => this.run('git', ['--git-dir', mirror, '-c', 'core.hooksPath=/dev/null', ...args], { env: { ...brokerEnvironment(), GIT_CONFIG_GLOBAL: '/dev/null' } });
    const sourceTree = await git(['rev-parse', `${sourceCommit}^{tree}`]); const reviewedTree = await git(['rev-parse', `${artifact.identity}^{tree}`]);
    if (sourceTree !== reviewedTree) throw new DomainError('merged_tree_changed', 'Merged source differs from the independently reviewed tree; review and verify that exact source before releasing.', 409);
    const workflows = (await git(['ls-tree', '-r', '--name-only', sourceCommit, '.github/workflows'])).split('\n').filter(Boolean);
    for (const file of workflows) assertFreeWorkflow(await git(['show', `${sourceCommit}:${file}`]), file);
    this.store.validateActor(actor, true);
    return { sourceCommit, sourceTree, mirror, account };
  }
  async prepare(actor: Actor, input: { artifactId: string; version: string; notes: string }): Promise<ReleasePackage> {
    if (!versionPattern.test(input.version) || input.version.length > 80) throw new DomainError('invalid_version', 'Use a concrete version such as v6.3.4; shell syntax and arbitrary tag paths are forbidden.');
    if (!input.notes?.trim() || input.notes.length > 20000 || input.notes.includes('<!-- opencorp-release:')) throw new DomainError('release_notes_required', 'Accurate release notes without reserved tracking markers are required.');
    const scoped = this.scope(actor, input.artifactId);
    const candidates = this.store.list('artifacts').filter((item) => item.kind === 'release-package' && item.productId === scoped.product.id && item.version === input.version) as ReleasePackage[];
    const prior = candidates.at(-1);
    if (prior && ['ready', 'published'].includes(prior.releaseState)) {
      if (prior.sourceArtifactId !== input.artifactId || prior.notes !== input.notes) throw new DomainError('release_version_conflict', 'This version already identifies different source or release notes.', 409);
      this.verifyPackage(prior); return prior;
    }
    if (prior?.releaseState === 'building') {
      const priorRun = this.store.need('runs', prior.runId);
      if (!priorRun.tokenRevoked || !['failed', 'interrupted', 'succeeded'].includes(priorRun.status)) throw new DomainError('release_build_inflight', 'Prior package process ownership must be reconciled before another build.', 409);
      this.store.update('artifacts', prior.id, { releaseState: 'failed', failure: 'Prior package run ended; preserved workspace and logs require inspection.' });
    }
    if (candidates.filter((candidate) => candidate.sourceArtifactId === input.artifactId).length >= 1 + this.store.policy.maxRetries) throw new DomainError('release_retry_limit', 'Package preparation retry limit reached. Management must correct/review the source or record the actual prerequisite.', 409);
    if (this.effects.size) throw new DomainError('native_slot_busy', 'A native build is already active.', 409);
    const controller = new AbortController(); this.effects.set(scoped.run.id, controller);
    let release: ReleasePackage | undefined;
    try {
      const eligibility = await this.eligibility(actor, scoped);
      const id = randomUUID(), workspace = join(this.store.dataRoot, 'workspaces', `release-${id}`), root = join(this.store.dataRoot, 'releases', id);
      mkdirSync(join(this.store.dataRoot, 'workspaces'), { recursive: true }); mkdirSync(root, { recursive: true, mode: 0o700 });
      release = this.store.put('artifacts', { id, kind: 'release-package', assignmentId: scoped.run.assignmentId, employeeId: scoped.run.employeeId, runId: scoped.run.id, projectId: scoped.project.id, productId: scoped.product.id, sourceArtifactId: scoped.artifact.id, sourceCommit: eligibility.sourceCommit, sourceTree: eligibility.sourceTree, identity: eligibility.sourceCommit, repository: scoped.repo, version: input.version, notes: input.notes, summary: `${scoped.product.name} ${input.version} release package`, uri: join(root, 'manifest.json'), assets: [], checks: [], releaseState: 'building', workspace, supersedes: prior?.id ?? null }) as ReleasePackage;
      this.store.validateActor(actor, true);
      await this.run('git', ['--git-dir', eligibility.mirror, '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', workspace, eligibility.sourceCommit], { env: { ...brokerEnvironment(), GIT_CONFIG_GLOBAL: '/dev/null' } });
      const gitDir = await this.run('git', ['-C', workspace, 'rev-parse', '--absolute-git-dir']);
      const buildProject = { ...scoped.project, workspace, gitDir };
      const host = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : undefined;
      const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'amd64' : undefined;
      if (!host || !arch) throw new DomainError('release_host_unavailable', 'Existing release procedure requires a supported native build host.', 409);
      const binary = `walk-${input.version}-${host}-${arch}`, legacyAssets = [binary, `walk-runtime-${input.version}.tar.gz`, `walktop-${input.version}-${host}-${arch}`];
      const legacyCommand = `export WALK_VERSION=${quote(input.version)}; make clean && make -j4 walk test && make conformance && WALK_BIN="$PWD/build/walk" scripts/stress-compatibility.sh && scripts/check-docs-site.sh && scripts/release.sh "$WALK_VERSION" "$PWD/.opencorp-release-output" && test "$("$PWD/.opencorp-release-output/${binary}" --version)" = "$WALK_VERSION" && NO_COLOR=1 "$PWD/.opencorp-release-output/walktop-${input.version}-${host}-${arch}" --once --fixture tools/walktop/testdata/basic && tar -tzf "$PWD/.opencorp-release-output/walk-runtime-${input.version}.tar.gz" >/dev/null`;
      let command=legacyCommand,expected=legacyAssets;
      let toolEnvironment;
      const configured=existsSync(join(workspace,'.opencorp/product.json'));
      if(!configured&&scoped.product.name!=='WalkLang')throw new DomainError('release_channel_unavailable','Reviewed .opencorp/product.json must configure the release procedure.',409);
      if(configured) {
        const raw=await this.workspaces.readBlob(eligibility.mirror,eligibility.sourceCommit,'.opencorp/product.json');
        const config=JSON.parse(raw).release;
        if(config?.target!=='github-release'||typeof config.command!=='string'||!config.command.trim()||config.command.length>4000||config.command.includes('\0')||!Array.isArray(config.assets)||!config.assets.length||config.assets.length>32||config.assets.some((name:unknown)=>typeof name!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)||name==='SHA256SUMS')||new Set(config.assets).size!==config.assets.length)throw new DomainError('release_channel_unavailable','Reviewed .opencorp/product.json must configure a github-release command and distinct flat asset names.',409);
        command=`export OPENCORP_RELEASE_VERSION=${quote(input.version)}; ${config.command}`;expected=config.assets;
        const prepared=await prepareProductDependencies({productName:scoped.product.name,workspace,dataRoot:this.store.dataRoot,signal:controller.signal});
        if(!prepared.installed)throw new DomainError('release_dependencies','Release dependency preparation failed.',409);
        toolEnvironment=prepared.environment;
      }
      this.store.validateActor(actor, true);
      const result = await this.sandbox({ workspace, command, toolEnvironment, runId: `release-${id}`, dataRoot: this.store.dataRoot, timeoutMs: 30 * 60_000, signal: controller.signal });
      writeFileSync(join(root, 'build.log'), redact(`${result.stdout}\n${result.stderr}`), { mode: 0o600 });
      if (result.code !== 0 || controller.signal.aborted) throw new DomainError('release_build_failed', `Release build/checks failed (${result.code}); inspect ${join(root, 'build.log')}.`, 409);
      this.store.validateActor(actor, true);
      if (await this.workspaces.head(buildProject) !== eligibility.sourceCommit || (await this.workspaces.git(buildProject, ['status', '--porcelain', '--untracked-files=no']))) throw new DomainError('release_source_changed', 'Packaging modified tracked source; release rejected.', 409);
      const output = safeChild(workspace, join(workspace, '.opencorp-release-output'));
      const actualNames = readdirSync(output).sort(); const names = [...expected, 'SHA256SUMS'].sort();
      if (JSON.stringify(actualNames) !== JSON.stringify(names)) throw new DomainError('release_assets_invalid', 'Existing release procedure did not produce exactly the configured assets and checksums.', 409);
      const checksums = readFileSync(safeChild(output, join(output, 'SHA256SUMS')), 'utf8').trim().split('\n');
      const spool = join(root, 'assets'); mkdirSync(spool, { mode: 0o700 }); const assets: ReleaseAsset[] = [];
      for (const name of names) {
        const path = join(output, name), stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size === 0 || stat.size > 512 * 1024 * 1024) throw new DomainError('release_assets_invalid', `Unsafe or oversized release file ${name}.`, 409);
        const hash = sha256(readFileSync(safeChild(output, path)));
        if (name !== 'SHA256SUMS' && !checksums.includes(`${hash}  ${name}`)) throw new DomainError('checksum_mismatch', `Release checksum does not match actual bytes for ${name}.`, 409);
        const destination = join(spool, name); copyFileSync(path, destination); chmodSync(destination, 0o400);
        assets.push({ name, path: destination, size: stat.size, sha256: hash });
      }
      if (checksums.length !== expected.length) throw new DomainError('checksum_mismatch', 'Checksum file includes unexpected entries.', 409);
      const packageDigest = sha256(JSON.stringify({ sourceCommit: eligibility.sourceCommit, sourceTree: eligibility.sourceTree, version: input.version, assets: assets.map(({ name, size, sha256 }) => ({ name, size, sha256 })) }));
      const manifest = { releaseId: id, sourceArtifactId: scoped.artifact.id, sourceCommit: eligibility.sourceCommit, sourceTree: eligibility.sourceTree, version: input.version, packageDigest, assets, host: `${host}-${arch}`, command, preparedAt: new Date().toISOString() };
      writeFileSync(release.uri, JSON.stringify(manifest, null, 2), { mode: 0o400 });
      release = this.store.update('artifacts', id, { releaseState: 'ready', packageDigest, assets, host: `${host}-${arch}`, identity: packageDigest, checks: [{ source: 'release-verifier', identity: eligibility.sourceCommit, version: input.version, status: 'passed', command, logPath: join(root, 'build.log') }] }) as ReleasePackage;
      this.store.emit('release.prepared', { releaseId: id, sourceCommit: eligibility.sourceCommit, packageDigest, assets: assets.map(({ name, sha256 }) => ({ name, sha256 })) }); return release;
    } catch (error) {
      if (release) this.store.update('artifacts', release.id, { releaseState: 'failed', failure: redact(String(error)) });
      throw error;
    } finally { this.effects.delete(scoped.run.id); }
  }
  private verifyPackage(release: ReleasePackage) {
    if (!['ready', 'published'].includes(release.releaseState) || !release.assets.length) throw new DomainError('release_not_ready', 'Package readiness has not been verified.', 409);
    const root = join(this.store.dataRoot, 'releases', release.id);
    for (const asset of release.assets) {
      const path = safeChild(root, asset.path), stat = lstatSync(asset.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== asset.size || sha256(readFileSync(path)) !== asset.sha256) throw new DomainError('package_changed', `Prepared package ${asset.name} changed; publication denied.`, 409);
    }
    const manifest = JSON.parse(readFileSync(safeChild(root, release.uri), 'utf8'));
    const digest = sha256(JSON.stringify({ sourceCommit: release.sourceCommit, sourceTree: release.sourceTree, version: release.version, assets: release.assets.map(({ name, size, sha256 }) => ({ name, size, sha256 })) }));
    if (digest !== release.packageDigest || release.identity !== digest || manifest.version !== release.version || manifest.packageDigest !== release.packageDigest || manifest.sourceCommit !== release.sourceCommit || manifest.sourceTree !== release.sourceTree || JSON.stringify(manifest.assets) !== JSON.stringify(release.assets)) throw new DomainError('package_changed', 'Immutable package manifest differs from company state.', 409);
  }
  private async effect(actor: Actor, release: ReleasePackage, source: Artifact, phase: string, content: object, observe: () => Promise<Observation>, dispatch: () => Promise<unknown>) {
    let action = this.store.prepareAction(actor, { kind: 'release', productId: release.productId, artifactId: source.id, artifactIdentity: source.identity, target: `${release.repository}:${release.version}:${phase}`, dedupeKey: `release:${release.id}:${phase}`, content: { releaseId: release.id, phase, sourceCommit: release.sourceCommit, actualHead: source.identity, checksPassed: true, ...content }, cost: 0, costEvidence });
    const existing = await observe();
    if (action.status === 'succeeded') { if (!existing) throw new DomainError('release_remote_changed', 'Previously observed release effect is no longer present; no replay is allowed.', 409); return existing; }
    if (action.status === 'dispatched') throw new DomainError('release_inflight', 'Release effect is still owned by an in-flight dispatch.', 409);
    if (action.status === 'uncertain') {
      if (existing) { this.store.resolveAction(action.id, { status: 'succeeded', ...existing }); return existing; }
      action = this.store.reconcileAction(action.id, { state: 'absent', evidence: `Authenticated provider query conclusively found ${phase} absent at ${release.repository}:${release.version}.` });
    }
    if (action.status !== 'prepared') throw new DomainError('release_reconciliation_required', `Effect ${action.id} remains ${action.status}; no automatic retry.`, 409);
    if (actor.kind !== 'employee') throw new DomainError('run_required', 'Employee run required.', 403);
    if (action.runId !== actor.runId) {
      const prior = this.store.need('runs', action.runId);
      if (!prior.tokenRevoked || ['running', 'queued', 'cancelling'].includes(prior.status)) throw new DomainError('prior_run_active', 'Prior release run has not finished.', 409);
      action = this.store.update('actions', action.id, { runId: actor.runId, employeeId: actor.employeeId, policyRevision: actor.policyRevision, priorRunIds: [...(action.priorRunIds ?? []), action.runId] });
    }
    this.verifyPackage(release); this.store.validateActor(actor, true); this.store.dispatchAction(actor, action.id);
    try {
      if (!existing) await dispatch();
      const observed = existing ?? await observe(); if (!observed) throw new Error('Provider did not confirm the intended release state');
      this.store.resolveAction(action.id, { status: 'succeeded', ...observed }); return observed;
    } catch (error) {
      this.store.resolveAction(action.id, { status: 'uncertain', error: redact(String(error)) });
      throw new DomainError('release_uncertain', `Release effect ${action.id} requires provider reconciliation: ${redact(String(error))}`, 409);
    }
  }
  async publish(actor: Actor, input: { releaseId: string }): Promise<ReleasePackage> {
    const release = this.store.need('artifacts', input.releaseId) as ReleasePackage;
    if (release.kind !== 'release-package') throw new DomainError('release_not_found', 'A prepared release package is required.');
    const scoped = this.scope(actor, release.sourceArtifactId); this.verifyPackage(release);
    if (scoped.repo !== release.repository || scoped.product.id !== release.productId) throw new DomainError('release_binding_changed', 'Product binding changed since package preparation.', 409);
    const eligibility = await this.eligibility(actor, scoped);
    if (eligibility.sourceCommit !== release.sourceCommit || eligibility.sourceTree !== release.sourceTree) throw new DomainError('release_source_changed', 'Merged source changed since package preparation.', 409);
    const repo = release.repository, version = release.version;
    const tagObservation = async (): Promise<Observation> => {
      const ref = await this.json(`repos/${repo}/git/ref/tags/${version}`, true); if (!ref) return undefined;
      let object = ref.object; for (let depth = 0; object?.type === 'tag' && depth < 5; depth++) object = (await this.json(`repos/${repo}/git/tags/${object.sha}`)).object;
      if (object?.type !== 'commit' || object.sha !== release.sourceCommit) throw new DomainError('release_tag_conflict', 'Existing release tag identifies different source; never overwrite it.', 409);
      return { remoteRef: `https://github.com/${repo}/tree/${version}`, result: { sourceCommit: object.sha } };
    };
    await this.effect(actor, release, scoped.artifact, 'tag', { version }, tagObservation, () => this.run('gh', ['api', '--method', 'POST', `repos/${repo}/git/refs`, '--input', '-'], { input: JSON.stringify({ ref: `refs/tags/${version}`, sha: release.sourceCommit }) }));
    const body = `${release.notes}\n\nBuilt locally for ${release.host} from ${release.sourceCommit}. SHA256SUMS accompanies the release assets.\n\n<!-- opencorp-release:${release.id}:${release.sourceCommit} -->`;
    const releaseObservation = async (): Promise<Observation> => {
      const matches = (await this.pages(`repos/${repo}/releases?per_page=100`)).filter((item) => item.tag_name === version);
      if (!matches.length) return undefined;
      const result = matches[0];
      if (matches.length !== 1 || result.body !== body || result.name !== version || result.prerelease !== version.includes('-')) throw new DomainError('release_metadata_conflict', 'Existing release metadata is not this intended release; no overwrite.', 409);
      return { remoteRef: result.html_url, result };
    };
    let remote = await this.effect(actor, release, scoped.artifact, 'metadata', { body, version }, releaseObservation, () => this.run('gh', ['api', '--method', 'POST', `repos/${repo}/releases`, '--input', '-'], { input: JSON.stringify({ tag_name: version, target_commitish: release.sourceCommit, name: version, body, draft: true, prerelease: version.includes('-') }) }));
    const assets = () => this.pages(`repos/${repo}/releases/${remote.result.id}/assets?per_page=100`);
    for (const asset of release.assets) {
      const observe = async (): Promise<Observation> => {
        const matches = (await assets()).filter((item) => item.name === asset.name); if (!matches.length) return undefined;
        const found = matches[0];
        if (matches.length !== 1 || found.state !== 'uploaded' || found.size !== asset.size || found.digest !== `sha256:${asset.sha256}`) throw new DomainError('release_asset_conflict', `Existing asset ${asset.name} has different or unverified bytes; never overwrite it.`, 409);
        return { remoteRef: found.browser_download_url, result: { id: found.id, name: found.name, digest: found.digest, size: found.size } };
      };
      await this.effect(actor, release, scoped.artifact, `asset:${asset.name}`, { name: asset.name, sha256: asset.sha256, size: asset.size }, observe, async () => {
        const latest = await releaseObservation(); if (!latest?.result.draft) throw new DomainError('release_already_public', 'Missing assets cannot be added to an already published release by this adapter.', 409);
        this.store.validateActor(actor, true);
        return this.run('gh', ['api', '--method', 'POST', `https://uploads.github.com/repos/${repo}/releases/${remote.result.id}/assets?name=${encodeURIComponent(asset.name)}`, '-H', 'Content-Type: application/octet-stream', '--input', asset.path], { timeoutMs: 120000 });
      });
    }
    const readyAssets = await assets();
    if (readyAssets.length !== release.assets.length || readyAssets.some((item) => !release.assets.some((asset) => item.name === asset.name && item.digest === `sha256:${asset.sha256}` && item.size === asset.size))) throw new DomainError('release_asset_conflict', 'Provider release assets do not exactly match the immutable package.', 409);
    await tagObservation();
    remote = await this.effect(actor, release, scoped.artifact, 'publish', { releaseId: remote.result.id, packageDigest: release.packageDigest }, async () => { const observed = await releaseObservation(); return observed && !observed.result.draft ? observed : undefined; }, async () => {
      this.store.validateActor(actor, true);
      return this.run('gh', ['api', '--method', 'PATCH', `repos/${repo}/releases/${remote.result.id}`, '--input', '-'], { input: JSON.stringify({ draft: false, make_latest: 'legacy' }) });
    });
    if (release.releaseState === 'published') return this.store.need('artifacts', release.id) as ReleasePackage;
    this.store.emit('release.published', { releaseId: release.id, url: remote.remoteRef, sourceCommit: release.sourceCommit, packageDigest: release.packageDigest });
    return this.store.update('artifacts', release.id, { releaseState: 'published', remoteRef: remote.remoteRef, publishedAt: new Date().toISOString() }) as ReleasePackage;
  }
}
