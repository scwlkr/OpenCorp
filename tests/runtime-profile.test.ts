import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnedOllama, localArtifactIdentity, selectLocalModel, localModelSelectionId } from '../src/runtime/ollama.js';
import { MODEL_ALIASES } from '../src/runtime/types.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
afterEach(() => vi.restoreAllMocks());

describe('owned local profile identity', () => {
  it('selects Qwen no-thinking from the owned inventory and rejects changed or omitted profile identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opencorp-profile-fixture-'));
    const ollama = new OwnedOllama({ dataRoot: root });
    vi.spyOn(ollama, 'start').mockResolvedValue(); // Inventory fixture never launches a model/service.
    const manifest = JSON.stringify({ layers: [], config: { digest: `sha256:${hash('blob')}`, size: 4 } });
    const tags = Object.entries(MODEL_ALIASES).flatMap(([id, name]) => [
      { name, digest: hash(`source-${id}`), size: 4 },
      { name: `opencorp-${id}-16384:latest`, digest: hash(manifest), size: 4 },
      ...(id === 'qwen-main' ? [{ name: 'opencorp-qwen-main-49152:latest', digest: hash(manifest), size: 4 }] : []),
    ]);
    let template = "resolved_reasoning_effort == 'low': Reasoning effort is set to low.";
    let capabilities = ['completion', 'thinking', 'tools'];
    const calls: string[] = [];
    const upstream = createServer((req, res) => {
      calls.push(req.url!); res.setHeader('content-type', 'application/json');
      if (req.url === '/api/tags') res.end(JSON.stringify({ models: tags }));
      else if (req.url === '/api/show') res.end(JSON.stringify({ template, parameters: 'num_predict 4096\nnum_ctx 16384\ntemperature 0.2', capabilities }));
      else { res.statusCode = 400; res.end('{}'); }
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address(); if (!address || typeof address === 'string') throw new Error('No fixture port');
    ollama.url = `http://127.0.0.1:${address.port}`;
    try {
      await mkdir(join(ollama.modelStore, 'blobs'), { recursive: true });
      await writeFile(join(ollama.modelStore, 'blobs', `sha256-${hash('blob')}`), 'blob');
      for (const id of Object.keys(MODEL_ALIASES)) for (const context of (id === 'qwen-main' ? [16384, 49152] : [16384])) {
        const directory = join(ollama.modelStore, 'manifests/registry.ollama.ai/library', `opencorp-${id}-${context}`);
        await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'latest'), manifest);
        await writeFile(join(ollama.root, `${id}-${context}.source`), hash(`source-${id}`));
      }
      const models = await ollama.models();
      const qwen = models.find(model => model.id === 'qwen-main')!;
      expect(qwen.inferenceProfile).toEqual({ id: 'qwen-no-thinking-v1', reasoningEffort: 'none' });
      expect(qwen.artifactIdentity).not.toBe(localArtifactIdentity({ ...qwen, inferenceProfile: undefined }));
      const wide = models.find(model => model.id === 'qwen-main-48k')!;
      expect(wide.contextTokens).toBe(49152);
      expect(wide.inferenceProfile).toEqual(qwen.inferenceProfile);
      expect(wide.sizeClass).toBe('large');
      expect(wide.artifactIdentity).not.toBe(qwen.artifactIdentity);
      expect(localModelSelectionId(wide)).toBe(wide.id);
      expect(selectLocalModel([...models].reverse(), wide.name)).toBe(wide);
      expect(selectLocalModel([...models].reverse(), wide.id)).toBe(wide);
      expect(selectLocalModel([...models].reverse(), qwen.sourceAlias)).toBe(qwen);
      await expect(ollama.verifyIdentity(wide)).resolves.toBeUndefined();
      const low = models.find(model => model.id === 'qwen-low-reasoning-48k')!;
      expect(low.inferenceProfile).toEqual({ id: 'qwen-low-reasoning-v1', reasoningEffort: 'low' });
      for (const key of ['alias', 'manifestDigest', 'templateDigest', 'parametersDigest', 'contextTokens', 'size', 'sizeClass'] as const) expect(low[key]).toEqual(wide[key]);
      expect(low.artifactIdentity).not.toBe(wide.artifactIdentity);
      expect(localModelSelectionId(low)).toBe(low.id);
      for (const key of [low.id, low.name]) expect(selectLocalModel([...models].reverse(), key)).toBe(low);
      await expect(ollama.verifyIdentity(low)).resolves.toBeUndefined();
      expect((await ollama.models(49152)).filter(model => model.id === low.id)).toHaveLength(1);
      const wrongLow = { ...low, inferenceProfile: qwen.inferenceProfile };
      await expect(ollama.verifyIdentity({ ...wrongLow, artifactIdentity: localArtifactIdentity(wrongLow) })).rejects.toThrow('profile identity changed');
      expect(qwen.manifestDigest).toBe(hash(manifest));
      await expect(ollama.verifyIdentity(qwen)).resolves.toBeUndefined();
      await expect(ollama.verifyIdentity({ ...qwen, inferenceProfile: undefined })).rejects.toThrow('profile identity changed');
      await expect(ollama.verifyIdentity({ ...qwen, artifactIdentity: localArtifactIdentity({ ...qwen, inferenceProfile: undefined }) })).rejects.toThrow('profile identity changed');
      const mutated = { ...qwen, inferenceProfile: { id: 'qwen-no-thinking-v1' as const, reasoningEffort: 'high' as 'none' } };
      mutated.artifactIdentity = localArtifactIdentity(mutated);
      await expect(ollama.verifyIdentity(mutated)).rejects.toThrow('profile identity changed');
      for (const model of models.filter(model => !['qwen-main', 'qwen-main-48k', 'qwen-low-reasoning-48k'].includes(model.id) && model.id !== 'nemotron-no-thinking-v1' && !model.id.startsWith('micro-'))) {
        expect(model).not.toHaveProperty('inferenceProfile');
        const { alias, manifestDigest, templateDigest, parametersDigest, contextTokens } = model;
        expect(model.artifactIdentity).toBe(hash(JSON.stringify({ alias, manifestDigest, templateDigest, parametersDigest, contextTokens, cloudDisabled: true })));
        await expect(ollama.verifyIdentity(model)).resolves.toBeUndefined();
      }
      const experimental = new OwnedOllama({ dataRoot: root, nemotronInferenceProfile: 'nemotron-no-thinking-v1' });
      vi.spyOn(experimental, 'start').mockResolvedValue(); experimental.url = ollama.url;
      const nemotron = models.find(model => model.id === 'nemotron')!;
      const candidate = (await experimental.models()).find(model => model.id === 'nemotron')!;
      const variant = models.find(model => model.id === 'nemotron-no-thinking-v1')!;
      expect(variant.artifactIdentity).toBe(candidate.artifactIdentity);
      expect(variant.sizeClass).toBe('large');
      expect(variant.size).toBe(nemotron.size);
      expect(localModelSelectionId(variant)).toBe('nemotron-no-thinking-v1');
      expect(localModelSelectionId(nemotron)).toBe(nemotron.sourceAlias);
      expect(selectLocalModel([...models].reverse(), variant.id)).toBe(variant);
      expect(selectLocalModel([...models].reverse(), variant.name)).toBe(variant);
      for (const key of [nemotron.id, nemotron.alias, nemotron.sourceAlias]) expect(selectLocalModel([...models].reverse(), key)).toBe(nemotron);
      await expect(ollama.verifyIdentity(variant)).resolves.toBeUndefined();
      expect(candidate.inferenceProfile).toEqual({ id: 'nemotron-no-thinking-v1', reasoningEffort: 'none' });
      expect(candidate.artifactIdentity).not.toBe(nemotron.artifactIdentity);
      expect(candidate.manifestDigest).toBe(nemotron.manifestDigest);
      expect(candidate.templateDigest).toBe(nemotron.templateDigest);
      expect(candidate.parametersDigest).toBe(nemotron.parametersDigest);
      expect(candidate.alias).toBe(nemotron.alias);
      await expect(experimental.verifyIdentity(candidate)).resolves.toBeUndefined();
      await expect(ollama.verifyIdentity(candidate)).rejects.toThrow('profile identity changed');
      await expect(experimental.verifyIdentity(nemotron)).rejects.toThrow('profile identity changed');
      for (const micro of models.filter(model => model.id.startsWith('micro-'))) {
        expect(micro.inferenceProfile).toEqual({ id: 'qwen-no-thinking-v1', reasoningEffort: 'none' });
        await expect(ollama.verifyIdentity(micro)).resolves.toBeUndefined();
      }
      capabilities = ['completion', 'tools'];
      expect((await ollama.models()).some(model => model.id === 'qwen-low-reasoning-48k')).toBe(false);
      capabilities = ['completion', 'thinking', 'tools'];
      template = 'boolean-only template';
      expect((await ollama.models()).some(model => model.id === 'qwen-low-reasoning-48k')).toBe(false);
      expect(calls.every(path => ['/api/tags', '/api/show'].includes(path))).toBe(true);
    } finally {
      upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
