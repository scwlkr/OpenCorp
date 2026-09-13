import { afterEach, expect, it, vi } from 'vitest';
import { OwnedOllama } from '../src/runtime/ollama.js';
import type { LocalModel } from '../src/runtime/types.js';
afterEach(() => vi.unstubAllGlobals());
const model = { alias: 'opencorp-qwen-main-16384:latest', manifestDigest: 'exact', size: 1000 } as LocalModel;
it('credits only exact observed owned profile residency', async () => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ models: [{ name: model.alias, digest: model.manifestDigest, size_vram: 1600 }] }))));
  const ollama = new OwnedOllama({ dataRoot: '/unused-residency-fixture' });
  expect(await ollama.prepareResidency(model, false, new AbortController().signal)).toBe(1200);
});
it('unloads an idle incompatible profile and verifies its absence before admitting new weights', async () => {
  const old = { name: 'opencorp-nemotron-16384:latest', digest: 'old', size_vram: 1600 };
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ models: [old] })))
    .mockResolvedValueOnce(new Response('{}')).mockResolvedValueOnce(new Response(JSON.stringify({ models: [] })));
  vi.stubGlobal('fetch', fetch);
  const ollama = new OwnedOllama({ dataRoot: '/unused-residency-fixture' });
  expect(await ollama.prepareResidency(model, true, new AbortController().signal)).toBe(0);
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ model: old.name, keep_alive: 0, stream: false });
});
it('refuses to evict active pool weights or accept uncertain unload', async () => {
  const response = () => new Response(JSON.stringify({ models: [{ name: 'other', digest: 'other', size_vram: 1000 }] }));
  const fetch = vi.fn().mockImplementation(async () => response()); vi.stubGlobal('fetch', fetch);
  const ollama = new OwnedOllama({ dataRoot: '/unused-residency-fixture' });
  await expect(ollama.prepareResidency(model, false, new AbortController().signal)).rejects.toThrow('active profile');
  expect(fetch).toHaveBeenCalledTimes(1);
  await expect(ollama.prepareResidency(model, true, new AbortController().signal)).rejects.toThrow('still resident');
});
