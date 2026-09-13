import { describe, expect, it } from 'vitest';
import { ResourceBudget, resourceLimits, macMemorySnapshot, ResourceAdmissionError } from '../src/runtime/resource-budget.js';
import type { LocalModel } from '../src/runtime/types.js';

const GiB = 1024 ** 3;
const micro = { id: 'micro-06', artifactIdentity: 'micro', size: 0.6 * GiB, contextTokens: 16384 } as LocalModel;
const strong = { artifactIdentity: 'strong', size: 18 * GiB, contextTokens: 16384 } as LocalModel;
const memory = () => ({ total: 64 * GiB, free: 40 * GiB });

describe('bounded local resource admission', () => {
  it('admits ten shared micro contexts while preserving a productive slot', () => {
    const budget = new ResourceBudget({ maxConcurrentTurns: 11, maxSocialTurns: 10, maxLoadedModels: 2 }, memory);
    const releases = Array.from({ length: 10 }, (_, i) => budget.admit(`social-${i}`, micro, 'social'));
    expect(() => budget.admit('overflow', micro, 'social')).toThrow('Productive compute reserve');
    const release = budget.admit('work', strong);
    expect(budget.status().activeTurns).toBe(11);
    expect(() => budget.admit('other', micro)).toThrow('slots occupied');
    release(); releases.forEach(done => done());
    expect(budget.status().activeTurns).toBe(0);
  });
  it('uses observed host memory and estimated context costs to refuse oversized trials', () => {
    const pressure = new ResourceBudget({}, () => ({ total: 64 * GiB, free: GiB }));
    expect(() => pressure.admit('low-memory', micro)).toThrow('host memory');
    const smallHost = new ResourceBudget({ maxConcurrentTurns: 11 }, () => ({ total: 8 * GiB, free: 5 * GiB }));
    expect(() => smallHost.admit('too-large', strong)).toThrow('host memory');
    expect(pressure.status().activeTurns).toBe(0);
  });
  it('refuses allocations that fit total RAM but exceed currently available memory', () => {
    const budget = new ResourceBudget({}, () => ({ total: 64 * GiB, free: 3 * GiB }));
    expect(() => budget.admit('large', strong)).toThrow('host memory');
    expect(() => budget.admit('invalid', { ...micro, size: NaN })).toThrow('resource metadata');
  });
  it('reserves pending allocations before provider memory readings catch up', () => {
    const budget = new ResourceBudget({ maxConcurrentTurns: 11, maxSocialTurns: 10 }, () => ({ total: 64 * GiB, free: 8 * GiB }));
    expect(() => budget.admit('preallocated', micro, 'social')).toThrow('host memory');
  });
  it('bounds residency, rejects duplicate identities, and serializes strong work', () => {
    const budget = new ResourceBudget({ maxConcurrentTurns: 3 }, memory);
    const release = budget.admit('first', micro);
    expect(() => budget.admit('first', micro)).toThrow('Duplicate');
    expect(() => budget.admit('second', strong)).toThrow('residency');
    release(); budget.admit('first', strong);
    expect(() => budget.admit('second', strong)).toThrow('productive');
  });
  it('defaults conservatively and validates configuration before startup', () => {
    expect(resourceLimits().maxConcurrentTurns).toBe(1);
    expect(() => resourceLimits({ maxConcurrentTurns: 1.5 })).toThrow('Invalid');
    expect(() => resourceLimits({ maxSocialTurns: 0 })).toThrow('Invalid');
    expect(() => resourceLimits({ minFreeMemoryBytes: NaN })).toThrow('Invalid');
  });
});

