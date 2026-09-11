import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { RunGateway } from '../src/runtime/gateway.js';
import { startRunWatchdog } from '../src/runtime/index.js';
import { requestLocalInference } from '../src/runtime/inference-http.js';
import type { OwnedOllama } from '../src/runtime/ollama.js';
import type { LocalModel, RuntimeEvent } from '../src/runtime/types.js';

const model = { id: 'small', alias: 'opencorp-small-fixture', contextTokens: 16384, artifactIdentity: 'fixture' } as LocalModel;
const complete = 'data: {"choices":[{"finish_reason":"tool_calls","delta":{"tool_calls":[{"function":{"name":"write","arguments":"{\\"content\\":\\"buffered fixture\\"}"}}]}}],"usage":{"prompt_tokens":20,"completion_tokens":10}}\n\ndata: [DONE]\n\n';
async function body(response: IncomingMessage): Promise<string> {
  let text = ''; for await (const chunk of response) text += chunk.toString(); return text;
}
function outcome<T>(value: Promise<T>) { return value.then(result => ({ result }), error => ({ error })); }
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !predicate(); i++) await delay(2);
  expect(predicate()).toBe(true);
}

async function fixture(options: { headers?: boolean; verifyIdentity?: () => Promise<void>; onEvent?: (event: RuntimeEvent) => void } = {}) {
  const pending: ServerResponse[] = [], events: RuntimeEvent[] = [];
  let latestProgress = Date.now();
  const upstream = createServer(async (req, res) => {
    for await (const _chunk of req) { /* Consume the actual outgoing request. */ }
    pending.push(res);
    if (options.headers) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); }
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address(); if (!address || typeof address === 'string') throw new Error('Fixture port unavailable');
  const upstreamUrl = `http://127.0.0.1:${address.port}/v1/chat/completions`;
  const gateway = new RunGateway({ url: `http://127.0.0.1:${address.port}`, verifyIdentity: options.verifyIdentity ?? (async () => {}) } as unknown as OwnedOllama,
    model, { runId: 'lifecycle', employeeId: 'employee', modelId: model.id, workspace: '/unused', system: '', prompt: '' }, event => {
      latestProgress = Date.now(); events.push(event); options.onEvent?.(event);
    });
  await gateway.start(); gateway.sessionId = 'bound-session';
  const invoke = (signal?: AbortSignal) => new Promise<IncomingMessage>((resolve, reject) => {
    const req = request(`${gateway.url}/v1/chat/completions`, { method: 'POST', signal, agent: false,
      headers: { authorization: `Bearer ${gateway.secret}` } }, resolve);
    req.on('error', reject);
    req.end(JSON.stringify({ model: model.alias, messages: [{ role: 'user', content: 'fixture' }], stream: true,
      tools: [{ type: 'function', function: { name: 'write', parameters: { type: 'object', properties: { content: { type: 'string' } } } } }] }));
  });
  return { gateway, pending, events, invoke, upstreamUrl,
    state: () => ({ latestProgress, activeTools: 0, inferenceActive: gateway.inferenceActive }),
    close: async () => { await gateway.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); },
  };
}

afterEach(() => vi.useRealTimers());

