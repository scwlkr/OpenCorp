import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnedOllama, localInferenceProfile } from '../src/runtime/ollama.js';
import { LocalRuntime, runtimeConfig } from '../src/runtime/index.js';
import type { LocalModel } from '../src/runtime/types.js';
import * as processes from '../src/runtime/processes.js';

afterEach(() => vi.restoreAllMocks());
describe('separate owned model pools', () => {
  it('attempts to stop both owned services even when one reports uncertain absence', async () => {
    const stopped: string[] = [];
    vi.spyOn(OwnedOllama.prototype, 'stop').mockImplementation(async function (this: OwnedOllama) {
      stopped.push(this.root);
      if (this.root.endsWith('/ollama')) throw new Error('Fixture primary ownership uncertain');
    });
    const runtime = new LocalRuntime({ dataRoot: '/unused-fixture' });
    await expect(runtime.stop()).rejects.toThrow('ownership uncertain');
    expect(stopped).toEqual(['/unused-fixture/runtime/ollama', '/unused-fixture/runtime/ollama-micro']);
    expect(runtime.status().started).toBe(false);
  });
  it('reconfigures only after both old pools stop, preserving old limits on failure', async () => {
    const stop = vi.spyOn(OwnedOllama.prototype, 'stop').mockResolvedValue();
    const runtime = new LocalRuntime({ dataRoot: '/unused-fixture' });
    await runtime.configureResources({ maxConcurrentTurns: 6, maxSocialTurns: 5, maxLoadedModels: 2 });
    expect(stop).toHaveBeenCalledTimes(2);
    expect(runtime.status().inferenceSlots).toBe(6);
    expect(runtime.status().microOllama.concurrentInference).toBe(5);
    stop.mockRejectedValue(new Error('uncertain owned process'));
    await expect(runtime.configureResources({ maxConcurrentTurns: 11 })).rejects.toThrow('uncertain');
    expect(runtime.status().inferenceSlots).toBe(6);
  });
  it.each([{productiveTurns:1,mixed:false},{productiveTurns:2,mixed:false},{productiveTurns:2,mixed:true},{productiveTurns:5,mixed:true}])('configures $productiveTurns productive turns with mixed=$mixed while retaining separate micro contexts', async ({productiveTurns,mixed}) => {
    const root = await mkdtemp(join(tmpdir(), 'opencorp-pools-'));
    const modelStore = join(root, 'source'); await mkdir(modelStore);
    const calls: Parameters<typeof processes.spawnOwned>[0][] = [];
    vi.spyOn(processes, 'spawnOwned').mockImplementation(async options => { calls.push(options); throw new Error('Fixture stops before launching processes'); });
    try {
      const options = { dataRoot: root, modelStore, resourceBudget: { maxConcurrentTurns: 11, maxProductiveTurns: productiveTurns, productiveArtifactIdentity: 'a'.repeat(64),...(productiveTurns===5?{productiveRemoteProfiles:[{modelId:'gemini:fixture',artifactIdentity:'b'.repeat(64),maxConcurrentTurns:4}],productiveProviderCaps:[{provider:'gemini' as const,maxConcurrentTurns:4}]}:mixed?{productiveRemoteModelId:'gemini:fixture',productiveRemoteArtifactIdentity:'b'.repeat(64)}:{}), maxSocialTurns: 10, maxLoadedModels: 2 } };
      const primary = new OwnedOllama(options), micro = new OwnedOllama(options, 'micro');
      await expect(primary.start()).rejects.toThrow('Fixture stops');
      await expect(micro.start()).rejects.toThrow('Fixture stops');
      expect(calls[0].env).toMatchObject({ OLLAMA_NUM_PARALLEL: String(mixed?1:productiveTurns), OLLAMA_MAX_LOADED_MODELS: '1', OLLAMA_NO_CLOUD: '1' });
      expect(calls[1].env).toMatchObject({ OLLAMA_NUM_PARALLEL: '10', OLLAMA_MAX_LOADED_MODELS: '1', OLLAMA_NO_CLOUD: '1' });
      expect(calls[0].receiptPath).not.toBe(calls[1].receiptPath);
      expect(primary.modelStore).not.toBe(micro.modelStore);
      expect(primary.status().concurrentInference).toBe(mixed?1:productiveTurns);
      expect(micro.status().concurrentInference).toBe(10);
      expect(primary.sourceModelStore).toBe(micro.sourceModelStore);
      expect(localInferenceProfile('micro-06')).toEqual({ id: 'qwen-no-thinking-v1', reasoningEffort: 'none' });
      expect(localInferenceProfile('micro-17')).toEqual(localInferenceProfile('micro-06'));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('provides social runs no native or corporate tool permissions', () => {
    const model = { alias: 'micro', capabilities: ['completion'], contextTokens: 16384 } as LocalModel;
    const config = runtimeConfig(model, 'http://127.0.0.1:1', 'fixture-secret', false, { system: 'A short social identity.', workspace: '/tmp/fixture', workload: 'social' });
    expect(config.permission).toEqual({ '*': 'deny' });
    expect(config.tools).toMatchObject({ bash: false, read: false, edit: false, write: false, skill: false });
    expect(config.mcp).toEqual({});
    expect(config.provider?.['opencorp-local'].models?.micro.tool_call).toBe(false);
    expect(config.agent?.employee?.prompt).not.toContain('Use tools to inspect');
    expect(config.agent?.employee?.prompt).not.toContain('After native compaction, call company_help');
    expect(config.agent?.employee?.prompt).not.toContain('authoritative native workspace');
  });
});

it('corporate-only formation disables native schemas and permissions while retaining corporate tools',()=>{
 const model={alias:'fixture',capabilities:['tools'],contextTokens:32768} as LocalModel;
 const config=runtimeConfig(model,'http://127.0.0.1:1','fixture',true,{system:'Retained formation task',workspace:'/tmp/fixture',workload:'productive',corporateOnly:true});
 for(const name of ['read','write','edit','bash','glob','grep','todoread','todowrite','skill'])expect((config.tools as Record<string,boolean>)[name]).toBe(false);
 expect(config.permission).toEqual({'*':'deny','corporate_*':'allow'});expect(config.mcp).toHaveProperty('corporate');expect(config.provider?.['opencorp-local'].models?.fixture.tool_call).toBe(true);
 expect(config.agent?.employee?.prompt).toContain('corporate tools only');expect(config.agent?.employee?.prompt).toContain('After native compaction, call company_help');expect(config.agent?.employee?.prompt).toContain('exact-hash source inspection recorded complete in this same run remains complete');expect(config.agent?.employee?.prompt).toContain('specific missing or changed source content');expect(config.agent?.employee?.prompt).not.toContain('authoritative native workspace');expect(config.agent?.employee?.prompt).not.toContain('Search with grep or glob');
});

it('ordinary product and native qualification configuration keeps native tools by default',()=>{
 const model={alias:'fixture',capabilities:['tools'],contextTokens:32768} as LocalModel;
 for(const employee of [undefined,{system:'Implement actual product work',workspace:'/tmp/product',workload:'productive' as const}]){
  const config=runtimeConfig(model,'http://127.0.0.1:1','fixture',!!employee,employee);
  expect(config.tools?.read).not.toBe(false);expect(config.tools?.bash).not.toBe(false);expect(config.permission).toMatchObject({read:'allow',write:'allow',edit:'allow',bash:'allow',glob:'allow',grep:'allow'});
  expect(config.agent?.employee?.prompt).not.toContain('After native compaction, call company_help');
  if(employee)expect(config.agent?.employee?.prompt).toContain('authoritative native workspace');
 }
});

it('preserves the 8K compaction margin for explicit 48K Qwen and refuses broad or social 48K requests before startup', async () => {
  const model = { alias: 'qwen48', capabilities: ['completion'], contextTokens: 49152 } as LocalModel;
  const config = runtimeConfig(model, 'http://127.0.0.1:1', 'fixture-secret', false);
  expect(config.compaction?.reserved).toBe(8192);
  expect(config.provider?.['opencorp-local'].models?.qwen48.limit).toEqual({ context: 49152, input: 49152, output: 4096 });
  const start = vi.spyOn(OwnedOllama.prototype, 'start').mockResolvedValue();
  const runtime = new LocalRuntime({ dataRoot: '/unused-fixture' });
  const request = { runId: 'fixture', employeeId: 'employee', workspace: '/tmp/fixture', prompt: 'fixture', system: 'fixture', modelId: 'qwen-main', contextTokens: 49152 as const };
  await expect(runtime.execute(request)).rejects.toThrow('explicit productive');
  await expect(runtime.execute({ ...request, modelId: 'qwen-main-48k', workload: 'social' })).rejects.toThrow('explicit productive');
  expect(start).not.toHaveBeenCalled();
});
