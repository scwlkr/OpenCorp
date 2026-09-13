import { createServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, stat, lstat, readlink, writeFile, mkdir, link, unlink, rename } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { minimalEnvironment, prepareHome, spawnOwned, stopOwned, recoverOwnedReceipt, type OwnedProcess } from './processes.js';
import { resourceLimits, ResourceAdmissionError } from './resource-budget.js';
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

/** New candidates are never added to the existing default download set. */
export function microInstallSelection(ids:unknown=['micro-06','micro-17']):Array<'micro-06'|'micro-17'|'micro-4'> {
  if(!Array.isArray(ids)||!ids.length||ids.length>3||new Set(ids).size!==ids.length||ids.some(id=>!['micro-06','micro-17','micro-4'].includes(id)))throw new Error('Select exact micro model IDs: micro-06, micro-17 or micro-4');
  return [...ids];
}

/** Owned inference behavior is distinct from the shared source model. */
export function localInferenceProfile(modelId: string, nemotronProfile?: RuntimeOptions['nemotronInferenceProfile']): LocalInferenceProfile | undefined {
  if (modelId === 'qwen-low-reasoning-48k') return { id: 'qwen-low-reasoning-v1', reasoningEffort: 'low' };
  if (modelId === 'nemotron-no-thinking-v1') return { id: 'nemotron-no-thinking-v1', reasoningEffort: 'none' };
  if (modelId === 'nemotron' && nemotronProfile === 'nemotron-no-thinking-v1') return { id: nemotronProfile, reasoningEffort: 'none' };
  return modelId === 'qwen-main' || modelId === 'qwen-main-48k' || modelId.startsWith('micro-') ? { id: 'qwen-no-thinking-v1', reasoningEffort: 'none' } : undefined;
}

export function localArtifactIdentity(model: Pick<LocalModel, 'alias' | 'manifestDigest' | 'templateDigest' | 'parametersDigest' | 'contextTokens' | 'inferenceProfile'>): string {
  const { alias, manifestDigest, templateDigest, parametersDigest, contextTokens, inferenceProfile } = model;
  return digest(JSON.stringify({ alias, manifestDigest, templateDigest, parametersDigest, contextTokens, cloudDisabled: true,
    ...(inferenceProfile ? { inferenceProfile } : {}) }));
}


/** Resolve explicit selections first; shared weight aliases always select the default entry. */
export function selectLocalModel(models: LocalModel[], selection: string): LocalModel | undefined {
  return models.find(model => model.id === selection)
    ?? models.find(model => !['nemotron-no-thinking-v1', 'qwen-main-48k', 'qwen-low-reasoning-48k'].includes(model.id) && (model.alias === selection || model.sourceAlias === selection))
    ?? models.find(model => ['nemotron-no-thinking-v1', 'qwen-main-48k', 'qwen-low-reasoning-48k'].includes(model.id) && model.name === selection);
}

