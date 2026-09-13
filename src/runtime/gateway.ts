import {ProviderAvailabilityError} from './resource-budget.js';
import { FreeInferencePool } from './free-pool/pool.js';
import { PoolUnavailableError, PoolRequestUnsupportedError, PoolContextOverflowError } from './free-pool/types.js';
import { completionSSE } from './free-pool/transport.js';
import { Readable } from 'node:stream';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { GeminiSignatures } from './gemini-signatures.js';
import { DirectFree } from './direct-free.js';
import { OpenRouterFree, OpenRouterCooldownError } from './openrouter.js';
import type { OwnedOllama } from './ollama.js';
import type { ExecuteRequest, RuntimeModel, NativeStepLimit, RuntimeEvent } from './types.js';
import { requestLocalInference } from './inference-http.js';
import { normalizeAssistantTail } from './messages.js';

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 12 * 1024 * 1024) throw new Error('Request exceeds bounded context/attachment transport');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function reject(response: ServerResponse, status: number, message: string, code?: string): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: { message, type: 'policy_denied', ...(code ? { code } : {}) } }));
}

// Pinned upstream appends this exact synthetic assistant message to a model
// request when agent.steps is reached. It is absent from stored messages; never
// infer exhaustion from the model's prose or quoted tool/user output.
// https://github.com/anomalyco/opencode/blob/v1.18.30/packages/core/src/session/runner/max-steps.ts
// https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/session/prompt.ts#L1211
function hasNativeStepLimit(messages: unknown[]): boolean {
  const last = messages.at(-1) as { role?: unknown; content?: unknown; tool_calls?: unknown } | undefined;
  return last?.role === 'assistant' && typeof last.content === 'string' && !last.tool_calls
    && createHash('sha256').update(last.content).digest('hex') === 'a22542c356f74bfe3f8edc3f2251f6d5b3ee2e21746040eb602fa57283397404';
}

export class RunGateway {
  readonly secret = randomBytes(32).toString('hex');
  private server?: Server;
  private cancelled = false;
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;
  private admittedInferences = 0;
  private readonly requests = new Set<AbortController>();
  sessionId?: string;
  port = 0;
  usage = { inputTokens: 0, outputTokens: 0, requests: 0 };
  stepCount = 0;
  nativeStepLimit?: NativeStepLimit;
  firstRequestCapacityWait?: { provider: string; retryAt: string };
  beforeEmployeeInference?: (toolNames: string[], signal: AbortSignal) => Promise<boolean>;
  private finalResponse = false;
  private readonly geminiSignatures = new GeminiSignatures();

