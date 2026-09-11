import { createServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, stat, lstat, readlink, writeFile, mkdir, link, unlink, rename } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { minimalEnvironment, prepareHome, spawnOwned, stopOwned, recoverOwnedReceipt, type OwnedProcess } from './processes.js';
import { MODEL_ALIASES, CONTEXT_TOKENS, type LocalModel, type LocalInferenceProfile, type RuntimeOptions } from './types.js';

const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
type ModelBlob = { digest: string; size: number };
function manifestBlobs(raw: Buffer): ModelBlob[] {
  const manifest = JSON.parse(raw.toString()) as { layers: ModelBlob[]; config: ModelBlob };
  if (!Array.isArray(manifest.layers) || !manifest.config) throw new Error('Invalid local model manifest');
  const blobs = [...manifest.layers, manifest.config];
  if (blobs.some(blob => !/^sha256:[a-f0-9]{64}$/.test(blob.digest) || !Number.isSafeInteger(blob.size) || blob.size < 0)) throw new Error('Invalid local layer identity');
  return blobs;
}

/** Owned inference behavior is distinct from the shared source model. */
export function localInferenceProfile(modelId: string): LocalInferenceProfile | undefined {
  return modelId === 'qwen-main' ? { id: 'qwen-no-thinking-v1', reasoningEffort: 'none' } : undefined;
}

export function localArtifactIdentity(model: Pick<LocalModel, 'alias' | 'manifestDigest' | 'templateDigest' | 'parametersDigest' | 'contextTokens' | 'inferenceProfile'>): string {
  const { alias, manifestDigest, templateDigest, parametersDigest, contextTokens, inferenceProfile } = model;
  return digest(JSON.stringify({ alias, manifestDigest, templateDigest, parametersDigest, contextTokens, cloudDisabled: true,
    ...(inferenceProfile ? { inferenceProfile } : {}) }));
}

export async function availablePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('No loopback port'));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

export class OwnedOllama {
  private process?: OwnedProcess;
  private starting?: Promise<void>;
  private generation = 0;
  private startup?: AbortController;
  private output = '';
  url = '';
  readonly modelStore: string;
  readonly sourceModelStore: string;
  readonly root: string;
  constructor(private readonly options: RuntimeOptions) {
    this.root = join(options.dataRoot, 'runtime', 'ollama');
    this.sourceModelStore = options.modelStore ?? join(homedir(), '.ollama', 'models');
    this.modelStore = join(this.root, 'models');
  }

  async start(): Promise<void> {
    if (this.process?.exitCode === null && this.url) return;
    if (this.starting) return this.starting;
    const generation = this.generation;
    const controller = new AbortController(); this.startup = controller;
    const pending = this.launch(generation, controller.signal); this.starting = pending;
    try { await pending; } finally { if (this.starting === pending) this.starting = undefined; }
  }

  private manifestPath(store: string, alias: string): string {
    const [name, version] = alias.split(':');
    return join(store, 'manifests', 'registry.ollama.ai', 'library', name!, version!);
  }

