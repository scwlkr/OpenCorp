import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { RunGateway } from '../src/runtime/gateway.js';
import { localInferenceProfile, type OwnedOllama } from '../src/runtime/ollama.js';
import type { LocalModel, RuntimeEvent } from '../src/runtime/types.js';

// Exact source fixture, without its surrounding TypeScript string declaration:
// https://github.com/anomalyco/opencode/blob/v1.18.30/packages/core/src/session/runner/max-steps.ts
const maxSteps = await readFile(new URL('./fixtures/opencode-1.18.30-max-steps.txt', import.meta.url), 'utf8');
const model = { id: 'small', alias: 'opencorp-small-fixture', contextTokens: 16384, artifactIdentity: 'fixture-artifact' } as LocalModel;

type Message = { role: string; content: string; tool_calls?: unknown[] };
async function fixture(selectedModel: LocalModel = model, enforceAssistantPrefill = false) {
  const seen: Array<{ messages: Message[]; reasoning?: unknown; reasoning_effort?: unknown; max_tokens?: number }> = [];
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    seen.push(JSON.parse(Buffer.concat(chunks).toString()));
    if (enforceAssistantPrefill && seen.at(-1)!.messages.slice(-2).length === 2
      && seen.at(-1)!.messages.slice(-2).every(message => message.role === 'assistant')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Cannot have 2 or more assistant messages at the end of the list.' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Actual checkpoint retained.' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address(); if (!address || typeof address === 'string') throw new Error('No fixture port');
  const events: RuntimeEvent[] = [];
  const system = 'Employee fixture-authority. Zero approved spending. Persist actual work.';
  const gateway = new RunGateway({ url: `http://127.0.0.1:${address.port}`, verifyIdentity: async () => {} } as unknown as OwnedOllama,
    selectedModel, { runId: 'native-limit-fixture', employeeId: 'employee', workspace: '/unused', modelId: 'small', system, prompt: '' }, event => events.push(event));
  await gateway.start(); gateway.sessionId = 'bound';
  return { gateway, events, seen, system, upstreamUrl: `http://127.0.0.1:${address.port}`,
    request: (messages: Message[], withTools = true, overrides: Record<string, unknown> = {}) => fetch(`${gateway.url}/v1/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${gateway.secret}` }, body: JSON.stringify({ ...overrides, model: selectedModel.alias, messages,
        tools: withTools ? [{ type: 'function', function: { name: 'read', parameters: {} } }] : [] }),
    }),
    close: async () => { await gateway.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); },
  };
}

describe('verified checkpoint final-response boundary', () => {
  it('settles the native control request before forwarding, removes stale tools, and charges every real inference', async () => {
    const f = await fixture(); let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; }); let calls = 0;
    f.gateway.beforeEmployeeInference = async names => { calls++; if (calls === 1) { expect(names).toEqual(['read']); await ready; } return true; };
    try {
      const first = f.request([{ role: 'user', content: 'Original task' }]);
      while (!calls) await new Promise(resolve => setTimeout(resolve, 1));
      expect(f.seen).toEqual([]); expect(f.gateway.usage.requests).toBe(0); release();
      expect((await first).status).toBe(200);
      expect((await f.request([{ role: 'user', content: 'Actual stored final-response request' }], false)).status).toBe(200);
      expect(f.seen.map(item => (item as any).tools)).toEqual([[], []]); expect(calls).toBe(2);
      expect(f.gateway.usage.requests).toBe(2); expect(f.gateway.stepCount).toBe(1);
      expect(f.events.filter(event => event.type === 'runtime.inference.started').every(event => (event.payload as any).finalResponseToolFree === true)).toBe(true);
    } finally { await f.close(); }
  });
  it('does not steer compaction or exact native exhaustion, and never extends the request budget', async () => {
    const f = await fixture(); let calls = 0; f.gateway.beforeEmployeeInference = async () => { calls++; return true; };
    try {
      await f.request([{ role: 'user', content: 'Summarize' }], false);
      await f.request([{ role: 'user', content: 'Task' }, { role: 'assistant', content: maxSteps }]);
      expect(calls).toBe(0); expect(f.gateway.nativeStepLimit).toBeDefined();
      f.gateway.usage.requests = 36; expect((await f.request([{ role: 'user', content: 'More' }])).status).toBe(400);
      expect(calls).toBe(0); expect(f.seen).toHaveLength(2);
    } finally { await f.close(); }
  });
  it('keeps pending steering under original gateway cancellation and sends no upstream request', async () => {
    const f = await fixture(); let entered = false;
    f.gateway.beforeEmployeeInference = async (_names, signal) => new Promise((_resolve, reject) => {
      entered = true; signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const response = f.request([{ role: 'user', content: 'Task' }]).catch(() => undefined);
    while (!entered) await new Promise(resolve => setTimeout(resolve, 1));
    await f.close(); await response; expect(f.seen).toEqual([]); expect(f.gateway.inferenceActive).toBe(false);
  });
});

