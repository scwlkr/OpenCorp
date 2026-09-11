import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, realpath, stat, rename } from 'node:fs/promises';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { executeSandboxed } from '../runtime/tool-process.js';
import type { ToolEnvironment } from '../runtime/types.js';
import { dependenciesRoot } from '../runtime/sandbox.js';
import { redact } from './process.js';

type Artifact = { url: string; algorithm: 'sha512' | 'sha256'; digest: string; filename?: string; hostCache?: string };
type Check = { command: string; code: number; stdout: string; stderr: string };
export interface DependencyResult {
  workspace: string; productName: string; lockDigest: string; environment: ToolEnvironment;
  installed: boolean; checks: Check[]; receiptPath: string;
  artifacts: number; downloaded: number; reused: number; incrementalCost: 0;
  repair?: { kind: 'bundler_frozen_lock_mismatch'; command: string; code: 16; diagnostics: string };
}
interface Options { productName: string; workspace: string; dataRoot: string; signal?: AbortSignal }

function digest(value: string | Buffer, algorithm = 'sha256'): string { return createHash(algorithm).update(value).digest('hex'); }
function cacheContent(root: string, algorithm: string, hash: string): string { return join(root, '_cacache/content-v2', algorithm, hash.slice(0, 2), hash.slice(2, 4), hash.slice(4)); }

/** Only immutable public package artifacts; no registry APIs, auth, query strings or arbitrary hosts. */
export function validateDependencyUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash) throw new Error('Dependency URL must be unauthenticated HTTPS');
  const npm = url.hostname === 'registry.npmjs.org' && /^\/(?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+\/-\/[A-Za-z0-9._~-]+\.tgz$/.test(url.pathname);
  const gem = url.hostname === 'rubygems.org' && /^\/downloads\/[A-Za-z0-9._-]+\.gem$/.test(url.pathname);
  if (!npm && !gem) throw new Error('Dependency endpoint is outside the public artifact allowlist');
  return url;
}

export function validateBrowserArtifactUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash) throw new Error('Browser artifact requires unauthenticated HTTPS');
  const chrome = /^\/builds\/cft\/\d+\.\d+\.\d+\.\d+\/mac-arm64\/chrome(?:-headless-shell)?-mac-arm64\.zip$/;
  const allowed = (url.hostname === 'cdn.playwright.dev' && (chrome.test(url.pathname) || /^\/(?:dbazure\/download\/playwright\/)?builds\/ffmpeg\/\d+\/ffmpeg-mac-arm64\.zip$/.test(url.pathname)))
    || (url.hostname === 'storage.googleapis.com' && /^\/chrome-for-testing-public\/\d+\.\d+\.\d+\.\d+\/mac-arm64\/chrome(?:-headless-shell)?-mac-arm64\.zip$/.test(url.pathname))
    || (url.hostname === 'playwright.download.prss.microsoft.com' && /^\/dbazure\/download\/playwright\/builds\/ffmpeg\/\d+\/ffmpeg-mac-arm64\.zip$/.test(url.pathname));
  if (!allowed) throw new Error('Browser download is outside the public browser artifact allowlist');
  return url;
}

