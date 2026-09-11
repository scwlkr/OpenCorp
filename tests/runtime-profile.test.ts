import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnedOllama, localArtifactIdentity } from '../src/runtime/ollama.js';
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
    ]);
    const calls: string[] = [];
    const upstream = createServer((req, res) => {
      calls.push(req.url!); res.setHeader('content-type', 'application/json');
      if (req.url === '/api/tags') res.end(JSON.stringify({ models: tags }));
      else if (req.url === '/api/show') res.end(JSON.stringify({ template: 'fixture-template', parameters: 'num_predict 4096\nnum_ctx 16384\ntemperature 0.2', capabilities: ['completion', 'thinking', 'tools'] }));
      else { res.statusCode = 400; res.end('{}'); }
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address(); if (!address || typeof address === 'string') throw new Error('No fixture port');
    ollama.url = `http://127.0.0.1:${address.port}`;
    try {
      await mkdir(join(ollama.modelStore, 'blobs'), { recursive: true });
      await writeFile(join(ollama.modelStore, 'blobs', `sha256-${hash('blob')}`), 'blob');
      for (const id of Object.keys(MODEL_ALIASES)) {
        const directory = join(ollama.modelStore, 'manifests/registry.ollama.ai/library', `opencorp-${id}-16384`);
        await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'latest'), manifest);
        await writeFile(join(ollama.root, `${id}-16384.source`), hash(`source-${id}`));
      }
      const models = await ollama.models();
      const qwen = models.find(model => model.id === 'qwen-main')!;
      expect(qwen.inferenceProfile).toEqual({ id: 'qwen-no-thinking-v1', reasoningEffort: 'none' });
      expect(qwen.artifactIdentity).not.toBe(localArtifactIdentity({ ...qwen, inferenceProfile: undefined }));
      expect(qwen.manifestDigest).toBe(hash(manifest));
      await expect(ollama.verifyIdentity(qwen)).resolves.toBeUndefined();
      await expect(ollama.verifyIdentity({ ...qwen, inferenceProfile: undefined })).rejects.toThrow('profile identity changed');
      await expect(ollama.verifyIdentity({ ...qwen, artifactIdentity: localArtifactIdentity({ ...qwen, inferenceProfile: undefined }) })).rejects.toThrow('profile identity changed');
      const mutated = { ...qwen, inferenceProfile: { ...qwen.inferenceProfile!, reasoningEffort: 'high' as 'none' } };
      mutated.artifactIdentity = localArtifactIdentity(mutated);
      await expect(ollama.verifyIdentity(mutated)).rejects.toThrow('profile identity changed');
      for (const model of models.filter(model => model.id !== 'qwen-main')) {
        expect(model).not.toHaveProperty('inferenceProfile');
        const { alias, manifestDigest, templateDigest, parametersDigest, contextTokens } = model;
        expect(model.artifactIdentity).toBe(hash(JSON.stringify({ alias, manifestDigest, templateDigest, parametersDigest, contextTokens, cloudDisabled: true })));
        await expect(ollama.verifyIdentity(model)).resolves.toBeUndefined();
      }
      expect(calls.every(path => ['/api/tags', '/api/show'].includes(path))).toBe(true);
    } finally {
      upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