describe('the directly used runtime watchdog', () => {
  it('still aborts an actually idle runtime after four minutes and clears both timers', () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const stop = startRunWatchdog(controller, () => ({ latestProgress: Date.now() - 250000, activeTools: 0, inferenceActive: false }));
    vi.advanceTimersByTime(10000);
    expect(controller.signal.reason.message).toBe('Employee runtime remained idle for four minutes');
    stop(); expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the original 45-minute hard deadline even with continuously active tools', () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const stop = startRunWatchdog(controller, () => ({ latestProgress: 0, activeTools: 1, inferenceActive: false }));
    vi.advanceTimersByTime(45 * 60000 - 1); expect(controller.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1); expect(controller.signal.reason.message).toBe('Employee run exceeded its bounded execution time');
    stop();
  });

  it.each([false, true])('allows silent admitted inference beyond four/five minutes (headers received=%s), without fabricated progress', async headers => {
    const f = await fixture({ headers });
    const result = outcome(f.invoke().then(async response => ({ status: response.statusCode, type: response.headers['content-type'], text: await body(response) })));
    let stop = () => {};
    try {
      await until(() => f.pending.length === 1);
      vi.useFakeTimers();
      const controller = new AbortController(); stop = startRunWatchdog(controller, f.state);
      expect(f.gateway.inferenceActive).toBe(true);
      await vi.advanceTimersByTimeAsync(310000);
      expect(controller.signal.aborted).toBe(false);
      expect(f.events.filter(event => event.type === 'runtime.inference.progress')).toHaveLength(0);
      expect(f.gateway.usage).toEqual({ requests: 1, inputTokens: 0, outputTokens: 0 });
      if (!headers) f.pending[0].writeHead(200, { 'content-type': 'text/event-stream' });
      f.pending[0].end(complete);
      expect(await result).toEqual({ result: { status: 200, type: 'text/event-stream', text: complete } });
      await until(() => !f.gateway.inferenceActive);
      expect(f.gateway.usage).toEqual({ requests: 1, inputTokens: 20, outputTokens: 10 });
      expect(f.gateway.stepCount).toBe(1);
      await vi.advanceTimersByTimeAsync(250000);
      expect(controller.signal.reason.message).toBe('Employee runtime remained idle for four minutes');
    } finally { stop(); vi.useRealTimers(); await f.close(); }
  });

  it.each([
    { headers: false, action: 'cancel' }, { headers: true, action: 'cancel' },
    { headers: false, action: 'deadline' }, { headers: true, action: 'deadline' },
  ])('terminates silent inference and response on $action (headers received=$headers)', async ({ headers, action }) => {
    const f = await fixture({ headers });
    const result = outcome(f.invoke().then(body));
    let stop = () => {};
    try {
      await until(() => f.pending.length === 1);
      vi.useFakeTimers();
      const controller = new AbortController();
      let closing = Promise.resolve();
      controller.signal.addEventListener('abort', () => { closing = f.gateway.close(); }, { once: true });
      stop = startRunWatchdog(controller, f.state);
      if (action === 'cancel') controller.abort(new Error('Owner pause'));
      else await vi.advanceTimersByTimeAsync(45 * 60000);
      expect(controller.signal.reason.message).toBe(action === 'cancel' ? 'Owner pause' : 'Employee run exceeded its bounded execution time');
      expect(await result).toHaveProperty('error');
      await closing;
      await until(() => !f.gateway.inferenceActive && f.pending[0].destroyed);
      expect(f.gateway.usage.requests).toBe(1);
      expect(f.events.some(event => event.type === 'runtime.inference.finished')).toBe(false);
    } finally { stop(); vi.useRealTimers(); await f.close(); }
  });
});