async function prepareBrowsers(options: Options, environment: ToolEnvironment, stateRoot: string, artifactsRoot: string): Promise<Check[]> {
  // The dry-run executes the locked product's actual installer inside the OS
  // boundary. Its output is untrusted and each URL and destination is checked.
  try { await stat(join(options.workspace, 'node_modules/playwright/cli.js')); } catch { return []; }
  const run = (command: string[], readPaths?: string[]) => executeSandboxed({ ...options, toolEnvironment: environment, command, readPaths, timeoutMs: 180000 });
  const dryRun = await run(['node', 'node_modules/playwright/cli.js', 'install', 'chromium', '--dry-run']);
  const checks = [{ command: 'Playwright browser artifact inventory', ...dryRun }];
  if (dryRun.code) return checks;
  const entries = [...dryRun.stdout.matchAll(/Install location:\s+([^\n]+)\n\s+Download url:\s+(https:\/\/[^\s]+)/g)];
  if (!entries.length || entries.length > 3) throw new Error('Unexpected browser artifact inventory');
  const browserRoot = environment.variables.PLAYWRIGHT_BROWSERS_PATH;
  const receipts: Array<{ url: string; sha256: string; destination: string }> = [];
  for (const entry of entries) {
    const destination = entry[1].trim();
    if (dirname(destination) !== browserRoot || !/^(?:chromium|chromium_headless_shell|ffmpeg)-\d+$/.test(destination.slice(browserRoot.length + 1))) throw new Error('Browser install destination escapes the owned cache');
    const original = validateBrowserArtifactUrl(entry[2]).href;
    const archive = join(artifactsRoot, 'browsers', digest(original), 'browser.zip');
    let bytes: Buffer | undefined;
    try { bytes = await readFile(archive); } catch { /* The first download records its TLS-authenticated source and digest. */ }
    if (!bytes) {
      let target = original;
      for (let redirect = 0; redirect < 4; redirect++) {
        validateBrowserArtifactUrl(target);
        const response = await fetch(target, { redirect: 'manual', signal: AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(180000)]) });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location'); await response.body?.cancel();
          if (!location) throw new Error('Browser redirect has no destination');
          target = validateBrowserArtifactUrl(new URL(location, target).href).href; continue;
        }
        if (!response.ok || !response.body) throw new Error(`Browser artifact HTTP ${response.status}`);
        const chunks: Buffer[] = []; let length = 0;
        for await (const chunk of response.body) { length += chunk.length; if (length > 300 * 1024 * 1024) throw new Error('Browser artifact exceeds 300 MiB'); chunks.push(Buffer.from(chunk)); }
        bytes = Buffer.concat(chunks); break;
      }
      if (!bytes) throw new Error('Too many browser artifact redirects');
      await mkdir(dirname(archive), { recursive: true }); await writeFile(archive, bytes, { mode: 0o600 });
    }
    receipts.push({ url: original, sha256: digest(bytes), destination });
    const extracted = await run(['/usr/bin/ditto', '-x', '-k', archive, destination], [archive]);
    checks.push({ command: `Extract ${entry[2]} inside native sandbox`, ...extracted });
    if (extracted.code) return checks;
    const marker = await run(['node', '-e', 'require("fs").writeFileSync(process.argv[1],"")', join(destination, 'INSTALLATION_COMPLETE')]);
    checks.push({ command: 'Record completed browser installation', ...marker });
    if (marker.code) return checks;
  }
  await writeFile(join(stateRoot, `${digest(options.workspace)}-browsers.json`), JSON.stringify(receipts, null, 2), { mode: 0o600 });
  checks.push({ command: 'Playwright confirms owned browser installations without network', ...await run(['node', 'node_modules/playwright/cli.js', 'install', 'chromium']) });
  return checks;
}

export function npmArtifacts(text: string): Artifact[] {
  const lock = JSON.parse(text) as { lockfileVersion?: number; packages?: Record<string, { resolved?: string; integrity?: string; link?: boolean; inBundle?: boolean; os?: string[]; cpu?: string[] }> };
  if (!lock.packages || ![2, 3].includes(lock.lockfileVersion ?? 0)) throw new Error('A modern npm lockfile is required');
  const artifacts: Artifact[] = [];
  const compatible = (values: string[] | undefined, target: string): boolean => !values || (!values.includes(`!${target}`) && (!values.some(v => !v.startsWith('!')) || values.includes(target)));
  for (const [name, item] of Object.entries(lock.packages)) {
    if (!name) continue;
    if (item.inBundle) continue; // Included in the integrity-checked parent tarball.
    if (item.link || !item.resolved || !item.integrity) throw new Error(`Unlocked or local dependency is not supported: ${name}`);
    validateDependencyUrl(item.resolved);
    const match = /^sha512-([A-Za-z0-9+/]{86}==)$/.exec(item.integrity);
    if (!match) throw new Error(`A SHA512 package integrity is required: ${name}`);
    if (!compatible(item.os, process.platform) || !compatible(item.cpu, process.arch)) continue;
    const hash = Buffer.from(match[1], 'base64').toString('hex');
    artifacts.push({ url: item.resolved, algorithm: 'sha512', digest: hash, hostCache: cacheContent(join(homedir(), '.npm'), 'sha512', hash) });
  }
  return artifacts;
}

