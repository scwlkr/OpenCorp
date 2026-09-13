import { describe, expect, it } from 'vitest';
import { microWorkplaceStrongProfile, assertMicroStrongProfileEvidence, microWorkplaceEvidence, runMicroWorkplaceTrial, microReadEvidence, microWorkplaceStage } from '../scripts/micro-workplace-evidence.js';
import type { RuntimeEvent } from '../src/runtime/types.js';
const observed = (runId: string, firstContentAt: number, lastContentAt: number, contentSamples: number[]): RuntimeEvent => ({ type: 'runtime.inference.observed', runId,
  payload: { request: 1, dispatchedAt: 0, settledAt: 100, firstContentAt, lastContentAt, contentSamples } });
describe('honest micro-workplace overlap evidence', () => {
  it('does not present simultaneous queued requests as overlapping generation', () => {
    const result = microWorkplaceEvidence([observed('a', 10, 20, [10, 20]), observed('b', 20, 30, [20, 30])]);
    expect(result.peakDispatchedRequests).toBe(2); expect(result.peakOverlappingContentStreams).toBe(1); expect(result.interleavedPairs).toEqual([]);
  });
  it('retains observed interleaving without claiming direct kernel or coherence proof', () => {
    const result = microWorkplaceEvidence([observed('a', 10, 40, [10, 30, 40]), observed('b', 20, 50, [20, 35, 50])]);
    expect(result.peakOverlappingContentStreams).toBe(2); expect(result.interleavedPairs).toEqual([{ firstRunId: 'a', secondRunId: 'b' }]);
    expect(result.serverKernelOverlap).toBe('not directly observed'); expect(result.coherenceReview).toContain('required');
  });
  it('does not count empty or nonstreaming metadata as generated-content intervals', () => {
    expect(microWorkplaceEvidence([observed('empty', 10, 10, [])]).peakOverlappingContentStreams).toBe(0);
    expect(microWorkplaceEvidence([]).peakDispatchedRequests).toBe(0);
  });
});

it('runs distinct supplied employee turns together and preserves actual refusal results', async () => {
  let active = 0, maximum = 0;
  const runtime = { status: () => ({ activeRuns: [] }), execute: async (request: { runId: string }) => {
    active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 1)); active--;
    throw new Error(`Resource refusal ${request.runId}`);
  } } as unknown as import('../src/runtime/index.js').LocalRuntime;
  const turns = Array.from({ length: 5 }, (_, index) => ({ runId: `run-${index}`, employeeId: `employee-${index}`, workload: 'social' as const,
    modelId: 'micro-06', workspace: '/unused-fixture', system: 'Fixture', prompt: 'Fixture' }));
  const result = await runMicroWorkplaceTrial(runtime, turns);
  expect(maximum).toBe(5); expect(result.results.every(entry => entry.status === 'rejected')).toBe(true);
  expect(result.evidence.peakOverlappingContentStreams).toBe(0);
  await expect(runMicroWorkplaceTrial(runtime, [...turns.slice(0, 4), turns[0]])).rejects.toThrow('distinct');
});

it('requires bound completed native reads and accurate output for micro tool qualification', () => {
 const expected = { requestId: 'unpredictable-fixture-value', department: 'Research', pendingItems: 7 }, file = '/fixture/queue.json', text = JSON.stringify(expected);
 const part = { type: 'tool', tool: 'read', sessionID: 'bound', state: { status: 'completed', input: { filePath: file }, output: text } };
 const message = { info: { role: 'assistant', sessionID: 'bound' }, parts: [part] };
 expect(microReadEvidence([message], 'bound', file, expected, text).passed).toBe(true);
 for (const bad of [[], [{ ...message, info: { role: 'assistant', sessionID: 'other' } }], [{ ...message, parts: [{ ...part, state: { ...part.state, status: 'error' } }] }], [{ ...message, parts: [{ ...part, state: { ...part.state, input: { filePath: '/other/queue.json' } } }] }]]) {
  expect(() => microReadEvidence(bad, 'bound', file, expected, text)).toThrow(/No completed native read/);
 }
 expect(() => microReadEvidence([message], 'bound', file, expected, JSON.stringify({ ...expected, pendingItems: 8 }))).toThrow(/actual fixture values/);
});

it('selects only the requested finite trials and actual employee minimum', () => {
 expect(microWorkplaceStage('initial')).toEqual({ minimumEmployees: 6, needsStrongModel: true, microTool: true, trials: ['five-birthday', 'mixed-productive-and-five'] });
 expect(microWorkplaceStage('mixed-ten')).toEqual({ minimumEmployees: 11, needsStrongModel: true, microTool: false, trials: ['mixed-productive-and-ten'] });
 expect(microWorkplaceStage('ten')).toEqual({ minimumEmployees: 10, needsStrongModel: false, microTool: false, trials: ['ten-office-party'] });
 expect(microWorkplaceStage('all')).toEqual({ minimumEmployees: 10, needsStrongModel: true, microTool: true, trials: ['five-birthday', 'ten-office-party', 'mixed-productive-and-five'] });
 expect(() => microWorkplaceStage('5')).toThrow(/initial, ten, or all/);
});

it('public overlap ignores reasoning samples and never falls back to legacy mixed samples', () => {
 const strong = observed('strong', 10, 50, [10, 30, 50]);
 const social = observed('social', 20, 60, [20, 40, 60]);
 expect(microWorkplaceEvidence([strong, social]).interleavedPairs).toHaveLength(1);
 expect(microWorkplaceEvidence([strong, social], true).interleavedPairs).toHaveLength(0);
 const publicEvent = (event: RuntimeEvent, samples: number[]) => ({ ...event, payload: { ...(event.payload as object), firstPublicContentAt: samples[0], lastPublicContentAt: samples.at(-1), publicContentSamples: samples } });
 expect(microWorkplaceEvidence([publicEvent(strong, [10]), publicEvent(social, [20, 40, 60])], true).interleavedPairs).toHaveLength(0);
 expect(microWorkplaceEvidence([publicEvent(strong, [10, 30, 50]), publicEvent(social, [20, 40, 60])], true).interleavedPairs).toHaveLength(1);
});

it('keeps Qwen48K source staging separate and verifies actual bound/result identity and context', () => {
 expect(microWorkplaceStrongProfile('qwen-main')).toEqual({id:'qwen-main',sourceId:'qwen-main',contextTokens:32768});
 expect(microWorkplaceStrongProfile('nemotron').contextTokens).toBe(32768);
 expect(microWorkplaceStrongProfile('qwen-main-48k')).toEqual({id:'qwen-main-48k',sourceId:'qwen-main',contextTokens:49152});
 expect(()=>microWorkplaceStrongProfile('micro-17')).toThrow('Select');
 const selected={id:'qwen-main-48k',contextTokens:49152,artifactIdentity:'exact48',inferenceProfile:{id:'qwen-no-thinking-v1',reasoningEffort:'none'}} as import('../src/runtime/types.js').LocalModel;
 const result={artifactIdentity:selected.artifactIdentity,inferenceProfile:selected.inferenceProfile} as import('../src/runtime/types.js').RuntimeResult;
 expect(()=>assertMicroStrongProfileEvidence(selected,result,{model:selected})).not.toThrow();
 expect(()=>assertMicroStrongProfileEvidence(selected,{...result,artifactIdentity:'other'},{model:selected})).toThrow();
 expect(()=>assertMicroStrongProfileEvidence(selected,result,{model:{...selected,contextTokens:32768}})).toThrow();
 expect(()=>assertMicroStrongProfileEvidence(selected,{...result,inferenceProfile:undefined},{model:selected})).toThrow();
});
