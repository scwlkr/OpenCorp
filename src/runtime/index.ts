import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { createOpencodeClient, type Config, type FilePartInput } from '@opencode-ai/sdk/v2';
import { completeSession } from './session.js';
import { assertFinalResponseCheckpoint, FinalResponseRequest } from './final-response.js';
import { captureFailureMessages } from './evidence.js';
import { OwnedLoopbackProxy } from './loopback.js';
import { OwnedOllama, availablePort } from './ollama.js';
import { RunGateway } from './gateway.js';
import { minimalEnvironment, prepareHome, spawnOwned, stopOwned, recoverOwnedReceipt, recoverOwnedJobs } from './processes.js';
import { openCodeCommand, wrapWorker } from './sandbox.js';
import { CONTEXT_TOKENS, RuntimeExecutionError, type RuntimeFailureEvidence, type RuntimeFailureCode, type ExecuteRequest, type LocalModel, type RuntimeEvent, type RuntimeOptions, type RuntimeResult, type NativeStepLimit } from './types.js';
export * from './types.js';
export { executeSandboxed } from './tool-process.js';
export { wrapWorker, opencodeBinary, dependenciesRoot } from './sandbox.js';

interface ActiveRun { controller: AbortController; done: Promise<void> }

export function startRunWatchdog(controller: AbortController, state: () => {
  latestProgress: number; activeTools: number; inferenceActive: boolean;
}, timeoutMs = 45 * 60 * 1000): () => void {
  const deadline = setTimeout(() => controller.abort(new Error('Employee run exceeded its bounded execution time')), timeoutMs);
  const idle = setInterval(() => {
    const current = state();
    // An admitted local inference may be prefilling or buffering tool JSON.
    // Its silence is not evidence of idleness; the original deadline still applies.
    if (!current.activeTools && !current.inferenceActive && Date.now() - current.latestProgress > 4 * 60 * 1000) {
      controller.abort(new Error('Employee runtime remained idle for four minutes'));
    }
  }, 10000);
  return () => { clearTimeout(deadline); clearInterval(idle); };
}

export class LocalRuntime {
  private readonly ollama: OwnedOllama;
  private active = new Map<string, ActiveRun>();
  private stopping = false;
  private started = false;
  private cachedModels: LocalModel[] = [];
  private generation = 0;

  constructor(private readonly options: RuntimeOptions) {
    this.ollama = new OwnedOllama(options);
  }

  async start(): Promise<void> {
    const generation = ++this.generation;
    this.stopping = false;
    await this.ollama.start();
    if (generation !== this.generation || this.stopping) throw new Error('Runtime startup superseded by stop');
    this.started = true;
  }

  async installModels(): Promise<LocalModel[]> {
    await this.start();
    await this.ollama.ensureSmallModel();
    return this.models();
  }

  async models(): Promise<LocalModel[]> {
    if (this.stopping) return this.cachedModels;
    await this.ollama.start();
    if (this.stopping) return this.cachedModels;
    this.cachedModels = await this.ollama.models();
    return this.cachedModels;
  }

  status(): { started: boolean; activeRuns: string[]; ollama: ReturnType<OwnedOllama['status']>; inferenceSlots: 1; contextTokens: number } {
    return { started: this.started, activeRuns: [...this.active.keys()], ollama: this.ollama.status(), inferenceSlots: 1, contextTokens: CONTEXT_TOKENS };
  }