export function rubyArtifacts(text: string): Artifact[] {
  if (/^(?:GIT|PATH)\n/m.test(text) || !/^ {2}remote: https:\/\/rubygems\.org\/\s*$/m.test(text)
    || [...text.matchAll(/^ {2}remote: (.+)$/gm)].some(match => match[1].trim() !== 'https://rubygems.org/')) throw new Error('Only locked public RubyGems dependencies are supported');
  const section = text.split('\nCHECKSUMS\n')[1]?.split('\n\n')[0];
  if (!section) throw new Error('Gemfile.lock must contain artifact checksums');
  return [...section.matchAll(/^ {2}([A-Za-z0-9._-]+) \(([A-Za-z0-9._-]+)\) sha256=([a-f0-9]{64})$/gm)]
    .filter(match => !/(?:linux|mingw|java|x86_64-darwin)/.test(match[2]))
    .map(match => ({ url: `https://rubygems.org/downloads/${match[1]}-${match[2]}.gem`, algorithm: 'sha256' as const, digest: match[3], filename: `${match[1]}-${match[2]}.gem`,
      hostCache: join(homedir(), '.local/share/mise/installs/ruby/3.4.8/lib/ruby/gems/3.4.0/cache', `${match[1]}-${match[2]}.gem`) }));
}

export function validateAdvisoryQuery(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 100) throw new Error('Invalid npm advisory package inventory');
  const query = value as Record<string, unknown>;
  for (const [name, versions] of Object.entries(query)) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name) || name.length > 180 || !Array.isArray(versions) || !versions.length || versions.length > 8
      || versions.some(version => typeof version !== 'string' || version.length > 100 || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version))) throw new Error('Advisory queries may contain only bounded package names and versions');
  }
  return query as Record<string, string[]>;
}