/** The virtual profile shares weights, but must not overwrite their default inventory row. */
export function localModelSelectionId(model: Pick<LocalModel, 'id' | 'sourceAlias'>): string {
  return ['nemotron-no-thinking-v1', 'qwen-main-48k', 'qwen-low-reasoning-48k'].includes(model.id) ? model.id : model.sourceAlias;
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
  private inventoryTail: Promise<unknown> = Promise.resolve();
  private inventoryAbort = new AbortController();
  private stopping?: Promise<void>;
  url = '';
  readonly modelStore: string;
  readonly sourceModelStore: string;
  readonly root: string;
  constructor(private readonly options: RuntimeOptions, private readonly pool: 'primary' | 'micro' = 'primary') {
    this.root = join(options.dataRoot, 'runtime', pool === 'micro' ? 'ollama-micro' : 'ollama');
    this.sourceModelStore = options.modelStore ?? join(homedir(), '.ollama', 'models');
    this.modelStore = join(this.root, 'models');
  }

  private aliases() { return Object.entries(MODEL_ALIASES).filter(([id]) => id.startsWith('micro-') === (this.pool === 'micro')); }

  async start(): Promise<void> {
    if (this.stopping) throw new Error('Owned Ollama is stopping');
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
    for (const [, alias] of this.aliases()) {
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
    for (const [id] of this.aliases()) for (const context of (id === 'qwen-main' ? [16384, 32768, 49152] : [16384, 32768])) {
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
    const limits = resourceLimits(this.options.resourceBudget);
    const parallel = this.pool === 'micro' ? Math.min(10, limits.maxSocialTurns, limits.maxConcurrentTurns) : (limits.productiveRemoteModelId||limits.productiveRemoteProfiles) ? 1 : limits.maxProductiveTurns;
    const child = await spawnOwned({
      controlRoot: join(this.options.dataRoot, 'runtime', 'control'), command: binary,
      args: ['serve'], cwd: this.root,
      signal, receiptPath: join(this.root, 'process.json'),
      env: {
        ...minimalEnvironment(this.root), OLLAMA_HOST: `127.0.0.1:${port}`,
        OLLAMA_MODELS: this.modelStore, OLLAMA_NO_CLOUD: '1',
        OLLAMA_CONTEXT_LENGTH: String(CONTEXT_TOKENS), OLLAMA_NUM_PARALLEL: String(parallel),
        OLLAMA_MAX_LOADED_MODELS: '1', OLLAMA_KEEP_ALIVE: '60s',
        OLLAMA_MAX_QUEUE: String(limits.maxConcurrentTurns), OLLAMA_FLASH_ATTENTION: '1', OLLAMA_KV_CACHE_TYPE: 'q8_0',
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
            contextTokens: CONTEXT_TOKENS, concurrentInference: parallel, maxLoadedModels: 1, pool: this.pool, modelStore: this.modelStore,
          }, null, 2), { mode: 0o600 });
          return;
        }
      } catch { /* Wait for owned service readiness. */ }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await stopOwned(child);
    throw new Error(`Owned Ollama startup timed out: ${this.output}`);
  }

  async ensureSmallModel(): Promise<void> { await this.ensureModel('small'); }

  async ensureMicroModels(ids?:unknown): Promise<void> {
    const selected=microInstallSelection(ids), signal=this.inventoryAbort.signal;
    for(const id of selected){signal.throwIfAborted();await this.ensureModel(id);}
  }

  private async ensureModel(id: keyof typeof MODEL_ALIASES): Promise<void> {
    if (this.stopping) throw new Error('Owned Ollama is stopping');
    const signal = this.inventoryAbort.signal;
    signal.throwIfAborted();
    if (!this.aliases().some(([allowed]) => allowed === id)) throw new Error('Model is outside this owned inference pool');
    const alias = MODEL_ALIASES[id];
    const tags = await this.tags(signal);
    signal.throwIfAborted();
    if (tags.some((model) => model.name === alias)) return;
    this.options.onEvent?.({ type: 'model.download', payload: { alias, status: 'starting' } });
    const response = await fetch(`${this.url}/api/pull`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: alias, stream: true }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30 * 60 * 1000)]),
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
    if (buffer.trim()) {
      const final = JSON.parse(buffer) as { error?: string };
      if (final.error) throw new Error(`Local model download: ${final.error}`);
    }
    signal.throwIfAborted();
    const installed = (await this.tags(signal)).find(model => model.name === alias);
    if (!installed || installed.remote_host || installed.remote_model) throw new Error('Downloaded local model absent or hosted');
    await this.checkedManifest(alias, installed.digest);
    signal.throwIfAborted();
    await writeFile(join(this.root, `${id}.download.json`), JSON.stringify({ alias, manifestDigest: installed.digest,
      size: installed.size, source: `https://ollama.com/library/${alias}`, downloadedAt: new Date().toISOString(),
      modelStore: this.modelStore, localOnly: true }, null, 2), { mode: 0o600 });
  }

  private async tags(signal: AbortSignal = this.inventoryAbort.signal): Promise<Array<{ name: string; digest: string; size: number; remote_host?: string; remote_model?: string }>> {
    const response = await fetch(`${this.url}/api/tags`, { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
    if (!response.ok) throw new Error(`Owned Ollama model inventory HTTP ${response.status}`);
    return (await response.json() as { models: Array<{ name: string; digest: string; size: number }> }).models;
  }

  async models(contextTokens: 16384 | 32768 | 49152 = CONTEXT_TOKENS): Promise<LocalModel[]> {
    if (this.stopping) throw new Error('Owned Ollama is stopping');
    const generation = this.generation, signal = this.inventoryAbort.signal;
    const pending = this.inventoryTail.then(() => {
      signal.throwIfAborted();
      if (generation !== this.generation) throw new Error('Owned model inventory superseded by stop');
      return this.readModels(contextTokens, signal);
    });
    this.inventoryTail = pending.catch(() => {});
    return pending;
  }

  private async readModels(contextTokens: 16384 | 32768 | 49152, signal: AbortSignal): Promise<LocalModel[]> {
    signal.throwIfAborted();
    await this.start();
    signal.throwIfAborted();
    const tags = await this.tags(signal);
    const models: LocalModel[] = [];
    for (const [id, sourceAlias] of this.aliases()) {
      if (contextTokens === 49152 && id !== 'qwen-main') continue;
      signal.throwIfAborted();
      const sourceTag = tags.find((model) => model.name === sourceAlias);
      if (!sourceTag) continue;
      if (this.pool === 'micro' && sourceTag.size > (id === 'micro-4' ? 3 : 2) * 1024 ** 3) throw new Error('Micro pool refuses weights larger than the selected artifact budget');
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
          signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
        });
        if (!created.ok) throw new Error(`Cannot prepare isolated local profile: ${await created.text()}`);
        tag = (await this.tags(signal)).find((entry) => entry.name === alias);
        if (!tag) throw new Error('Created local profile absent from inventory');
        if (repairDigest && tag.digest !== repairDigest) throw new Error('Recreated local profile identity changed');
        await writeFile(profileSourcePath, sourceTag.digest, { mode: 0o600 });
      }
      if (!tag || tag.remote_host || tag.remote_model || /cloud/i.test(alias)) throw new Error(`Hosted artifact refused: ${alias}`);
      const raw = await this.checkedManifest(alias, tag.digest);
      const manifestDigest = digest(raw);
      const response = await fetch(`${this.url}/api/show`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: alias }), signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      });
      if (!response.ok) throw new Error(`Cannot inspect local artifact ${alias}`);
      const show = await response.json() as { template?: string; parameters?: string; capabilities?: string[]; remote_host?: string; remote_model?: string };
      if (show.remote_host || show.remote_model) throw new Error(`Hosted profile refused: ${alias}`);
      const templateDigest = digest(show.template ?? '');
      // Ollama renders parameter maps in unspecified order. Identity tracks
      // their values, not incidental map iteration ordering between requests.
      const parametersDigest = digest((show.parameters ?? '').split('\n').map((line) => line.trim()).filter(Boolean).sort().join('\n'));
      const inferenceProfile = localInferenceProfile(id, this.options.nemotronInferenceProfile);
      const artifactIdentity = localArtifactIdentity({ alias, manifestDigest, templateDigest, parametersDigest, contextTokens, inferenceProfile });
      models.push({ id: contextTokens === 49152 ? 'qwen-main-48k' : id, name: contextTokens === 49152 ? 'Qwen (48K context)' : sourceAlias, alias, sourceAlias, provider: 'ollama', local: true, available: true,
        manifestDigest, templateDigest, parametersDigest, artifactIdentity, ...(inferenceProfile ? { inferenceProfile } : {}),
        size: tag.size, sizeClass: id.startsWith('micro-') ? 'micro' : id === 'small' ? 'small' : 'large', capabilities: show.capabilities ?? [], contextTokens });
      // Current Qwen GGUF Jinja template explicitly supports the qualitative low cue.
      if (contextTokens === 49152 && show.capabilities?.includes('thinking') && show.template?.includes("resolved_reasoning_effort == 'low'") && show.template.includes('Reasoning effort is set to low.')) {
        const variant = { ...models.at(-1)!, id: 'qwen-low-reasoning-48k', name: 'Qwen (48K low reasoning)', inferenceProfile: localInferenceProfile('qwen-low-reasoning-48k') };
        models.push({ ...variant, artifactIdentity: localArtifactIdentity(variant) });
      }
    }
    if (contextTokens !== 49152 && this.pool === 'primary') models.push(...await this.readModels(49152, signal));
    const nemotron = models.find(model => model.id === 'nemotron');
    if (nemotron && !this.options.nemotronInferenceProfile) {
      const variant = { ...nemotron, id: 'nemotron-no-thinking-v1', name: 'Nemotron (no thinking)', inferenceProfile: localInferenceProfile('nemotron-no-thinking-v1') };
      models.push({ ...variant, artifactIdentity: localArtifactIdentity(variant) });
    }
    signal.throwIfAborted();
    return models;
  }

  /** Called under runtime admission serialization; never evicts a model with active turns. */
  async prepareResidency(model: LocalModel, mayEvict: boolean, signal: AbortSignal): Promise<number> {
    const combined = AbortSignal.any([signal, this.inventoryAbort.signal]);
    const loaded = async () => {
      combined.throwIfAborted();
      const response = await fetch(`${this.url}/api/ps`, { signal: AbortSignal.any([combined, AbortSignal.timeout(10000)]) });
      if (!response.ok) throw new Error(`Owned model residency HTTP ${response.status}`);
      const body = await response.json() as { models: Array<{ name: string; digest: string; size_vram: number }> };
      if (!Array.isArray(body.models)) throw new Error('Invalid owned residency observation');
      return body.models;
    };
    let residents = await loaded();
    for (const resident of residents.filter(entry => entry.name !== model.alias || entry.digest !== model.manifestDigest)) {
      if (!mayEvict) throw new ResourceAdmissionError('Owned model pool is occupied by another active profile');
      const response = await fetch(`${this.url}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: resident.name, keep_alive: 0, stream: false }), signal: AbortSignal.any([combined, AbortSignal.timeout(30000)]) });
      if (!response.ok) throw new Error(`Owned idle model unload HTTP ${response.status}`);
      await response.text();
    }
    residents = await loaded();
    if (residents.some(entry => entry.name !== model.alias || entry.digest !== model.manifestDigest)) throw new Error('Owned idle model still resident after unload');
    const resident = residents.find(entry => entry.name === model.alias && entry.digest === model.manifestDigest);
    return resident && Number.isFinite(resident.size_vram) && resident.size_vram > 0 ? Math.min(model.size * 1.2, resident.size_vram) : 0;
  }

  async verifyIdentity(model: LocalModel): Promise<void> {
    if (JSON.stringify(model.inferenceProfile) !== JSON.stringify(localInferenceProfile(model.id, this.options.nemotronInferenceProfile))
      || localArtifactIdentity(model) !== model.artifactIdentity) throw new Error('Local inference profile identity changed; inference refused');
    const [name, version] = model.alias.split(':');
    const raw = await readFile(join(this.modelStore, 'manifests', 'registry.ollama.ai', 'library', name!, version!));
    if (digest(raw) !== model.manifestDigest) throw new Error('Model alias changed during run; inference refused');
  }

  status(): { url: string; guardianPid?: number; running: boolean; cloudDisabled: true; concurrentInference: number } {
    return { url: this.url, guardianPid: this.process?.pid, running: this.process?.exitCode === null,
      cloudDisabled: true, concurrentInference: this.pool === 'micro' ? Math.min(10, resourceLimits(this.options.resourceBudget).maxSocialTurns, resourceLimits(this.options.resourceBudget).maxConcurrentTurns) : (resourceLimits(this.options.resourceBudget).productiveRemoteModelId||resourceLimits(this.options.resourceBudget).productiveRemoteProfiles) ? 1 : resourceLimits(this.options.resourceBudget).maxProductiveTurns };
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const pending = this.stopPool(); this.stopping = pending;
    try { await pending; } finally { if (this.stopping === pending) this.stopping = undefined; }
  }

  private async stopPool(): Promise<void> {
    this.generation++; this.startup?.abort(new Error('Owned Ollama stopped during startup'));
    this.inventoryAbort.abort(new Error('Owned model inventory cancelled by stop'));
    this.inventoryAbort = new AbortController();
    const starting = this.starting, inventory = this.inventoryTail;
    const child = this.process; this.process = undefined;
    const results = await Promise.allSettled([stopOwned(child), starting?.catch(() => {}), inventory.catch(() => {})]);
    this.url = '';
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
}

async function accessReceipt(path: string): Promise<void> { await stat(path); }