it('estimates reclaimable macOS cache separately from active anonymous pages and refuses elevated pressure', () => {
  const vm = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free: 918031.
Pages inactive: 1641563.
Pages speculative: 6137.
Anonymous pages: 789104.
File-backed pages: 2007341.
Pages purgeable: 12556.
Pages occupied by compressor: 199395.`;
  const normal = macMemorySnapshot(vm, 1, 64 * GiB);
  expect(normal.reclaimable).toBe(2007341 * 16384);
  expect(normal.available).toBeGreaterThan(26 * GiB);
  expect(() => new ResourceBudget({}, () => normal).admit('strong', strong)).not.toThrow();
  expect(() => new ResourceBudget({}, () => macMemorySnapshot(vm, 2, 64 * GiB)).admit('pressured', micro)).toThrow('host memory');
  expect(() => macMemorySnapshot('malformed', 1, 64 * GiB)).toThrow('observation');
});
it('credits actually observed resident weights on repeated turns without waiving context or pressure reserves', () => {
  const budget = new ResourceBudget({}, () => ({ total: 64 * GiB, free: 5 * GiB }));
  expect(() => budget.admit('cold', strong)).toThrow('host memory');
  const release = budget.admit('warm', strong, 'productive', strong.size * 1.2); release();
  expect(() => budget.admit('warm-again', strong, 'productive', strong.size * 1.2)).not.toThrow();
});

it('retains shared pending weights until the last admitted identity releases', () => {
  const budget = new ResourceBudget({ maxConcurrentTurns: 4, maxProductiveTurns: 2, maxLoadedModels: 2 }, () => ({ total: 64 * GiB, free: 8 * GiB }));
  const shared = { ...micro, size: 2 * GiB, contextMemoryBytes: Math.round(0.625 * GiB) };
  const first = budget.admit('first', shared);
  const second = budget.admit('second', shared);
  first();
  // 2.4 GiB shared weights + 1.25 GiB context + 2.45 GiB new model/context + 2 GiB reserve exceeds 8 GiB.
  expect(() => budget.admit('other', { ...micro, size: GiB, artifactIdentity: 'other' })).toThrow('pendingAllocation');
  second();
  expect(() => budget.admit('other', { ...micro, size: GiB, artifactIdentity: 'other' })).not.toThrow();
});

it('distinguishes retryable admission refusal from invalid model metadata', () => {
  const budget = new ResourceBudget({}, () => ({ total: 64 * GiB, free: GiB }));
  expect(() => budget.admit('pressure', micro)).toThrow(ResourceAdmissionError);
  try { budget.admit('invalid', { ...micro, size: NaN }); } catch (error) { expect(error).not.toBeInstanceOf(ResourceAdmissionError); }
});

it('admits a model switch when unloaded file-backed cache remains active', () => {
  const vm = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free: 200000.
Pages active: 2200000.
Pages inactive: 100000.
Pages speculative: 0.
File-backed pages: 2500000.
Anonymous pages: 800000.
Pages wired down: 200000.
Pages occupied by compressor: 200000.`;
  const observation = macMemorySnapshot(vm, 1, 64 * GiB);
  expect(observation.available).toBe((200000 + 2500000) * 16384);
  expect(observation.measurement).toContain('estimated');
  expect(() => new ResourceBudget({}, () => observation).admit('switch', strong)).not.toThrow();
  expect(() => new ResourceBudget({}, () => macMemorySnapshot(vm, 4, 64 * GiB)).admit('pressured', strong)).toThrow(ResourceAdmissionError);
});

it('charges the selectable Nemotron profile as the same heavy primary weights', () => {
  const variant = { ...strong, id: 'nemotron-no-thinking-v1', sizeClass: 'large', artifactIdentity: 'variant', inferenceProfile: { id: 'nemotron-no-thinking-v1', reasoningEffort: 'none' } } as LocalModel;
  const candidate = new ResourceBudget({ maxConcurrentTurns: 2, maxLoadedModels: 2 }, memory);
  candidate.admit('variant', variant);
  expect(() => candidate.admit('default', strong)).toThrow('productive');
  const limited = new ResourceBudget({}, () => ({ total: 64 * GiB, free: 3 * GiB }));
  expect(() => limited.admit('variant', variant)).toThrow('host memory');
});

it('charges the additional GiB for explicit Qwen 48K instead of treating it as a micro profile', () => {
  const base = { ...strong, id: 'qwen-main', sizeClass: 'large', contextTokens: 32768 } as LocalModel;
  const wide = { ...base, id: 'qwen-main-48k', contextTokens: 49152, artifactIdentity: 'wide' };
  const available = base.size * 1.2 + 2.25 * GiB + 2 * GiB;
  const host = () => ({ total: 64 * GiB, free: available });
  new ResourceBudget({}, host).admit('base', base)();
  expect(() => new ResourceBudget({}, host).admit('wide', wide)).toThrow(ResourceAdmissionError);
  new ResourceBudget({}, () => ({ ...host(), free: available + GiB })).admit('wide', wide)();
});