async function prepareAdvisories(options: Options, environment: ToolEnvironment): Promise<Check[]> {
  const root = join(options.dataRoot, 'runtime/advisories'); await mkdir(root, { recursive: true });
  const signal = () => AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(60000)]);
  const currentPath = join(root, 'rubysec-current.json');
  let current: { commit: string; fetchedAtEpoch: number; database: string } | undefined;
  try { current = JSON.parse(await readFile(currentPath, 'utf8')); if (Date.now() / 1000 - current!.fetchedAtEpoch > 3600) current = undefined; } catch { /* Initial public advisory snapshot. */ }
  if (!current) {
    const response = await fetch('https://api.github.com/repos/rubysec/ruby-advisory-db/commits/master', { redirect: 'error', headers: { accept: 'application/vnd.github+json' }, signal: signal() });
    if (!response.ok) throw new Error(`Public RubySec revision HTTP ${response.status}`);
    const commit = ((await response.json()) as { sha?: string }).sha;
    if (!commit || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('RubySec did not return a concrete revision');
    const source = `https://codeload.github.com/rubysec/ruby-advisory-db/tar.gz/${commit}`;
    const downloaded = await fetch(source, { redirect: 'error', signal: signal() });
    if (!downloaded.ok || !downloaded.body) throw new Error(`Public RubySec snapshot HTTP ${downloaded.status}`);
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of downloaded.body) { size += chunk.length; if (size > 20 * 1024 * 1024) throw new Error('RubySec snapshot exceeds 20 MiB'); chunks.push(Buffer.from(chunk)); }
    const bytes = Buffer.concat(chunks); const archive = join(root, `${commit}.tar.gz`); await writeFile(archive, bytes, { mode: 0o600 });
    const target = join(root, 'rubysec', commit); await mkdir(target, { recursive: true });
    const extraction = await executeSandboxed({ ...options, command: ['/usr/bin/tar', '-xzf', archive, '-C', target], readPaths: [archive],
      toolEnvironment: { ...environment, readPaths: [...environment.readPaths, target], writePaths: [...environment.writePaths, target] } });
    if (extraction.code) throw new Error(`Sandbox RubySec extraction failed: ${extraction.stderr}`);
    current = { commit, fetchedAtEpoch: Math.floor(Date.now() / 1000), database: join(target, `ruby-advisory-db-${commit}`) };
    await writeFile(currentPath, JSON.stringify({ ...current, source, sha256: digest(bytes), noAuthentication: true }, null, 2), { mode: 0o600 });
  }
  await stat(current.database);
  environment.variables.BUNDLER_AUDIT_DB = current.database; environment.readPaths.push(current.database);
  const versionsSource = 'https://rubygems.org/api/v1/versions/brakeman.json';
  const versionsResponse = await fetch(versionsSource, { redirect: 'error', signal: signal() });
  if (!versionsResponse.ok) throw new Error(`Public Brakeman release metadata HTTP ${versionsResponse.status}`);
  const versions = await versionsResponse.json() as Array<{ number?: string; built_at?: string; prerelease?: boolean; platform?: string }>;
  const releases = versions.filter(item => item.prerelease === false && item.platform === 'ruby' && /^\d+(?:\.\d+)*$/.test(item.number ?? '') && Number.isFinite(Date.parse(item.built_at ?? '')));
  if (!releases.length) throw new Error('RubyGems returned no stable Brakeman releases');
  const latestSpec = join(root, 'brakeman-releases.json');
  await writeFile(latestSpec, JSON.stringify({ releases, fetchedAtEpoch: Math.floor(Date.now() / 1000), source: versionsSource, noAuthentication: true }, null, 2), { mode: 0o600 });
  environment.variables.OPENCORP_BRAKEMAN_RELEASE_CACHE = latestSpec; environment.readPaths.push(latestSpec);
  environment.variables.OPENCORP_PRODUCT_ROOT = options.workspace;
  const inventoryCode = 'require "active_support/all";require "importmap-rails";require "importmap/map";require "importmap/npm";puts "OPENCORP_AUDIT_QUERY="+JSON.generate(Importmap::Npm.new.packages_with_versions.each_with_object({}){|(name,version),out|(out[name]||=[])<<version})';
  const inventory = await executeSandboxed({ ...options, toolEnvironment: environment, command: ['bundle', 'exec', 'ruby', '-e', inventoryCode] });
  if (inventory.code) throw new Error(`Canonical importmap package inventory failed: ${inventory.stderr}`);
  const line = inventory.stdout.split('\n').find(line => line.startsWith('OPENCORP_AUDIT_QUERY='));
  if (!line) throw new Error('Importmap did not return an advisory package inventory');
  const query = validateAdvisoryQuery(JSON.parse(line.slice('OPENCORP_AUDIT_QUERY='.length)));
  const endpoint = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(query), redirect: 'error', signal: signal() });
  const body = await response.text();
  if (body.length > 2 * 1024 * 1024) throw new Error('Npm advisory response exceeds 2 MiB');
  if (!response.ok) throw new Error(`Public npm advisory query HTTP ${response.status}: ${body.slice(0, 500)}`);
  JSON.parse(body);
  const receipt = join(root, `npm-${digest(JSON.stringify(query))}.json`);
  await writeFile(receipt, JSON.stringify({ query, body, status: response.status, fetchedAtEpoch: Math.floor(Date.now() / 1000), source: endpoint, noAuthentication: true, incrementalCost: 0 }, null, 2), { mode: 0o600 });
  const shim = resolve(dependenciesRoot, '../src/runtime/advisory-cache.rb');
  environment.readPaths.push(receipt, shim);
  environment.variables.OPENCORP_NPM_AUDIT_CACHE = receipt;
  environment.variables.RUBYOPT = `-r${shim}`;
  return [{ command: 'Fresh public RubySec snapshot and canonical npm advisory query', code: 0, stdout: JSON.stringify({ rubysecCommit: current.commit, npmQuery: query, receiptPath: receipt, incrementalCost: 0 }), stderr: '' }];
}