  constructor(
    private readonly ollama: OwnedOllama | OpenRouterFree | DirectFree | FreeInferencePool,
    private readonly model: RuntimeModel,
    private readonly run: ExecuteRequest,
    private readonly emit: (event: RuntimeEvent) => void,
    private readonly onContext?: (payload: unknown) => void,
  ) {
    if (run.brokerUrl) {
      const url = new URL(run.brokerUrl);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash) {
        throw new Error('Corporate MCP broker must be a dedicated loopback URL');
      }
    }
  }

  get url(): string { return `http://127.0.0.1:${this.port}`; }
  get inferenceActive(): boolean { return this.admittedInferences > 0; }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        if (!res.headersSent && (error instanceof PoolUnavailableError || error instanceof OpenRouterCooldownError || error instanceof ProviderAvailabilityError)) {
          const retryAt = error instanceof PoolUnavailableError ? error.retryAt : Date.parse(error.retryAt);
          const waitMs = retryAt - Date.now();
          // Native 429 retries cannot outlive the four-minute idle watchdog.
          // End this turn with the actual capacity cause instead of parking it
          // until an unrelated idle timeout. An untouched first pool request
          // can wait durably instead; later short cooldowns retain this session.
          if (!Number.isFinite(waitMs) || waitMs >= 4 * 60_000 || error instanceof PoolUnavailableError && this.usage.requests === 1 && this.run.deferInitialPoolWait && waitMs > 0) {
            if (error instanceof PoolUnavailableError && this.usage.requests === 1 && Number.isFinite(retryAt)) this.firstRequestCapacityWait = { provider: 'free-pool', retryAt: new Date(retryAt).toISOString() };
            reject(res, 400, 'Free inference capacity unavailable within this turn; retained provider cooldown must expire before retry', 'provider_capacity_wait');
          }
          else { res.setHeader('retry-after', String(Math.max(1, Math.ceil(waitMs / 1000)))); reject(res, 429, error.message); }
        }
        else if (!res.headersSent && error instanceof PoolContextOverflowError) reject(res, 400, error.message, 'context_length_exceeded');
        else if (!res.headersSent && error instanceof PoolRequestUnsupportedError) reject(res, 400, error.message);
        else if (!res.headersSent) reject(res, 502, error instanceof Error ? error.message : 'Gateway request failed');
        else res.destroy();
      });
    });
    this.server.on('connection', (socket) => socket.on('error', () => { /* Cancelled clients may reset a denied connection. */ }));
    this.server.on('connect', (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
    this.server.on('upgrade', (_req, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Gateway has no address');
    this.port = address.port;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.cancelled) return reject(response, 409, 'Run is cancelled');
    if (request.headers.authorization !== `Bearer ${this.secret}`) return reject(response, 401, 'Run gateway authentication required');
    const path = request.url;
    if (path === '/v1/chat/completions' && request.method === 'POST') return this.infer(request, response);
    if (path === '/mcp' && ['POST', 'GET', 'DELETE'].includes(request.method ?? '')) return this.mcp(request, response);
    this.emit({ type: 'runtime.network.denied', runId: this.run.runId, payload: { method: request.method, path } });
    reject(response, 403, 'Only the assigned local model and scoped corporate MCP endpoint are reachable');
  }

  private async infer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.sessionId) return reject(response, 409, 'Runtime session must be durably bound before inference');
    const body = JSON.parse((await readBody(request)).toString()) as Record<string, unknown>;
    if (body.model !== this.model.alias || (this.model.local && /cloud|openai|anthropic/i.test(String(body.model)))) {
      return reject(response, 403, 'Hosted or unassigned model rejected before dispatch');
    }
    if (!Array.isArray(body.messages)) return reject(response, 400, 'Messages required');
    const employeeStep = Array.isArray(body.tools) && body.tools.length > 0;
    if (this.usage.requests >= 36) return this.exhausted(response, 'run_budget_exhausted');
    if (employeeStep && this.stepCount >= 32) return this.exhausted(response, 'step_budget_exhausted');
    if (this.queued >= 2) return reject(response, 429, 'Run inference queue is full');
    const controller = new AbortController();
    this.requests.add(controller);
    response.once('close', () => { if (!response.writableEnded) controller.abort(); });
    this.queued++;
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    let admitted = false;
    let dispatchedAt: number | undefined, firstResponseAt: number | undefined, lastResponseAt: number | undefined;
    let responseChunks = 0, generatedContentChunks = 0;
    let firstContentAt: number | undefined, lastContentAt: number | undefined;
    const contentSamples: number[] = [], publicContentSamples: number[] = [];
    let firstPublicContentAt: number | undefined, lastPublicContentAt: number | undefined;
    let finishReason: string | undefined;
    try {
      await previous;
      if (this.cancelled || controller.signal.aborted) return reject(response, 409, 'Run cancelled before model dispatch');
      if (this.usage.requests >= 36) return this.exhausted(response, 'run_budget_exhausted');
      if (employeeStep && this.stepCount >= 32) return this.exhausted(response, 'step_budget_exhausted');
      if(this.ollama instanceof FreeInferencePool){if(this.model.provider!=='pool'||!this.run.freeInferencePool)throw new Error('Free pool is not authorized for this run');}
      else if(this.ollama instanceof DirectFree){if(this.model.provider!==this.ollama.provider)throw new Error('Invalid direct provider binding');}
      else if (this.ollama instanceof OpenRouterFree) { if (this.model.provider !== 'openrouter') throw new Error('Invalid provider binding'); }
      else { if (!this.model.local) throw new Error('Invalid local provider binding'); await this.ollama.verifyIdentity(this.model); }
      if (this.cancelled || controller.signal.aborted) return reject(response, 409, 'Run cancelled during model identity verification');
      if ((this.finalResponse || employeeStep && !this.nativeStepLimit && !hasNativeStepLimit(body.messages as unknown[])) && this.beforeEmployeeInference) {
        const names = (Array.isArray(body.tools) ? body.tools as Array<{ function?: { name?: unknown } }> : []).map(tool => tool.function?.name);
        if (names.some(name => typeof name !== 'string' || !name)) throw new Error('Invalid native tool catalog');
        this.finalResponse = await this.beforeEmployeeInference(names as string[], controller.signal) || this.finalResponse;
      }
      controller.signal.throwIfAborted();
      if (this.finalResponse) {
        // The busy loop constructed this request before the real noReply user
        // was appended. Remove its stale tools too; Ollama ignores tool_choice.
        body.tools = []; delete body.tool_choice;
      }
      if (this.run.workload === 'social') { body.tools = []; delete body.tool_choice; }
      if(this.model.provider==='zai'){
        const finalOnly=this.finalResponse||hasNativeStepLimit(body.messages as unknown[])||!employeeStep;
        if(body.tool_choice!==undefined&&body.tool_choice!=='auto'&&!(finalOnly&&body.tool_choice==='none'))throw new Error('Z.ai supports auto tool choice only');
        if(finalOnly){delete body.tools;delete body.tool_choice;}
      }
      body.max_tokens = Math.min(Number(body.max_tokens) || 4096, this.run.workload === 'social' ? 512 : this.run.provisionOnly&&this.run.corporateOnly ? 1024 : 4096);
      body.temperature = 0.2;
      if (this.model.inferenceProfile) {
        // Pinned Ollama 0.32.13 maps none to false and low to its template cue; nested reasoning
        // takes precedence, so remove it rather than trusting caller options.
        // https://github.com/ollama/ollama/blob/v0.32.13/openai/openai.go#L495
        // https://github.com/ollama/ollama/blob/v0.32.13/openai/openai.go#L654
        delete body.reasoning;
        body.reasoning_effort = this.model.inferenceProfile.reasoningEffort;
      }
      // Ollama ignores unknown provider flags; the owned service additionally
      // fixes the selected context profile and bounded configured parallelism.
      body.stream_options = body.stream ? { include_usage: true } : undefined;
      this.usage.requests++;
      if (employeeStep) this.stepCount++;
      admitted = true; this.admittedInferences++;
      if ((employeeStep || this.finalResponse) && !this.nativeStepLimit && hasNativeStepLimit(body.messages as unknown[])) {
        this.nativeStepLimit = { limit: 32, request: this.usage.requests, toolEnabledSteps: this.stepCount };
        this.emit({ type: 'runtime.agent.step_limit', runId: this.run.runId, payload: this.nativeStepLimit });
      }
      const normalized = normalizeAssistantTail(body.messages as unknown[]);
      body.messages = normalized.messages;
      if (normalized.normalization) this.emit({ type: 'runtime.inference.normalized', runId: this.run.runId,
        payload: { request: this.usage.requests, ...normalized.normalization } });
      dispatchedAt = Date.now();
      this.emit({ type: 'runtime.inference.started', runId: this.run.runId,
        payload: { modelId: this.model.id, artifactIdentity: this.model.artifactIdentity, sessionId: this.sessionId, request: this.usage.requests, dispatchedAt,
          ...(this.finalResponse ? { finalResponseToolFree: true } : {}),
          ...(this.model.inferenceProfile ? { inferenceProfile: this.model.inferenceProfile } : {}),
          ...(employeeStep && this.run.system ? { employeeSystem: {
            sha256: createHash('sha256').update(this.run.system).digest('hex'),
            present: (body.messages as Array<{ role?: string; content?: unknown }>).some(message => message.role === 'system'
              && typeof message.content === 'string' && message.content.includes(this.run.system)),
          } } : {}) } });
      this.onContext?.({ request: this.usage.requests, boundary: 'gateway after normalization, before provider adapter', body });
      if(this.model.provider==='gemini'||this.model.provider==='pool')body.messages=this.geminiSignatures.restore(body.messages as any[]);
      const signatures=this.model.provider==='gemini'||this.model.provider==='pool'?this.geminiSignatures.begin():undefined;
      const onDispatch = (body: Record<string, unknown>) => this.onContext?.({ request: this.usage.requests, boundary: 'provider transport body; headers excluded', body });
      if (this.model.local) onDispatch(body);
      const pooled = this.ollama instanceof FreeInferencePool ? await this.ollama.generate({ messages: body.messages as any[], tools: body.tools as any[], tool_choice: body.tool_choice, max_tokens: Number(body.max_tokens), quality: employeeStep ? 2 : 1, dataClass: this.run.dataClass==='confidential'?'confidential':'internal', purpose: 'work', onDispatch },controller.signal) : undefined;
      if(pooled)this.emit({type:'runtime.inference.routed',runId:this.run.runId,payload:{request:this.usage.requests,modelId:pooled.model}});
      const upstream = pooled ? Object.assign(Readable.from([Buffer.from(body.stream ? completionSSE(pooled,this.model.alias) : JSON.stringify(pooled))]),{statusCode:200,headers:{'content-type':body.stream?'text/event-stream':'application/json'} as Record<string,string>})
        : this.ollama instanceof DirectFree && (this.model.provider==='groq'||this.model.provider==='gemini'||this.model.provider==='zai')
        ? await this.ollama.infer(this.model,body,controller.signal,onDispatch)
        : this.ollama instanceof OpenRouterFree && this.model.provider === 'openrouter'
        ? await this.ollama.infer(this.model, body, controller.signal,onDispatch)
        : await requestLocalInference(`${(this.ollama as OwnedOllama).url}/v1/chat/completions`, JSON.stringify(body), controller.signal);
      const upstreamStatus = upstream.statusCode!;
      if (upstreamStatus < 200 || upstreamStatus >= 300) {
        let detail = '';
        for await (const chunk of upstream) {
          detail += chunk.toString();
          if (detail.length >= 4000) break;
        }
        const signatureMissing=this.model.provider==='gemini'&&/thought[_ ]signature/i.test(detail)&&/missing|required/i.test(detail);
        detail = signatureMissing?'Gemini requires retained tool-call protocol signature':this.model.local ? detail.slice(0, 4000) : `${this.model.provider} request refused; upstream detail withheld`;
        // Ollama currently truncates the original user out of oversized Qwen
        // tool histories, then reports a misleading Jinja HTTP 500. Classify
        // this precise failure as context overflow so OpenCode can compact;
        // retrying the unchanged request cannot repair it.
        const hadUser = (body.messages as Array<{ role?: string }>).some(message => message.role === 'user');
        const overflow = /context.{0,40}(?:exceed|overflow|too long)|maximum context length|input length exceeds/i.test(detail)
          || (hadUser && /no user query found in messages/i.test(detail));
        const status = overflow ? 400 : upstreamStatus;
        const message = overflow ? `maximum context length exceeded (${this.model.contextTokens} tokens); compact the conversation before retrying` : `${this.model.local ? 'Local inference' : `${this.model.provider} free inference`} HTTP ${status}: ${detail}`;
        this.emit({ type: 'runtime.inference.failed', runId: this.run.runId, payload: { modelId: this.model.id, upstreamStatus, status, code: overflow ? 'context_length_exceeded' : 'local_inference_error', detail } });
        const retryAfter = upstream.headers['retry-after'];
        const retryHeaders = typeof retryAfter === 'string' && /^\d{1,6}$/.test(retryAfter) ? { 'retry-after': retryAfter } : {};
        response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...retryHeaders });
        response.end(JSON.stringify({ error: { message, type: 'invalid_request_error', code: overflow ? 'context_length_exceeded' : 'local_inference_error' } }));
        return;
      }
      response.writeHead(upstreamStatus, { 'content-type': upstream.headers['content-type'] ?? 'application/json', 'cache-control': 'no-store' });
      let buffer = '', publicContentStarted = false;
      for await (const chunk of upstream) {
        controller.signal.throwIfAborted();
        const receivedAt = Date.now();
        lastResponseAt = receivedAt; responseChunks++;
        if (firstResponseAt === undefined) {
          firstResponseAt = receivedAt;
          this.emit({ type: 'runtime.inference.first_response', runId: this.run.runId, payload: { request: this.usage.requests, modelId: this.model.id, dispatchedAt, firstResponseAt } });
        }
        response.write(chunk);
        this.emit({ type: 'runtime.inference.progress', runId: this.run.runId, payload: { bytes: chunk.length } });
        buffer += new TextDecoder().decode(chunk);
        if (body.stream) {
          const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
          for (const line of lines) if (line.startsWith('data: ') && !line.includes('[DONE]')) {
            this.recordUsage(line.slice(6));
            let signatureData:any;try{signatureData=JSON.parse(line.slice(6));}catch{/* Ignore malformed fragments. */}
            if(signatureData)signatures?.observe(signatureData);
            try {
              const data = JSON.parse(line.slice(6)) as { choices?: Array<{ finish_reason?: string; delta?: { content?: string; reasoning?: string; reasoning_content?: string; tool_calls?: unknown[] } }> };
              finishReason = data.choices?.find(choice => choice.finish_reason)?.finish_reason ?? finishReason;
              if (data.choices?.some(choice => choice.delta?.content || choice.delta?.tool_calls?.length)) {
                firstPublicContentAt ??= receivedAt; lastPublicContentAt = receivedAt;
                if (publicContentSamples.length < 128) publicContentSamples.push(receivedAt);
                if (!publicContentStarted) {
                  publicContentStarted = true;
                  this.emit({ type: 'runtime.inference.first_content', runId: this.run.runId, payload: { request: this.usage.requests, modelId: this.model.id, firstContentAt: receivedAt } });
                }
              }
              if (data.choices?.some(choice => choice.delta?.content || choice.delta?.reasoning || choice.delta?.reasoning_content || choice.delta?.tool_calls?.length)) {
                generatedContentChunks++; firstContentAt ??= receivedAt; lastContentAt = receivedAt;
                if (contentSamples.length < 128) contentSamples.push(receivedAt);
              }
            } catch { /* Malformed provider fragments are not generation evidence. */ }
          }
        }
      }
      controller.signal.throwIfAborted();
      signatures?.commit();
      if (!body.stream) this.recordUsage(buffer);
      response.end();
      this.emit({ type: 'runtime.inference.finished', runId: this.run.runId, payload: this.usage });
    } catch (error) {
      if (admitted && !controller.signal.aborted) this.emit({ type: 'runtime.inference.failed', runId: this.run.runId,
        payload: { modelId: this.model.id, code: 'local_inference_transport_error', detail: error instanceof Error ? error.message : String(error) } });
      throw error;
    } finally {
      if (admitted) {
        this.admittedInferences--;
        this.emit({ type: 'runtime.inference.observed', runId: this.run.runId, payload: { request: this.usage.requests, modelId: this.model.id,
          artifactIdentity: this.model.artifactIdentity, dispatchedAt, firstResponseAt, lastResponseAt, settledAt: Date.now(), responseChunks, generatedContentChunks, finishReason, firstContentAt, lastContentAt, contentSamples, firstPublicContentAt, lastPublicContentAt, publicContentSamples,
          cancelled: controller.signal.aborted, measurement: 'response-stream interval; dispatch overlap alone does not prove simultaneous inference' } });
      }
      this.queued--; this.requests.delete(controller); release();
    }
  }

  private exhausted(response: ServerResponse, code: 'run_budget_exhausted' | 'step_budget_exhausted'): void {
    this.emit({ type: 'runtime.budget.exhausted', runId: this.run.runId, payload: { code, requests: this.usage.requests, steps: this.stepCount } });
    // A consumed run budget cannot recover through provider retries.
    reject(response, 400, code === 'run_budget_exhausted' ? 'Employee run exhausted its 36 local inference requests' : 'Employee run exhausted its 32 tool-enabled model steps');
  }

  private recordUsage(text: string): void {
    try {
      const data = JSON.parse(text) as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
      if (data.usage) { this.usage.inputTokens += data.usage.prompt_tokens ?? 0; this.usage.outputTokens += data.usage.completion_tokens ?? 0; }
    } catch { /* Incomplete SSE fragment carries no usage. */ }
  }

  private async mcp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.run.brokerUrl || !this.run.token) return reject(response, 404, 'No corporate broker bound');
    const body = request.method === 'POST' ? await readBody(request) : undefined;
    if (body) {
      const message = JSON.parse(body.toString()) as { method?: string };
      if (message.method === 'tools/call' && !this.sessionId) return reject(response, 409, 'Session binding required before corporate tools');
    }
    const controller = new AbortController();
    this.requests.add(controller);
    response.once('close', () => { if (!response.writableEnded) controller.abort(); });
    try {
      const headers: Record<string,string> = {
        authorization: `Bearer ${this.run.token}`,
        accept: 'application/json, text/event-stream', 'content-type': 'application/json',
      };
      if (this.sessionId) headers['x-opencorp-session'] = this.sessionId;
      for (const key of ['mcp-session-id', 'mcp-protocol-version', 'last-event-id']) {
        if (typeof request.headers[key] === 'string') headers[key] = request.headers[key];
      }
      const upstream = await fetch(this.run.brokerUrl, { method: request.method, headers, body: body?.toString(), signal: controller.signal, redirect: 'error' });
      const outputHeaders: Record<string,string> = { 'content-type': upstream.headers.get('content-type') ?? 'application/json' };
      const session = upstream.headers.get('mcp-session-id');
      if (session) outputHeaders['mcp-session-id'] = session;
      response.writeHead(upstream.status, outputHeaders);
      if (upstream.body) for await (const chunk of upstream.body) response.write(chunk);
      response.end();
    } finally { this.requests.delete(controller); }
  }

  async close(): Promise<void> {
    this.cancelled = true;
    for (const controller of this.requests) controller.abort();
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => { if (!this.server) return resolve(); this.server.close(() => resolve()); });
  }
}