  async execute(request: ExecuteRequest): Promise<RuntimeResult> {
    if (this.stopping) throw new Error('Runtime stopping; new dispatch refused');
    if (this.active.size) throw new Error('The single local inference slot is occupied; retain this assignment in the durable queue');
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(request.runId)) throw new Error('Invalid run ID');
    if (request.contextTokens && ![16384, 32768].includes(request.contextTokens)) throw new Error('Local context must be 16K or 32K');
    request.signal?.throwIfAborted();
    const controller = new AbortController();
    const signal = request.signal ? AbortSignal.any([controller.signal, request.signal]) : controller.signal;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    this.active.set(request.runId, { controller, done });
    try {
      await this.ollama.start();
      signal.throwIfAborted();
      this.started = true;
      const models = await this.ollama.models(request.contextTokens ?? CONTEXT_TOKENS);
      const model = models.find((entry) => entry.id === request.modelId || entry.alias === request.modelId || entry.sourceAlias === request.modelId);
      if (!model) throw new Error(`Model is outside the installed local pool: ${request.modelId}`);
      if (request.imagePaths?.length && !model.capabilities.includes('vision')) throw new Error('Selected local artifact does not support image input');
      signal.throwIfAborted();
      return await this.run(request, model, signal);
    } finally { this.active.delete(request.runId); finish(); }
  }

  private async run(request: ExecuteRequest, model: LocalModel, signal: AbortSignal): Promise<RuntimeResult> {
    const began = Date.now();
    const workerRoot = join(this.options.dataRoot, 'runtime', 'employees', request.runId);
    const home = join(workerRoot, 'home');
    await prepareHome(home);
    await mkdir(request.workspace, { recursive: true });
    let latestProgress = Date.now();
    let budgetFailure: RuntimeFailureCode | undefined;
    const activeTools = new Set<string>();
    const emit = (event: RuntimeEvent): void => {
      latestProgress = Date.now();
      if (event.type === 'runtime.budget.exhausted') budgetFailure = (event.payload as { code: RuntimeFailureCode }).code;
      if (event.type === 'runtime.tool') {
        const part = event.payload as { id: string; state: { status: string } };
        if (part.state.status === 'pending' || part.state.status === 'running') activeTools.add(part.id);
        else activeTools.delete(part.id);
      }
      // Do not flood durable company state with individual token chunks.
      if (event.type === 'runtime.inference.progress') return;
      this.options.onEvent?.(event); request.onEvent?.(event);
    };
    const gateway = new RunGateway(this.ollama, model, request, emit);
    await gateway.start();
    const serverPort = await availablePort();
    const localTestProxy = request.toolEnvironment ? new OwnedLoopbackProxy([serverPort, gateway.port]) : undefined;
    const password = randomBytes(32).toString('hex');
    const timeout = new AbortController();
    const turnSignal = AbortSignal.any([signal, timeout.signal]);
    const stopWatchdog = startRunWatchdog(timeout, () => ({ latestProgress, activeTools: activeTools.size, inferenceActive: gateway.inferenceActive }), request.timeoutMs);
    const config = runtimeConfig(model, gateway.url, gateway.secret, Boolean(request.brokerUrl), request);
    let output = '';
    let child: Awaited<ReturnType<typeof spawnOwned>> | undefined;
    let sessionId = '';
    let diagnosticResult: RuntimeResult | undefined;
    let admittedContinuations = 0;
    let failureEvidence: RuntimeFailureEvidence | undefined;
    let client: ReturnType<typeof createOpencodeClient> | undefined;
    let finalResponse: FinalResponseRequest | undefined;
    const messagesPath = join(workerRoot, 'messages.json');
    const diagnosticsPath = join(workerRoot, 'result.json');
    const abort = (): void => {
      void gateway.close();
      void stopOwned(child).catch((error: unknown) => emit({ type: 'runtime.stop.uncertain', runId: request.runId, payload: String(error) }));
    };
    turnSignal.addEventListener('abort', abort, { once: true });
    try {
      await localTestProxy?.start();
      const command = await wrapWorker({ command: openCodeCommand(serverPort), runId: request.runId,
        workspace: request.workspace, home, gatewayPort: gateway.port, serverPort, toolEnvironment: request.toolEnvironment, localTestProxy });
      const env = {
        ...minimalEnvironment(home),
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_CONFIG_DIR: join(home, 'config', 'opencode'),
        OPENCODE_AUTH_CONTENT: '{}', OPENCODE_SERVER_USERNAME: 'opencorp', OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
        OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true',
        OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true', OPENCODE_DISABLE_CLAUDE_CODE: 'true',
        OPENCODE_DISABLE_LSP_DOWNLOAD: 'true', OPENCODE_DISABLE_SHARE: 'true',
        OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: 'true', OPENCODE_PURE: 'true',
      };
      child = await spawnOwned({ controlRoot: join(this.options.dataRoot, 'runtime', 'control'),
        command: '/bin/bash', args: ['--noprofile', '--norc', '-c', command],
        cwd: request.workspace, env, signal: turnSignal, receiptPath: join(workerRoot, 'process.json'),
        onOutput: (chunk) => { output = (output + chunk).slice(-24000); },
      });
      if (localTestProxy) localTestProxy.receiptPath = child.receiptPath;
      const baseUrl = `http://127.0.0.1:${serverPort}`;
      const auth = `Basic ${Buffer.from(`opencorp:${password}`).toString('base64')}`;
      const readyBy = Date.now() + 45000;
      let ready = false;
      while (Date.now() < readyBy) {
        turnSignal.throwIfAborted();
        if (child.exitCode !== null) throw new Error(`OpenCode sandbox process exited: ${output}`);
        try {
          const response = await fetch(`${baseUrl}/global/health`, { headers: { authorization: auth }, signal: AbortSignal.timeout(1000) });
          if (response.ok) { ready = true; break; }
        } catch { /* Await headless server readiness. */ }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!ready) throw new Error(`OpenCode sandbox startup timed out: ${output}`);
      client = createOpencodeClient({ baseUrl, directory: resolve(request.workspace), headers: { authorization: auth }, throwOnError: true });
      const created = await client.session.create({ title: `OpenCorp ${request.runId}`, metadata: { runId: request.runId, employeeId: request.employeeId } }, { signal: turnSignal });
      if (!created.data) throw new Error(`OpenCode did not return a session: ${JSON.stringify(created.error)}`);
      sessionId = created.data.id;
      await request.onSession?.(sessionId);
      gateway.sessionId = sessionId;
      await writeFile(join(workerRoot, 'binding.json'), JSON.stringify({ runId: request.runId, employeeId: request.employeeId,
        sessionId, workspace: request.workspace, model, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
      emit({ type: 'runtime.session.bound', runId: request.runId, payload: { sessionId, modelId: model.id, artifactIdentity: model.artifactIdentity,
        ...(model.inferenceProfile ? { inferenceProfile: model.inferenceProfile } : {}) } });
      const subscriptionController = new AbortController();
      const sessionError: { error?: unknown } = {};
      const subscription = client.event.subscribe({ directory: request.workspace }, { signal: AbortSignal.any([turnSignal, subscriptionController.signal]) });
      const events = (async () => {
        try {
          for await (const event of (await subscription).stream) {
            if (event.type === 'session.error' && event.properties.sessionID === sessionId) sessionError.error = event.properties.error;
            if (event.type === 'message.part.updated') {
              const part = event.properties.part;
              if (part.type === 'tool') emit({ type: 'runtime.tool', runId: request.runId, payload: part });
            }
          }
        } catch { /* Cancellation closes event subscription. */ }
      })();
      const images: FilePartInput[] = [];
      for (const path of request.imagePaths ?? []) {
        const data = await readFile(path);
        const mime = extname(path).toLowerCase() === '.jpg' || extname(path).toLowerCase() === '.jpeg' ? 'image/jpeg' : 'image/png';
        images.push({ type: 'file', mime, url: `data:${mime};base64,${data.toString('base64')}` });
      }
      if (request.finalResponseCheckpoint) {
        finalResponse = new FinalResponseRequest({ client, sessionId, modelId: model.alias,
          signal: turnSignal, path: join(workerRoot, 'final-response.json'), checkpoint: request.finalResponseCheckpoint,
          onReceipt: receipt => emit({ type: 'runtime.final_response', runId: request.runId, payload: receipt }) });
        gateway.beforeEmployeeInference = (names, signal) => finalResponse!.atInference(names, signal);
      }
      let result;
      try {
        result = await completeSession({ client, signal: turnSignal, finalResponse,
          sessionError,
          prompt: { sessionID: sessionId, agent: 'employee', model: { providerID: 'opencorp-local', modelID: model.alias },
            parts: [{ type: 'text', text: request.prompt }, ...images] },
          budget: () => ({ requests: gateway.usage.requests, steps: gateway.stepCount, nativeStepLimit: gateway.nativeStepLimit }),
          check: () => {
            if (finalResponse?.error) throw finalResponse.error;
            if (budgetFailure) throw new RuntimeExecutionError(budgetFailure, `Local runtime budget exhausted: ${budgetFailure}`);
            if (child?.exitCode !== null) throw new Error('OpenCode exited before the admitted turn completed');
          },
          onContinue: (continuations, previousMessageId) => {
            if (finalResponse?.active) assertFinalResponseCheckpoint(request.finalResponseCheckpoint!, diagnosticResult);
            admittedContinuations = continuations;
            emit({ type: 'runtime.output.continued', runId: request.runId, payload: { continuations, previousMessageId, requests: gateway.usage.requests, steps: gateway.stepCount } });
          },
          onReply: async (reply, continuations) => {
            const messages = await client!.session.messages({ sessionID: sessionId }, { signal: AbortSignal.any([turnSignal, AbortSignal.timeout(10000)]) });
            if (!messages.data) throw new Error('OpenCode completion messages unavailable');
            await writeFile(messagesPath, JSON.stringify(messages.data, null, 2), { mode: 0o600 });
            const finishReason = reply.info.role === 'assistant' ? reply.info.finish ?? null : null;
            diagnosticResult = { sessionId, text: reply.parts.filter(part => part.type === 'text').map(part => part.text).join('\n'),
              modelId: model.id, artifactIdentity: model.artifactIdentity, ...(model.inferenceProfile ? { inferenceProfile: model.inferenceProfile } : {}), usage: { ...gateway.usage, durationMs: Date.now() - began },
              messagesPath, diagnosticsPath, completion: runtimeCompletion(finishReason, continuations, gateway.nativeStepLimit, finalResponse?.receipt) };
            await writeFile(diagnosticsPath, JSON.stringify(diagnosticResult, null, 2), { mode: 0o600 });
            emit({ type: 'runtime.completion.checkpoint', runId: request.runId, payload: diagnosticResult });
            if (finalResponse?.active) assertFinalResponseCheckpoint(request.finalResponseCheckpoint!, diagnosticResult);
          },
        });
      } finally { subscriptionController.abort(); await events; }
      turnSignal.throwIfAborted();
      if (result.info.role !== 'assistant') throw new Error('OpenCode returned without an assistant completion');
      if (result.info.error) throw new Error(`OpenCode local turn error: ${JSON.stringify(result.info.error)}`);
      if (!diagnosticResult || !gateway.usage.requests) throw new Error('Runtime returned without local inference');
      if (finalResponse?.active) assertFinalResponseCheckpoint(request.finalResponseCheckpoint!, diagnosticResult);
      return diagnosticResult;
    } catch (error) {
      const code = error instanceof RuntimeExecutionError ? error.code : budgetFailure ?? 'runtime_failed';
      const message = error instanceof Error ? error.message : String(error);
      const databasePath = join(home, 'data/opencode/opencode.db');
      const snapshot = await captureFailureMessages({ client, sessionId: sessionId || undefined, databasePath, messagesPath,
        preferDatabase: turnSignal.aborted }).catch(() => ({ source: 'unavailable' as const, messages: undefined, messagesPath: undefined }));
      const latest = snapshot.messages?.findLast(item => item.info.role === 'assistant');
      const assistant = latest?.info.role === 'assistant' ? latest.info : undefined;
      failureEvidence = { runId: request.runId, ...(sessionId ? { sessionId } : {}), modelId: model.id, artifactIdentity: model.artifactIdentity, ...(model.inferenceProfile ? { inferenceProfile: model.inferenceProfile } : {}),
        usage: { ...gateway.usage, durationMs: Date.now() - began }, diagnosticsPath: join(workerRoot, 'failure.json'),
        messagesPath: snapshot.messagesPath, messagesSource: snapshot.source, databasePath,
        latestAssistant: assistant ? { id: assistant.id, finishReason: assistant.finish ?? null, completed: Boolean(assistant.time.completed), errorName: assistant.error?.name } : undefined,
        continuations: admittedContinuations, code, error: message, capturedAt: new Date().toISOString(),
        ...(gateway.nativeStepLimit ? { nativeStepLimit: { ...gateway.nativeStepLimit } } : {}),
        ...(finalResponse?.receipt ? { finalResponse: { ...finalResponse.receipt } } : {}) };
      if (latest && assistant && snapshot.messagesPath) {
        diagnosticResult = { sessionId, text: latest.parts.filter(part => part.type === 'text').map(part => part.text).join('\n'),
          modelId: model.id, artifactIdentity: model.artifactIdentity, ...(model.inferenceProfile ? { inferenceProfile: model.inferenceProfile } : {}), usage: failureEvidence.usage, messagesPath: snapshot.messagesPath, diagnosticsPath,
          completion: runtimeCompletion(assistant.finish ?? null, admittedContinuations, gateway.nativeStepLimit, finalResponse?.receipt) };
      }
      if (diagnosticResult) {
        diagnosticResult.usage = { ...gateway.usage, durationMs: Date.now() - began };
        await writeFile(diagnosticsPath, JSON.stringify(diagnosticResult, null, 2), { mode: 0o600 });
      }
      await writeFile(failureEvidence.diagnosticsPath, JSON.stringify({ ...failureEvidence, output, result: diagnosticResult }, null, 2), { mode: 0o600 });
      throw new RuntimeExecutionError(code, message, diagnosticResult, { cause: error, evidence: failureEvidence });
    } finally {
      stopWatchdog(); turnSignal.removeEventListener('abort', abort);
      await localTestProxy?.close(); await gateway.close();
      await stopOwned(child).catch(error => { throw new RuntimeExecutionError('runtime_failed', `Owned process absence unconfirmed: ${String(error)}`, diagnosticResult, { cause: error, evidence: failureEvidence }); });
      await writeFile(join(workerRoot, 'process.log'), output, { mode: 0o600 });
    }
  }

  async cancel(runId: string): Promise<void> {
    const active = this.active.get(runId);
    active?.controller.abort(new Error('Employee run cancelled'));
    if (active) await Promise.race([active.done, new Promise<void>((resolve) => setTimeout(resolve, 3000))]);
  }

  async stop(): Promise<void> {
    this.generation++;
    this.stopping = true;
    await Promise.all([...this.active.keys()].map((id) => this.cancel(id)));
    await this.ollama.stop(); this.started = false;
  }

  async recoverRun(runId: string): Promise<Awaited<ReturnType<typeof recoverOwnedReceipt>>> {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(runId)) throw new Error('Invalid run ID');
    return recoverOwnedReceipt(join(this.options.dataRoot, 'runtime', 'employees', runId, 'process.json'), true);
  }

  async recoverTools(): Promise<Awaited<ReturnType<typeof recoverOwnedJobs>>> {
    return recoverOwnedJobs(this.options.dataRoot);
  }
}

export function runtimeCompletion(finishReason: string | null, continuations: number, nativeStepLimit?: NativeStepLimit,
  finalResponse?: RuntimeResult['completion']['finalResponse']): RuntimeResult['completion'] {
  return { finishReason, continuations, outputLimit: 4096, exhausted: finishReason === 'length' || Boolean(nativeStepLimit),
    ...(nativeStepLimit ? { nativeStepLimit: { ...nativeStepLimit } } : {}), ...(finalResponse ? { finalResponse: { ...finalResponse } } : {}) };
}

export function runtimeConfig(model: LocalModel, url: string, secret: string, hasBroker: boolean,
  employee?: Pick<ExecuteRequest, 'system' | 'workspace'>): Config {
  const selected = `opencorp-local/${model.alias}`;
  // Normal upstream compaction drops promptAsync.system on its synthetic user
  // continuation. The per-run agent prompt is reapplied on every employee turn.
  // https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/session/compaction.ts#L489
  // https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/session/llm/request.ts#L52
  const employeePrompt = [
    'You are a persistent OpenCorp employee executing the supplied assignment. Use tools to inspect and perform real work. Delegate through corporate tools only. Report actual results and errors. Never fabricate a completed action.',
    employee?.system,
    employee && `The authoritative native workspace is ${JSON.stringify(resolve(employee.workspace))}. Use this workspace for native file and shell tools; repository origin or localPath fields refer to other checkouts and do not change your workspace. Search with grep or glob before reading large files. Native read uses one-based line offsets: specify a focused limit of about 150 lines and read additional relevant ranges only as needed. Corporate repo_read uses character offsets, as its schema states. After compaction, reuse retained findings and source locations; reread only specific missing or changed sections instead of repeatedly loading unchanged documents in full.`,
  ].filter(Boolean).join('\n\n');
  return {
    model: selected, small_model: selected, enabled_providers: ['opencorp-local'],
    share: 'disabled', autoupdate: false, snapshot: false, plugin: [],
    default_agent: 'employee', subagent_depth: 0, lsp: false, formatter: false,
    provider: { 'opencorp-local': { npm: '@ai-sdk/openai-compatible', name: 'OpenCorp local Ollama',
      // Pinned OpenCode otherwise adds 300s header/SSE timers even though it
      // already disables Bun's native fetch timeout. The run owns cancellation.
      // https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/provider/provider.ts#L1687
      options: { baseURL: `${url}/v1`, apiKey: secret, timeout: false, headerTimeout: false, chunkTimeout: false },
      models: { [model.alias]: { name: model.alias, tool_call: true, attachment: model.capabilities.includes('vision'),
        modalities: { input: model.capabilities.includes('vision') ? ['text', 'image'] : ['text'], output: ['text'] },
        limit: { context: model.contextTokens, input: model.contextTokens, output: 4096 }, cost: { input: 0, output: 0 } } },
    } },
    mcp: hasBroker ? { corporate: { type: 'remote', url: `${url}/mcp`, headers: { authorization: `Bearer ${secret}` }, oauth: false, timeout: 1800000 } } : {},
    // OpenCode 1.18.30 honors reserved only when limit.input is explicit. Its
    // check uses the last completed turn, excluding the newest tool results.
    // Give 32K work an extra 4K tool-result margin; retain the existing 16K
    // threshold because complex company prompts already approach its floor.
    compaction: { auto: true, prune: true, reserved: model.contextTokens === 32768 ? 8192 : 4096, preserve_recent_tokens: 2000, tail_turns: 1 },
    tools: { task: false, question: false, webfetch: false, websearch: false, codesearch: false },
    permission: { '*': 'deny', read: 'allow', edit: 'allow', write: 'allow', bash: 'allow', glob: 'allow', grep: 'allow',
      todowrite: 'allow', 'corporate_*': 'allow', external_directory: 'deny', task: 'deny', question: 'deny' },
    agent: { employee: { mode: 'primary', steps: 32, prompt: employeePrompt },
      general: { disable: true }, explore: { disable: true } },
  };
}