it('precharges both primary slots and retains them until the last shared run releases', () => {
  const identity = 'a'.repeat(64), model = { ...strong, id: 'qwen-main-48k', artifactIdentity: identity, contextTokens: 49152 };
  const options = { maxConcurrentTurns: 3, maxProductiveTurns: 2, productiveArtifactIdentity: identity, maxLoadedModels: 2 };
  const required = model.size * 1.2 + 6.5 * GiB + 2 * GiB;
  expect(() => new ResourceBudget(options, () => ({ total: 64 * GiB, free: required - 1 })).admit('first', model, 'productive', 0, 'primary')).toThrow(ResourceAdmissionError);
  const budget = new ResourceBudget(options, () => ({ total: 64 * GiB, free: required }));
  const first = budget.admit('first', model, 'productive', 0, 'primary');
  const second = budget.admit('second', model, 'productive', 0, 'primary');
  expect(() => budget.admit('third', model, 'productive', 0, 'primary')).toThrow('productive');
  first();
  expect(() => budget.admit('social', { ...micro, id: 'micro-06' }, 'social', 0, 'micro')).toThrow('memory');
  expect(() => budget.admit('changed', { ...model, artifactIdentity: 'b'.repeat(64) }, 'productive', 0, 'primary')).toThrow('memory');
  second();
  budget.admit('social', { ...micro, id: 'micro-06' }, 'social', 0, 'micro')();
});

it('admits different productive local profiles up to configured slots and memory', () => {
  const budget = new ResourceBudget({ maxConcurrentTurns: 3, maxProductiveTurns: 3, maxLoadedModels: 3 }, memory);
  for (let index = 0; index < 3; index++) budget.admit(String(index), { ...micro, artifactIdentity: String(index) });
  expect(() => budget.admit('overflow', micro)).toThrow('slots occupied');
});

it('mixed qualification charges one primary context and refuses a second local turn without losing the first reservation',()=>{
 const identity='a'.repeat(64),model={...strong,id:'qwen-main-48k',artifactIdentity:identity,contextTokens:49152};
 const options={maxConcurrentTurns:3,maxProductiveTurns:2,productiveArtifactIdentity:identity,productiveRemoteModelId:'gemini:fixture',productiveRemoteArtifactIdentity:'b'.repeat(64),maxLoadedModels:2};
 const required=model.size*1.2+3.25*GiB+2*GiB;
 const budget=new ResourceBudget(options,()=>({total:64*GiB,free:required}));
 const release=budget.admit('first',model,'productive',0,'primary');
 expect(()=>budget.admit('second',model,'productive',0,'primary')).toThrow('only one local');
 expect(()=>budget.admit('micro',{...micro,id:'micro-17'},'social',0,'micro')).toThrow('memory');
 release();expect(()=>budget.admit('replacement',model,'productive',0,'primary')).not.toThrow();
 for(const patch of [{productiveRemoteModelId:'paid/model'},{productiveRemoteArtifactIdentity:undefined}])expect(()=>resourceLimits({...options,...patch})).toThrow('exact free remote');
});

it('five productive capacities never enable a second local allocation or double its KV',()=>{
 const model={...strong,artifactIdentity:'a'.repeat(64),contextTokens:49152};const options={maxConcurrentTurns:5,maxProductiveTurns:5,productiveArtifactIdentity:model.artifactIdentity,productiveRemoteProfiles:[{modelId:'gemini:fixture',artifactIdentity:'b'.repeat(64),maxConcurrentTurns:4}],productiveProviderCaps:[{provider:'gemini' as const,maxConcurrentTurns:4}]};
 const budget=new ResourceBudget(options,()=>({total:64*GiB,free:model.size*1.2+3.25*GiB+2*GiB}));const release=budget.admit('one',model,'productive',0,'primary');expect(()=>budget.admit('two',model,'productive',0,'primary')).toThrow('only one local');release();expect(()=>resourceLimits({...options,productiveRemoteProfiles:undefined})).toThrow();expect(()=>resourceLimits({...options,productiveRemoteModelId:'gemini:fixture',productiveRemoteArtifactIdentity:'b'.repeat(64)})).toThrow();
});

it('rechecks larger observed context allocation while the profile remains shared',()=>{
 const budget=new ResourceBudget({maxConcurrentTurns:2,maxProductiveTurns:2,maxLoadedModels:2},()=>({total:64*GiB,free:8*GiB}));
 const release=budget.admit('first',{...micro,contextMemoryBytes:GiB});
 expect(()=>budget.admit('second',{...micro,contextMemoryBytes:4*GiB})).toThrow('memory');
 expect(budget.status().activeTurns).toBe(1);
 expect(()=>budget.admit('other',{...micro,artifactIdentity:'other',contextMemoryBytes:GiB})).toThrow('memory');
 release();
 expect(()=>budget.admit('other',{...micro,artifactIdentity:'other',contextMemoryBytes:GiB})).not.toThrow();
});