async function fetchArtifact(artifact: Artifact, artifactsRoot: string, signal?: AbortSignal): Promise<{ path: string; downloaded: boolean }> {
  validateDependencyUrl(artifact.url);
  const path = join(artifactsRoot, artifact.algorithm, artifact.digest, artifact.filename ?? 'package.tgz');
  for (const candidate of [path, artifact.hostCache]) {
    if (!candidate) continue;
    try {
      const bytes = await readFile(candidate);
      if (digest(bytes, artifact.algorithm) !== artifact.digest) continue;
      // Owner caches may also contain private npm packages. Establish noauth
      // public availability before first reusing bytes from any ambient cache.
      let publicSource = false;
      try { publicSource = JSON.parse(await readFile(`${path}.source.json`, 'utf8')).url === artifact.url; } catch { /* First cached import. */ }
      if (!publicSource) {
        const published = await fetch(artifact.url, { method: 'HEAD', redirect: 'error', signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30000)]) });
        if (!published.ok) throw new Error(`Cached package is not publicly accessible without credentials: ${artifact.url}`);
        await mkdir(dirname(path), { recursive: true }); await writeFile(`${path}.source.json`, JSON.stringify({ url: artifact.url, verifiedAt: new Date().toISOString(), noAuthentication: true }), { mode: 0o600 });
      }
      if (candidate !== path) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes, { mode: 0o600 }); }
      return { path, downloaded: false };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  signal?.throwIfAborted();
  // Fetch has no ambient credentials. Redirects are refused, including redirects
  // to private/loopback services; only the two exact HTTPS artifact hosts pass.
  const response = await fetch(artifact.url, { redirect: 'error', signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(180000)]), headers: { accept: 'application/octet-stream' } });
  if (!response.ok || !response.body) throw new Error(`Public dependency fetch ${response.status}: ${artifact.url}`);
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 150 * 1024 * 1024) throw new Error(`Dependency exceeds the 150 MiB artifact limit: ${artifact.url}`);
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  if (digest(bytes, artifact.algorithm) !== artifact.digest) throw new Error(`Dependency integrity mismatch: ${artifact.url}`);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`; await writeFile(temp, bytes, { mode: 0o600 }); await rename(temp, path);
  await writeFile(`${path}.source.json`, JSON.stringify({ url: artifact.url, verifiedAt: new Date().toISOString(), noAuthentication: true }), { mode: 0o600 });
  return { path, downloaded: true };
}

async function scopedPaths(workspace: string, dataRoot: string): Promise<{ workspace: string; key: string; stateRoot: string; cacheRoot: string }> {
  const canonical = await realpath(workspace);
  const owned = await realpath(join(dataRoot, 'workspaces'));
  const child = relative(owned, canonical);
  if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('Dependency installation requires an isolated OpenCorp product workspace');
  const key = digest(canonical); const stateRoot = join(dataRoot, 'runtime/dependency-environments');
  const cacheRoot = join(dataRoot, 'runtime/dependency-workspaces', key);
  await mkdir(stateRoot, { recursive: true }); await mkdir(cacheRoot, { recursive: true });
  if (await realpath(cacheRoot) !== resolve(cacheRoot)) throw new Error('Dependency cache may not be redirected');
  return { workspace: canonical, key, stateRoot, cacheRoot };
}

const pending = new Map<string, Promise<DependencyResult>>();
export async function prepareProductDependencies(options: Options): Promise<DependencyResult> {
  const key = `${options.dataRoot}:${options.workspace}`;
  const existing = pending.get(key); if (existing) return existing;
  const work = prepare(options); pending.set(key, work);
  try { return await work; } finally { pending.delete(key); }
}

async function prepare(options: Options): Promise<DependencyResult> {
  const paths = await scopedPaths(options.workspace, options.dataRoot);
  const product = options.productName.toLowerCase();
  const node = join(homedir(), '.local/share/mise/installs/node/22.22.3');
  const ruby = join(homedir(), '.local/share/mise/installs/ruby/3.4.8');
  const lockfiles = product === 'openjob' ? ['package-lock.json', 'native/package-lock.json'] : product === 'palettewow' ? ['Gemfile.lock'] : product === 'walklang' ? [] : undefined;
  if (!lockfiles) throw new Error('Unknown product dependency policy');
  const locks = await Promise.all(lockfiles.map(path => readFile(join(paths.workspace, path), 'utf8')));
  const manifests = await Promise.all((product === 'openjob' ? ['package.json', 'native/package.json'] : product === 'palettewow' ? ['Gemfile'] : []).map(path => readFile(join(paths.workspace, path), 'utf8')));
  if (product === 'palettewow') manifests.push(await readFile(join(paths.workspace, 'config/importmap.rb'), 'utf8'));
  const lockDigest = digest([...locks, ...manifests].join('\n'));
  const receiptPath = join(paths.stateRoot, `${paths.key}.json`);
  const artifactsRoot = join(options.dataRoot, 'runtime/dependency-artifacts'); await mkdir(artifactsRoot, { recursive: true });
  const environment: ToolEnvironment = { binPaths: [], readPaths: [paths.cacheRoot], writePaths: [paths.cacheRoot], variables: {} };
  if (product === 'openjob') {
    await stat(join(node, 'bin/node')); environment.binPaths.push(join(node, 'bin')); environment.readPaths.push(node);
    environment.variables = { npm_config_cache: join(paths.cacheRoot, 'npm'), npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_registry: 'https://registry.npmjs.org', PLAYWRIGHT_BROWSERS_PATH: join(paths.cacheRoot, 'browsers') };
  } else if (product === 'palettewow') {
    await stat(join(ruby, 'bin/ruby')); environment.binPaths.push(join(ruby, 'bin')); environment.readPaths.push(ruby);
    environment.variables = { BUNDLE_PATH: join(paths.cacheRoot, 'bundle'), BUNDLE_CACHE_PATH: join(paths.cacheRoot, 'gem-cache'), BUNDLE_USER_CACHE: join(paths.cacheRoot, 'bundler-cache'), BUNDLE_USER_CONFIG: join(paths.cacheRoot, 'bundler-config'), BUNDLE_FROZEN: 'true', BUNDLE_DISABLE_SHARED_GEMS: 'true', BUNDLE_IGNORE_CONFIG: 'true', GEM_HOME: join(paths.cacheRoot, 'gems'), GEM_PATH: join(ruby, 'lib/ruby/gems/3.4.0'), BUNDLE_BUILD__PG: '--with-pg-config=/opt/homebrew/opt/libpq/bin/pg_config' };
  }
  const result: DependencyResult = { workspace: paths.workspace, productName: options.productName, lockDigest, environment, installed: false, checks: [], receiptPath, artifacts: 0, downloaded: 0, reused: 0, incrementalCost: 0 };
  // Reuse completed environments only while lockfiles and installed roots remain present.
  try {
    const saved = JSON.parse(await readFile(receiptPath, 'utf8')) as DependencyResult;
    if (saved.installed && saved.lockDigest === lockDigest && saved.workspace === paths.workspace) {
      const check = await executeSandboxed({ workspace: paths.workspace, dataRoot: options.dataRoot, signal: options.signal, toolEnvironment: environment,
        command: product === 'palettewow' ? ['bundle', 'check'] : product === 'openjob' ? ['node', '-e', 'require.resolve("next/package.json");require.resolve("react-native/package.json",{paths:["./native"]})'] : ['/usr/bin/true'] });
      if (check.code === 0) {
        if (product === 'palettewow') { saved.checks.push(...await prepareAdvisories(options, environment)); saved.environment = environment; await writeFile(receiptPath, JSON.stringify(saved, null, 2), { mode: 0o600 }); }
        return { ...saved, environment };
      }
    }
  } catch { /* Missing/incomplete environments are prepared under the same boundary. */ }
  try {
    const artifacts = [...new Map(locks.flatMap(text => product === 'openjob' ? npmArtifacts(text) : rubyArtifacts(text)).map(item => [`${item.algorithm}:${item.digest}`, item])).values()];
    result.artifacts = artifacts.length;
    const copies: Array<{ source: string; destination: string }> = [];
    let next = 0;
    const downloads = await Promise.allSettled(Array.from({ length: Math.min(8, artifacts.length) }, async () => {
      while (next < artifacts.length) {
        const artifact = artifacts[next++]; const fetched = await fetchArtifact(artifact, artifactsRoot, options.signal);
        if (fetched.downloaded) result.downloaded++; else result.reused++;
        copies.push({ source: fetched.path, destination: product === 'openjob' ? cacheContent(join(paths.cacheRoot, 'npm'), artifact.algorithm, artifact.digest) : join(paths.cacheRoot, 'gem-cache', artifact.filename!) });
      }
    }));
    const failed = downloads.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    const manifestPath = join(paths.stateRoot, `${paths.key}-${randomUUID()}.imports.json`);
    await writeFile(manifestPath, JSON.stringify(copies), { mode: 0o600 });
    const imported = await executeSandboxed({ workspace: paths.workspace, dataRoot: options.dataRoot, signal: options.signal, toolEnvironment: environment, readPaths: [artifactsRoot, manifestPath],
      command: [process.execPath, '-e', 'const fs=require("fs"),path=require("path");for(const i of JSON.parse(fs.readFileSync(process.argv[1],"utf8"))){fs.mkdirSync(path.dirname(i.destination),{recursive:true});fs.copyFileSync(i.source,i.destination)}', manifestPath] });
    result.checks.push({ command: 'Import verified public dependency artifacts inside native sandbox', ...imported });
    if (imported.code !== 0) throw new Error('Sandbox dependency cache import failed');
    const commands = product === 'openjob' ? [['node', '--version'], ['npm', 'ci', '--offline', '--include=dev', '--no-audit', '--no-fund']]
      : product === 'palettewow' ? [['ruby', '--version'], ['bundle', '--version'], ['bundle', 'install', '--local', '--jobs=4'], ['bundle', 'check']] : [];
    for (const command of commands) {
      const check = await executeSandboxed({ workspace: paths.workspace, dataRoot: options.dataRoot, signal: options.signal, toolEnvironment: environment, command, timeoutMs: 20 * 60 * 1000 });
      result.checks.push({ command: command.join(' '), ...check });
      options.signal?.throwIfAborted();
      // Bundler's exact frozen-definition failure occurs only after verified
      // artifact import and successful Ruby/Bundler checks. It permits editing
      // dependency files, never an installed environment or canonical success.
      if (product === 'palettewow' && command.join(' ') === 'bundle install --local --jobs=4' && check.code === 16
        && check.stderr.startsWith("The dependencies in your gemfile changed, but the lockfile can't be updated\nbecause frozen mode is set\n")) {
        result.repair = { kind: 'bundler_frozen_lock_mismatch', command: command.join(' '), code: 16,
          diagnostics: redact(`${check.stdout}\n${check.stderr}`).slice(0, 4000) };
      }
      if (check.code !== 0) throw new Error(`Dependency preparation failed: ${command.join(' ')}`);
    }
    if (product === 'openjob') {
      const browsers = await prepareBrowsers(options, environment, paths.stateRoot, artifactsRoot); result.checks.push(...browsers);
      if (browsers.some(check => check.code)) throw new Error('Browser artifact preparation failed');
    }
    if (product === 'palettewow') result.checks.push(...await prepareAdvisories(options, environment));
    result.installed = true;
  } catch (error) {
    result.checks.push({ command: 'Dependency preparation', code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) });
  }
  await writeFile(receiptPath, JSON.stringify({ ...result, completedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  return result;
}

/** Read only the adapter-owned receipt; never accept a worker-supplied environment. */
export async function productToolEnvironment(options: { workspace: string; dataRoot: string }): Promise<ToolEnvironment | undefined> {
  const paths = await scopedPaths(options.workspace, options.dataRoot);
  try {
    const receipt = JSON.parse(await readFile(join(paths.stateRoot, `${paths.key}.json`), 'utf8')) as DependencyResult;
    if (receipt.workspace === paths.workspace && receipt.installed) return receipt.environment;
  } catch { /* Environment has not yet been prepared. */ }
  return undefined;
}