describe('inference admission and queue cleanup', () => {
  it('never emits successful completion when cancellation races the final body chunk', async () => {
    const bound: { gateway?: RunGateway } = {};
    const f = await fixture({ onEvent: event => { if (event.type === 'runtime.inference.progress') void bound.gateway!.close(); } });
    bound.gateway = f.gateway;
    const result = outcome(f.invoke().then(body));
    try {
      await until(() => f.pending.length === 1);
      f.pending[0].writeHead(200, { 'content-type': 'text/event-stream' }); f.pending[0].end(complete);
      expect(await result).toHaveProperty('error');
      await until(() => !f.gateway.inferenceActive);
      expect(f.events.some(event => event.type === 'runtime.inference.finished')).toBe(false);
    } finally { await f.close(); }
  });

  it('does not count identity verification as admitted or dispatch after cancellation during it', async () => {
    let release!: () => void, verifying = false;
    const verification = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture({ verifyIdentity: async () => { verifying = true; await verification; } });
    const result = outcome(f.invoke().then(body));
    try {
      await until(() => verifying);
      expect(f.gateway.inferenceActive).toBe(false); expect(f.gateway.usage.requests).toBe(0);
      await f.gateway.close(); release();
      expect(await result).toHaveProperty('error');
      await delay(10);
      expect(f.pending).toHaveLength(0); expect(f.gateway.inferenceActive).toBe(false);
      expect(f.gateway.usage.requests).toBe(0);
    } finally { release(); await f.close(); }
  });

  it('clears admission on a transport failure and admits the queued request exactly once', async () => {
    const f = await fixture();
    const first = outcome(f.invoke().then(async response => ({ status: response.statusCode, text: await body(response) })));
    try {
      await until(() => f.pending.length === 1);
      const second = outcome(f.invoke().then(body));
      await delay(20);
      expect(f.gateway.usage.requests).toBe(1);
      f.pending[0].destroy(new Error('fixture upstream failure'));
      expect(await first).toMatchObject({ result: { status: 502 } });
      expect(f.events).toContainEqual(expect.objectContaining({ type: 'runtime.inference.failed', payload: expect.objectContaining({ code: 'local_inference_transport_error' }) }));
      await until(() => f.pending.length === 2);
      expect(f.gateway.inferenceActive).toBe(true); expect(f.gateway.usage.requests).toBe(2);
      f.pending[1].writeHead(200, { 'content-type': 'text/event-stream' }); f.pending[1].end(complete);
      expect(await second).toEqual({ result: complete });
      await until(() => !f.gateway.inferenceActive);
    } finally { await f.close(); }
  });

  it('clears admission after an HTTP error, preserving its actual status', async () => {
    const f = await fixture();
    const result = outcome(f.invoke().then(async response => ({ status: response.statusCode, text: await body(response) })));
    try {
      await until(() => f.pending.length === 1);
      f.pending[0].writeHead(422); f.pending[0].end('invalid fixture arguments');
      expect(await result).toMatchObject({ result: { status: 422 } });
      expect(f.gateway.inferenceActive).toBe(false);
      expect(f.events).toContainEqual(expect.objectContaining({ type: 'runtime.inference.failed', payload: expect.objectContaining({ upstreamStatus: 422 }) }));
    } finally { await f.close(); }
  });

  it('cancels the admitted and queued requests without dispatching the queued work', async () => {
    const f = await fixture();
    const first = outcome(f.invoke().then(body));
    try {
      await until(() => f.pending.length === 1);
      const second = outcome(f.invoke().then(body));
      await delay(20);
      expect(f.gateway.usage.requests).toBe(1);
      await f.gateway.close();
      expect(await first).toHaveProperty('error'); expect(await second).toHaveProperty('error');
      await until(() => !f.gateway.inferenceActive && f.pending[0].destroyed);
      expect(f.pending).toHaveLength(1); expect(f.gateway.usage.requests).toBe(1);
    } finally { await f.close(); }
  });
});

describe('signal-owned exact loopback HTTP transport', () => {
  it('keeps cancellation bound after streaming headers and body bytes have arrived', async () => {
    const f = await fixture();
    try {
      const controller = new AbortController();
      const response = requestLocalInference(f.upstreamUrl, '{}', controller.signal);
      await until(() => f.pending.length === 1);
      f.pending[0].writeHead(200, { 'content-type': 'text/event-stream' }); f.pending[0].write('first buffered prefix');
      const upstream = await response, iterator = upstream[Symbol.asyncIterator]();
      expect((await iterator.next()).value.toString()).toBe('first buffered prefix');
      const remaining = outcome(iterator.next());
      controller.abort(new Error('Owner stop after response headers'));
      expect(await remaining).toHaveProperty('error');
      await until(() => f.pending[0].destroyed);
    } finally { await f.close(); }
  });

  it.each(['https://127.0.0.1:9/v1/chat/completions', 'http://localhost:9/v1/chat/completions',
    'http://127.0.0.1:9/api/chat', 'http://user:secret@127.0.0.1:9/v1/chat/completions',
    'http://127.0.0.1:9/v1/chat/completions?remote=true'])('rejects an unowned endpoint %s', url => {
    expect(() => requestLocalInference(url, '{}', new AbortController().signal)).toThrow('owned loopback');
  });

  it('does not follow redirects or dispatch an already aborted request', async () => {
    const f = await fixture();
    try {
      const controller = new AbortController(); controller.abort(new Error('cancelled before dispatch'));
      expect(() => requestLocalInference(f.upstreamUrl, '{}', controller.signal)).toThrow('cancelled before dispatch');
      expect(f.pending).toHaveLength(0);
      const result = requestLocalInference(f.upstreamUrl, '{}', new AbortController().signal);
      await until(() => f.pending.length === 1);
      f.pending[0].writeHead(302, { location: 'http://127.0.0.1:1/forbidden' }); f.pending[0].end('redirect refused');
      const response = await result;
      expect(response.statusCode).toBe(302); expect(await body(response)).toBe('redirect refused');
      expect(f.pending).toHaveLength(1);
    } finally { await f.close(); }
  });
});