  private async importBlob(blob: ModelBlob, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const filename = blob.digest.replace(':', '-'), target = join(this.modelStore, 'blobs', filename);
    try { const existing = await lstat(target); if (!existing.isFile() || existing.size !== blob.size) throw new Error('Incomplete owned local blob'); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const source = join(this.sourceModelStore, 'blobs', filename), entry = await lstat(source);
    if (!entry.isFile() || entry.size !== blob.size) throw new Error('Incomplete source local blob');
    signal.throwIfAborted();
    try { await link(source, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await pipeline(createReadStream(source), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal });
        signal.throwIfAborted();
        if ((await stat(temporary)).size !== blob.size) throw new Error('Incomplete copied local blob');
        await rename(temporary, target);
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    }
  }

  private async prepareModelStore(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await mkdir(this.modelStore, { recursive: true, mode: 0o700 });
    const blobs = join(this.modelStore, 'blobs');
    try {
      const entry = await lstat(blobs);
      if (entry.isSymbolicLink()) {
        if (resolve(dirname(blobs), await readlink(blobs)) !== resolve(this.sourceModelStore, 'blobs')) throw new Error('Unexpected owned blob directory symlink');
        signal.throwIfAborted(); await unlink(blobs); // Remove only the legacy link, never its shared target.
      } else if (!entry.isDirectory()) throw new Error('Owned blobs must be an ordinary directory');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await mkdir(blobs, { recursive: true, mode: 0o700 });
    for (const alias of Object.values(MODEL_ALIASES)) {
      signal.throwIfAborted();
      let raw: Buffer;
      try { raw = await readFile(this.manifestPath(this.sourceModelStore, alias)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      for (const blob of manifestBlobs(raw)) await this.importBlob(blob, signal);
      const target = this.manifestPath(this.modelStore, alias), temporary = `${target}.${randomUUID()}.tmp`;
      await mkdir(dirname(target), { recursive: true });
      try { signal.throwIfAborted(); await writeFile(temporary, raw, { flag: 'wx', mode: 0o600 }); signal.throwIfAborted(); await rename(temporary, target); }
      finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    }
    // Preserve available generated layers during legacy migration. Missing
    // derived metadata is recreated from the permitted owned source in models().
    for (const id of Object.keys(MODEL_ALIASES)) for (const context of [16384, 32768]) {
      signal.throwIfAborted();
      let raw: Buffer;
      try { raw = await readFile(this.manifestPath(this.modelStore, `opencorp-${id}-${context}:latest`)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      for (const blob of manifestBlobs(raw)) try { await this.importBlob(blob, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    signal.throwIfAborted();
  }

  private async checkedManifest(alias: string, expectedDigest: string): Promise<Buffer> {
    const raw = await readFile(this.manifestPath(this.modelStore, alias));
    if (digest(raw) !== expectedDigest) throw new Error(`Artifact identity disagreement for ${alias}`);
    for (const layer of manifestBlobs(raw)) {
      const blob = await lstat(join(this.modelStore, 'blobs', layer.digest.replace(':', '-')));
      if (!blob.isFile() || blob.size !== layer.size) throw new Error(`Incomplete local artifact: ${alias}`);
    }
    return raw;
  }

  private async launch(generation: number, signal: AbortSignal): Promise<void> {
    await prepareHome(this.root);
    const previousReceipt = join(this.root, 'process.json');
    try {
      await accessReceipt(previousReceipt);
      const previous = await recoverOwnedReceipt(previousReceipt, true);
      if (previous.status !== 'absent') throw new Error(`Previous owned Ollama process requires reconciliation: ${previousReceipt} (${previous.status})`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    signal.throwIfAborted();
    await this.prepareModelStore(signal);
    const port = await availablePort();
    signal.throwIfAborted();
    this.url = `http://127.0.0.1:${port}`;
    const binary = this.options.ollamaBinary ?? '/Applications/Ollama.app/Contents/Resources/ollama';
    const child = await spawnOwned({
      controlRoot: join(this.options.dataRoot, 'runtime', 'control'), command: binary,
      args: ['serve'], cwd: this.root,
      signal, receiptPath: join(this.root, 'process.json'),
      env: {
        ...minimalEnvironment(this.root), OLLAMA_HOST: `127.0.0.1:${port}`,
        OLLAMA_MODELS: this.modelStore, OLLAMA_NO_CLOUD: '1',
        OLLAMA_CONTEXT_LENGTH: String(CONTEXT_TOKENS), OLLAMA_NUM_PARALLEL: '1',
        OLLAMA_MAX_LOADED_MODELS: '1', OLLAMA_KEEP_ALIVE: '60s',
        OLLAMA_MAX_QUEUE: '1', OLLAMA_FLASH_ATTENTION: '1', OLLAMA_KV_CACHE_TYPE: 'q8_0',
      },
      onOutput: (chunk) => { this.output = (this.output + chunk).slice(-16000); },
    });
    if (generation !== this.generation || signal.aborted) {
      await stopOwned(child); signal.throwIfAborted(); throw new Error('Ollama startup superseded by stop');
    }
    this.process = child;
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      signal.throwIfAborted();
      if (child.exitCode !== null) throw new Error(`Owned Ollama exited: ${this.output}`);
      try {
        const response = await fetch(`${this.url}/api/version`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) {
          signal.throwIfAborted();
          await writeFile(join(this.root, 'service.json'), JSON.stringify({
            url: this.url, guardianPid: child.pid, ownerPid: process.pid,
            version: await response.json(), cloudDisabled: true,
            contextTokens: CONTEXT_TOKENS, concurrentInference: 1, modelStore: this.modelStore,
          }, null, 2), { mode: 0o600 });
          return;
        }
      } catch { /* Wait for owned service readiness. */ }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await stopOwned(child);
    throw new Error(`Owned Ollama startup timed out: ${this.output}`);
  }

  async ensureSmallModel(): Promise<void> {
    const tags = await this.tags();
    if (tags.some((model) => model.name === MODEL_ALIASES.small)) return;
    this.options.onEvent?.({ type: 'model.download', payload: { alias: MODEL_ALIASES.small, status: 'starting' } });
    const response = await fetch(`${this.url}/api/pull`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL_ALIASES.small, stream: true }),
      signal: AbortSignal.timeout(30 * 60 * 1000),
    });
    if (!response.ok || !response.body) throw new Error(`Local small-model download failed: ${await response.text()}`);
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += new TextDecoder().decode(chunk);
      const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const update = JSON.parse(line) as { error?: string; status: string; completed?: number; total?: number };
        if (update.error) throw new Error(`Local small-model download: ${update.error}`);
        this.options.onEvent?.({ type: 'model.download', payload: update });
      }
    }
  }

  private async tags(): Promise<Array<{ name: string; digest: string; size: number; remote_host?: string; remote_model?: string }>> {
    const response = await fetch(`${this.url}/api/tags`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Owned Ollama model inventory HTTP ${response.status}`);
    return (await response.json() as { models: Array<{ name: string; digest: string; size: number }> }).models;
  }

  async models(contextTokens: 16384 | 32768 = CONTEXT_TOKENS): Promise<LocalModel[]> {
    await this.start();
    const tags = await this.tags();
    const models: LocalModel[] = [];
    for (const [id, sourceAlias] of Object.entries(MODEL_ALIASES)) {
      const sourceTag = tags.find((model) => model.name === sourceAlias);
      if (!sourceTag) continue;
      if (sourceTag.remote_host || sourceTag.remote_model) throw new Error(`Hosted source refused: ${sourceAlias}`);
      const alias = `opencorp-${id}-${contextTokens}:latest`;
      let tag = tags.find((model) => model.name === alias);
      const profileSourcePath = join(this.root, `${id}-${contextTokens}.source`);
      let oldSource = '';
      try { oldSource = await readFile(profileSourcePath, 'utf8'); } catch { /* New profile. */ }
      let missingProfile = !tag;
      if (tag) try { await this.checkedManifest(alias, tag.digest); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; missingProfile = true; }
      if (missingProfile || oldSource !== sourceTag.digest) {
        const repairDigest = missingProfile && oldSource === sourceTag.digest ? tag?.digest : undefined;
        await this.checkedManifest(sourceAlias, sourceTag.digest);
        const created = await fetch(`${this.url}/api/create`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: alias, from: sourceAlias, parameters: { num_ctx: contextTokens, num_predict: 4096, temperature: 0.2 }, stream: false }),
          signal: AbortSignal.timeout(60000),
        });
        if (!created.ok) throw new Error(`Cannot prepare isolated local profile: ${await created.text()}`);
        tag = (await this.tags()).find((entry) => entry.name === alias);
        if (!tag) throw new Error('Created local profile absent from inventory');
        if (repairDigest && tag.digest !== repairDigest) throw new Error('Recreated local profile identity changed');
        await writeFile(profileSourcePath, sourceTag.digest, { mode: 0o600 });
      }
      if (!tag || tag.remote_host || tag.remote_model || /cloud/i.test(alias)) throw new Error(`Hosted artifact refused: ${alias}`);
      const raw = await this.checkedManifest(alias, tag.digest);
      const manifestDigest = digest(raw);
      const response = await fetch(`${this.url}/api/show`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: alias }), signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`Cannot inspect local artifact ${alias}`);
      const show = await response.json() as { template?: string; parameters?: string; capabilities?: string[]; remote_host?: string; remote_model?: string };
      if (show.remote_host || show.remote_model) throw new Error(`Hosted profile refused: ${alias}`);
      const templateDigest = digest(show.template ?? '');
      // Ollama renders parameter maps in unspecified order. Identity tracks
      // their values, not incidental map iteration ordering between requests.
      const parametersDigest = digest((show.parameters ?? '').split('\n').map((line) => line.trim()).filter(Boolean).sort().join('\n'));
      const inferenceProfile = localInferenceProfile(id);
      const artifactIdentity = localArtifactIdentity({ alias, manifestDigest, templateDigest, parametersDigest, contextTokens, inferenceProfile });
      models.push({ id, name: sourceAlias, alias, sourceAlias, provider: 'ollama', local: true, available: true,
        manifestDigest, templateDigest, parametersDigest, artifactIdentity, ...(inferenceProfile ? { inferenceProfile } : {}),
        size: tag.size, capabilities: show.capabilities ?? [], contextTokens });
    }
    return models;
  }

  async verifyIdentity(model: LocalModel): Promise<void> {
    if (JSON.stringify(model.inferenceProfile) !== JSON.stringify(localInferenceProfile(model.id))
      || localArtifactIdentity(model) !== model.artifactIdentity) throw new Error('Local inference profile identity changed; inference refused');
    const [name, version] = model.alias.split(':');
    const raw = await readFile(join(this.modelStore, 'manifests', 'registry.ollama.ai', 'library', name!, version!));
    if (digest(raw) !== model.manifestDigest) throw new Error('Model alias changed during run; inference refused');
  }

  status(): { url: string; guardianPid?: number; running: boolean; cloudDisabled: true; concurrentInference: 1 } {
    return { url: this.url, guardianPid: this.process?.pid, running: this.process?.exitCode === null,
      cloudDisabled: true, concurrentInference: 1 };
  }

  async stop(): Promise<void> {
    this.generation++; this.startup?.abort(new Error('Owned Ollama stopped during startup'));
    const starting = this.starting;
    const child = this.process; this.process = undefined;
    await stopOwned(child);
    if (starting) await starting.catch(() => {});
    this.url = '';
  }
}

async function accessReceipt(path: string): Promise<void> { await stat(path); }
