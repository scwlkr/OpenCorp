import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import type { RuntimeEvent } from '../src/runtime/types.js';

type Interval = { runId: string; start: number; end: number };
function peak(intervals: Interval[]): number {
  const edges = intervals.filter(item => item.end > item.start).flatMap(item => [{ at: item.start, change: 1 }, { at: item.end, change: -1 }]);
  edges.sort((a, b) => a.at - b.at || a.change - b.change);
  let active = 0, maximum = 0;
  for (const edge of edges) { active += edge.change; maximum = Math.max(maximum, active); }
  return maximum;
}

/** Provider streams are observable; GPU kernels and provider queue admission are not. */
export function microWorkplaceEvidence(events: RuntimeEvent[], publicOnly = false) {
  if (publicOnly) events = events.map(event => {
    if (event.type !== 'runtime.inference.observed') return event;
    const payload = event.payload as Record<string, unknown>;
    return { ...event, payload: { ...payload, firstContentAt: payload.firstPublicContentAt, lastContentAt: payload.lastPublicContentAt, contentSamples: payload.publicContentSamples ?? [] } };
  });
  const observations = events.filter(event => event.type === 'runtime.inference.observed' && event.runId).map(event => ({ runId: event.runId!,
    ...event.payload as { request: number; dispatchedAt?: number; settledAt?: number; firstContentAt?: number; lastContentAt?: number; contentSamples?: number[]; generatedContentChunks?: number } }));
  const dispatch = observations.filter(item => Number.isFinite(item.dispatchedAt) && Number.isFinite(item.settledAt)).map(item => ({ runId: item.runId, start: item.dispatchedAt!, end: item.settledAt! }));
  const content = observations.filter(item => Number.isFinite(item.firstContentAt) && Number.isFinite(item.lastContentAt)).map(item => ({ runId: item.runId, start: item.firstContentAt!, end: item.lastContentAt! }));
  const interleavedPairs: Array<{ firstRunId: string; secondRunId: string }> = [];
  for (let i = 0; i < observations.length; i++) for (let j = i + 1; j < observations.length; j++) {
    const a = observations[i], b = observations[j]; if (a.runId === b.runId) continue;
    const aSamples = a.contentSamples ?? [], bSamples = b.contentSamples ?? [];
    const nested = (outer: number[], inner: number[]) => outer.length > 1 && inner.some(at => at > Math.min(...outer) && at < Math.max(...outer));
    if (nested(aSamples, bSamples) && nested(bSamples, aSamples)) interleavedPairs.push({ firstRunId: a.runId, secondRunId: b.runId });
  }
  return { peakDispatchedRequests: peak(dispatch), peakOverlappingContentStreams: peak(content), interleavedPairs,
    observations, serverKernelOverlap: 'not directly observed', coherenceReview: 'required from retained actual employee messages',
    limitation: 'Dispatch overlap may be queued requests. Content intervals and interleaved generated chunks are observed transport evidence, not direct GPU kernel measurements.' };
}

/** Runs already-created persistent employee turns; caller retains their ordinary company lifecycle. */
export async function runMicroWorkplaceTrial(
  runtime: import('../src/runtime/index.js').LocalRuntime,
  socialTurns: import('../src/runtime/types.js').ExecuteRequest[],
  productiveTurn?: import('../src/runtime/types.js').ExecuteRequest,
) {
  if (![5, 10].includes(socialTurns.length)) throw new Error('A workplace trial requires five or ten social employee turns');
  const requests = [...socialTurns, ...(productiveTurn ? [productiveTurn] : [])];
  if (new Set(requests.map(turn => turn.employeeId)).size !== requests.length || new Set(requests.map(turn => turn.runId)).size !== requests.length) throw new Error('Trial requires distinct persistent employees and run IDs');
  if (socialTurns.some(turn => turn.workload !== 'social') || productiveTurn?.workload === 'social') throw new Error('Trial workload classifications must be explicit');
  const events: RuntimeEvent[] = [], samples: Array<{ at: string; status: ReturnType<typeof runtime.status> }> = [];
  const sample = () => samples.push({ at: new Date().toISOString(), status: runtime.status() });
  const began = new Date().toISOString(); sample();
  const timer = setInterval(sample, 1000);
  try {
    const results = await Promise.allSettled(requests.map(turn => runtime.execute({ ...turn, timeoutMs: Math.min(turn.timeoutMs ?? 180000, 180000),
      onEvent: event => { events.push(event); turn.onEvent?.(event); } })));
    sample();
    return { began, ended: new Date().toISOString(), requestedSocialTurns: socialTurns.length, productiveCoexistenceRequested: Boolean(productiveTurn),
      employeeIds: requests.map(turn => turn.employeeId), results: results.map((result, index) => ({ runId: requests[index].runId,
        employeeId: requests[index].employeeId, workload: requests[index].workload ?? 'productive',
        ...(result.status === 'fulfilled' ? { status: 'fulfilled', result: result.value } : { status: 'rejected', error: String(result.reason) }) })),
      samples, events, evidence: microWorkplaceEvidence(events) };
  } finally { clearInterval(timer); }
}