describe('actual gateway assistant-prefill dispatch', () => {
  it('repairs the exact rejected plain-tail shape without retries, deleted text, tool changes or new authority', async () => {
    const f = await fixture(model, true);
    try {
      const messages = [{ role: 'system', content: f.system }, { role: 'user', content: 'Retained task' },
        { role: 'assistant', content: 'Prior tool call', tool_calls: [{ id: 'call-retained' }] }, { role: 'tool', content: 'Observed result', tool_call_id: 'call-retained' },
        { role: 'assistant', content: 'Retained continuation.' }, { role: 'assistant', content: 'Retained continuation.' }];
      const before = structuredClone(messages);
      const direct = await fetch(`${f.upstreamUrl}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: model.alias, messages }) });
      expect(direct.status).toBe(400); expect(await direct.json()).toMatchObject({ error: { message: 'Cannot have 2 or more assistant messages at the end of the list.' } });
      const throughGateway = await f.request(messages);
      expect(throughGateway.status).toBe(200); expect(await throughGateway.json()).toMatchObject({ choices: [{ finish_reason: 'stop' }] });
      expect(f.seen).toHaveLength(2);
      expect(f.seen[1].messages).toEqual([...before.slice(0, -2), { role: 'assistant', content: 'Retained continuation.\n\nRetained continuation.' }]);
      expect(messages).toEqual(before); expect(f.gateway.usage.requests).toBe(1); expect(f.gateway.stepCount).toBe(1);
      expect(f.gateway.inferenceActive).toBe(false);
      const normalizations = f.events.filter(event => event.type === 'runtime.inference.normalized');
      expect(normalizations).toHaveLength(1);
      expect(normalizations[0].payload).toMatchObject({ request: 1, kind: 'plain_assistant_tail', firstIndex: 4, originalCount: 2, normalizedCount: 1 });
      expect(JSON.stringify(normalizations)).not.toContain('Retained continuation.');
      expect(f.events.find(event => event.type === 'runtime.inference.started')?.payload).toMatchObject({ employeeSystem: { present: true } });
    } finally { await f.close(); }
  });

  it('recognizes the exact native step limit before normalizing its assistant tail', async () => {
    const f = await fixture(model, true);
    try {
      const messages = [{ role: 'user', content: 'Task' }, { role: 'assistant', content: 'Prior response' }, { role: 'assistant', content: maxSteps }];
      expect((await f.request(messages)).status).toBe(200);
      expect(f.gateway.nativeStepLimit).toEqual({ limit: 32, request: 1, toolEnabledSteps: 1 });
      expect(f.seen[0].messages.at(-1)).toEqual({ role: 'assistant', content: `Prior response\n\n${maxSteps}` });
      expect(f.events.findIndex(event => event.type === 'runtime.agent.step_limit'))
        .toBeLessThan(f.events.findIndex(event => event.type === 'runtime.inference.normalized'));
    } finally { await f.close(); }
  });

  it('does not bypass exhausted request budgets to normalize or dispatch', async () => {
    const f = await fixture(model, true);
    try {
      f.gateway.usage.requests = 36;
      expect((await f.request([{ role: 'assistant', content: 'First' }, { role: 'assistant', content: 'Second' }])).status).toBe(400);
      expect(f.seen).toEqual([]); expect(f.events.some(event => event.type === 'runtime.inference.normalized')).toBe(false);
    } finally { await f.close(); }
  });
});

describe('owned Qwen inference profile', () => {
  it('enforces none for employee and compaction requests despite competing nested reasoning', async () => {
    const inferenceProfile = localInferenceProfile('qwen-main');
    const f = await fixture({ ...model, id: 'qwen-main', alias: 'opencorp-qwen-fixture', inferenceProfile });
    try {
      for (const withTools of [true, false]) {
        expect((await f.request([{ role: 'user', content: 'Fixture request' }], withTools,
          { reasoning_effort: 'high', reasoning: { effort: 'max' }, max_tokens: 9000 })).status).toBe(200);
      }
      expect(f.seen).toHaveLength(2);
      for (const request of f.seen) {
        expect(request.reasoning_effort).toBe('none'); expect(request).not.toHaveProperty('reasoning');
        expect(request.max_tokens).toBe(4096);
      }
      expect(f.gateway.usage.requests).toBe(2); expect(f.gateway.stepCount).toBe(1);
      expect(f.events.filter(event => event.type === 'runtime.inference.started').map(event => event.payload))
        .toEqual([expect.objectContaining({ inferenceProfile }), expect.objectContaining({ inferenceProfile })]);
    } finally { await f.close(); }
  });

  it.each(['nemotron', 'small'])('leaves %s reasoning behavior unchanged', async id => {
    const f = await fixture({ ...model, id, inferenceProfile: localInferenceProfile(id) });
    try {
      await f.request([{ role: 'user', content: 'Fixture request' }], true, { reasoning_effort: 'low', reasoning: { effort: 'medium' } });
      expect(f.seen[0]).toMatchObject({ reasoning_effort: 'low', reasoning: { effort: 'medium' } });
      expect(f.events.find(event => event.type === 'runtime.inference.started')?.payload).not.toHaveProperty('inferenceProfile');
    } finally { await f.close(); }
  });
});

describe('pinned native agent-limit observation', () => {
  it('records the exact admitted upstream synthetic message without losing its final response or changing budgets', async () => {
    const f = await fixture();
    try {
      // Compactions count toward OpenCode's internal 32 iterations; only 27
      // tool-enabled requests have occurred at the observed real-run boundary.
      f.gateway.usage.requests = 31; f.gateway.stepCount = 26;
      const messages = [{ role: 'user', content: 'Continue retained work' }, { role: 'assistant', content: maxSteps }];
      const response = await f.request(messages);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ choices: [{ finish_reason: 'stop', message: { content: 'Actual checkpoint retained.' } }] });
      expect(f.gateway.nativeStepLimit).toEqual({ limit: 32, request: 32, toolEnabledSteps: 27 });
      expect(f.gateway.usage.requests).toBe(32); expect(f.gateway.stepCount).toBe(27);
      expect(f.seen[0].messages).toEqual(messages);
      expect(f.events.filter(event => event.type === 'runtime.agent.step_limit')).toEqual([
        { type: 'runtime.agent.step_limit', runId: 'native-limit-fixture', payload: { limit: 32, request: 32, toolEnabledSteps: 27 } },
      ]);
      expect(f.events.some(event => event.type === 'runtime.budget.exhausted')).toBe(false);
      await f.request(messages);
      expect(f.events.filter(event => event.type === 'runtime.agent.step_limit')).toHaveLength(1);
      expect(f.gateway.nativeStepLimit?.request).toBe(32);
    } finally { await f.close(); }
  });

  it('does not classify quoted text, model prose, earlier history, tool results or compaction as the native limit', async () => {
    const f = await fixture();
    try {
      for (const messages of [
        [{ role: 'user', content: maxSteps }],
        [{ role: 'tool', content: maxSteps }],
        [{ role: 'assistant', content: `I believe this occurred: ${maxSteps}` }],
        [{ role: 'assistant', content: 'Maximum agent steps reached - tools disabled' }],
        [{ role: 'assistant', content: maxSteps }, { role: 'user', content: 'New task' }],
        [{ role: 'assistant', content: maxSteps, tool_calls: [{ id: 'not-synthetic' }] }],
      ]) expect((await f.request(messages)).status).toBe(200);
      expect((await f.request([{ role: 'assistant', content: maxSteps }], false)).status).toBe(200);
      expect(f.gateway.nativeStepLimit).toBeUndefined();
      expect(f.events.some(event => event.type === 'runtime.agent.step_limit')).toBe(false);
    } finally { await f.close(); }
  });

  it('retains hash and presence proof from actual outbound employee system messages without prompt contents', async () => {
    const f = await fixture();
    try {
      await f.request([{ role: 'system', content: `Persistent configured agent\n${f.system}\nWorkspace instructions` }, { role: 'user', content: 'Compacted continuation' }]);
      await f.request([{ role: 'system', content: 'Generic agent only' }, { role: 'user', content: 'Compacted continuation' }]);
      await f.request([{ role: 'user', content: 'Summarize compaction' }], false);
      const events = f.events.filter(event => event.type === 'runtime.inference.started');
      const sha256 = createHash('sha256').update(f.system).digest('hex');
      expect(events[0].payload).toMatchObject({ employeeSystem: { sha256, present: true } });
      expect(events[1].payload).toMatchObject({ employeeSystem: { sha256, present: false } });
      expect(events[2].payload).not.toHaveProperty('employeeSystem');
      expect(JSON.stringify(events)).not.toContain(f.system);
    } finally { await f.close(); }
  });
});