/** A correct answer alone cannot establish actual native tool support. */
export function microReadEvidence(messages: any[], sessionId: string, file: string, expected: { requestId: string; department: string; pendingItems: number }, text: string) {
  const reads = messages.filter(message => message.info?.role === 'assistant' && message.info?.sessionID === sessionId).flatMap(message => message.parts ?? [])
    .filter(part => part.type === 'tool' && part.tool === 'read' && part.sessionID === sessionId && part.state?.status === 'completed'
      && typeof part.state.input?.filePath === 'string' && resolve(dirname(file), part.state.input.filePath) === file
      && typeof part.state.output === 'string' && part.state.output.includes(expected.requestId));
  assert.ok(reads.length, 'No completed native read of the exact fixture file in the bound employee session');
  assert.deepEqual(JSON.parse(text.trim()), expected, 'Micro employee must report the actual fixture values exactly');
  return { passed: true, completedNativeReads: reads.length, sessionId, file, expected, narrowRole: 'read and accurately report a short departmental queue record', generalToolCompetence: false };
}

export function microWorkplaceStage(stage: string) {
  if (stage === 'mixed-ten') return { minimumEmployees: 11, needsStrongModel: true, microTool: false, trials: ['mixed-productive-and-ten'] };
  if (!['initial', 'ten', 'all'].includes(stage)) throw new Error('Use stage initial, ten, or all; mixed-ten requires eleven employees');
  return { minimumEmployees: stage === 'initial' ? 6 : 10, needsStrongModel: stage !== 'ten', microTool: stage !== 'ten',
    trials: stage === 'initial' ? ['five-birthday', 'mixed-productive-and-five'] : stage === 'ten' ? ['ten-office-party'] : ['five-birthday', 'ten-office-party', 'mixed-productive-and-five'] };
}

/** Explicit strong profile selection keeps shared source weights distinct from execution identity. */
export function microWorkplaceStrongProfile(id: string) {
  if (!['qwen-main', 'nemotron', 'qwen-main-48k'].includes(id)) throw new Error('Select qwen-main, nemotron, or qwen-main-48k');
  return { id, sourceId: id === 'qwen-main-48k' ? 'qwen-main' as const : id as 'qwen-main' | 'nemotron', contextTokens: id === 'qwen-main-48k' ? 49152 as const : 32768 as const };
}

export function assertMicroStrongProfileEvidence(selected: import('../src/runtime/types.js').LocalModel, result: import('../src/runtime/types.js').RuntimeResult, binding: { model: import('../src/runtime/types.js').LocalModel }) {
  if (selected.id !== 'qwen-main-48k') return;
  assert.equal(selected.contextTokens, 49152);
  assert.equal(binding.model.contextTokens, 49152);
  assert.equal(binding.model.id, selected.id);
  assert.equal(binding.model.artifactIdentity, selected.artifactIdentity);
  assert.equal(result.artifactIdentity, selected.artifactIdentity);
  assert.deepEqual(result.inferenceProfile, selected.inferenceProfile);
  assert.deepEqual(binding.model.inferenceProfile, selected.inferenceProfile);
}
