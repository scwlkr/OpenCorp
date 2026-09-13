import { RunInspection } from './inspection.js';
import { FreeInferencePool } from './free-pool/pool.js';
import {testProvider} from './provider-test.js';
import type {ProviderId,ProviderStatus,ProviderTestResult} from '../core/provider-status.js';
import { observeControl } from './control-observation.js';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { createOpencodeClient, type Config, type FilePartInput } from '@opencode-ai/sdk/v2';
import { completeSession } from './session.js';
import { assertFinalResponseCheckpoint, FinalResponseRequest } from './final-response.js';
import { captureFailureMessages, untouchedCapacityRefusal } from './evidence.js';
import { OwnedLoopbackProxy } from './loopback.js';
import { DirectFree, directFreeCooldown } from './direct-free.js';
import { directFreeProvider, productiveSharingAllowed } from '../core/inference-policy.js';
import { OpenRouterFree } from './openrouter.js';
import { microInstallSelection, OwnedOllama, availablePort, selectLocalModel } from './ollama.js';
import { ResourceBudget, ResourceAdmissionError, ProviderAvailabilityError } from './resource-budget.js';
import { RunGateway } from './gateway.js';
import { minimalEnvironment, prepareHome, spawnOwned, stopOwned, recoverOwnedReceipt, recoverOwnedJobs } from './processes.js';
import { openCodeCommand, wrapWorker } from './sandbox.js';
import { MODEL_ALIASES, CONTEXT_TOKENS, RuntimeExecutionError, type RuntimeFailureEvidence, type RuntimeFailureCode, type ExecuteRequest, type RuntimeModel, type RuntimeEvent, type RuntimeOptions, type RuntimeResult, type NativeStepLimit } from './types.js';
export * from './types.js';
export { executeSandboxed } from './tool-process.js';
export { wrapWorker, opencodeBinary, dependenciesRoot } from './sandbox.js';

interface ActiveRun { controller: AbortController; done: Promise<void> }

export function toolFailureGuard(controller: AbortController) {
  const seen = new Set<string>();
  let prior: { tool: string; input: unknown; error: string; count: number } | undefined;
  return (part: { id: string; tool: string; state: { status: string; input?: unknown; error?: string } }) => {
    if (!['completed', 'error'].includes(part.state.status) || seen.has(part.id)) return;
    seen.add(part.id);
    if (part.state.status === 'completed') { prior = undefined; return; }
    const error = part.state.error ?? '';
    const count = prior?.tool === part.tool && prior.error === error && isDeepStrictEqual(prior.input, part.state.input) ? prior.count + 1 : 1;
    prior = { tool: part.tool, input: part.state.input, error, count };
    if (count >= 3) controller.abort(new Error('Employee repeated the same tool failure three times without progress; inspect retained tool evidence before retrying'));
  };
}

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
  private readonly microOllama: OwnedOllama;
  private resources: ResourceBudget;
  private active = new Map<string, ActiveRun>();
  private stopping = false;
  private started = false;
  private cachedModels: RuntimeModel[] = [];
  private generation = 0;
  private testingProvider?:ProviderId;
  private providerShutdown=false;
  private testController?:AbortController;
  private testDone?:Promise<void>;
  private readonly activeProviders=new Map<string,ProviderId|'pool'>();
  private admissionTail: Promise<unknown> = Promise.resolve();
  private readonly productiveBindings = new Map<string, RuntimeModel>();
  private readonly admittedPools = new Map<string, { pool: OwnedOllama; identity: string }>();

  constructor(private readonly options: RuntimeOptions) {
    this.ollama = new OwnedOllama(options);
    this.microOllama = new OwnedOllama(options, 'micro');
    this.resources = new ResourceBudget(options.resourceBudget);
  }

  /** Change qualified limits only after all runs and both owned providers have stopped. */
  async configureResources(options: RuntimeOptions['resourceBudget']): Promise<void> {
    const resources = new ResourceBudget(options);
    await this.stop();
    this.options.resourceBudget = { ...resources.limits };
    this.resources = resources;
    this.stopping = false;
  }

  get freePool() { return this.options.freePool; }

  async start(): Promise<void> {
    const generation = ++this.generation;
    this.stopping = false;
    await this.ollama.start();
    if (generation !== this.generation || this.stopping) throw new Error('Runtime startup superseded by stop');
    this.started = true;
  }

  private assertLifecycle(generation: number): void {
    if (this.stopping || generation !== this.generation) throw new Error('Runtime model operation superseded by stop');
  }

  async installMicroModels(ids?:unknown): Promise<RuntimeModel[]> {
    const selected=microInstallSelection(ids);
    const starting = this.start(), generation = this.generation;
    await starting; this.assertLifecycle(generation);
    await this.microOllama.start(); this.assertLifecycle(generation);
    await this.microOllama.ensureMicroModels(selected); this.assertLifecycle(generation);
    return this.models();
  }

  async installModels(): Promise<RuntimeModel[]> {
    const starting = this.start(), generation = this.generation;
    await starting; this.assertLifecycle(generation);
    await this.ollama.ensureSmallModel(); this.assertLifecycle(generation);
    return this.models();
  }

  async models(): Promise<RuntimeModel[]> {
    if (this.stopping) return this.cachedModels;
    const generation = this.generation;
    await this.ollama.start(); this.assertLifecycle(generation);
    const primary = await this.ollama.models(); this.assertLifecycle(generation);
    const micro = await this.microOllama.models(); this.assertLifecycle(generation);
    const remote = this.options.openRouterFree?.modelIds.length ? await new OpenRouterFree(this.options.openRouterFree).models() : [];
    this.assertLifecycle(generation);
    const direct = [];
    for(const provider of ['groq','gemini','zai'] as const){const options=this.options.directFree?.[provider];if(options?.modelIds.length){try{direct.push(...await new DirectFree(provider,options).models());}catch{this.assertLifecycle(generation);this.options.onEvent?.({type:'runtime.models.unavailable',payload:{provider,reason:'Direct free inventory unavailable; retained local models remain usable'}});}}}
    this.assertLifecycle(generation);
    this.cachedModels = [...primary, ...micro, ...remote, ...direct, ...(this.options.freePool ? [this.options.freePool.model()] : [])];
    return this.cachedModels;
  }

  status(): { started: boolean; activeRuns: string[]; ollama: ReturnType<OwnedOllama['status']>; microOllama: ReturnType<OwnedOllama['status']>; inferenceSlots: number; contextTokens: number; resources: ReturnType<ResourceBudget['status']> } {
    return { started: this.started, activeRuns: [...this.active.keys()], ollama: this.ollama.status(), microOllama: this.microOllama.status(), inferenceSlots: this.resources.limits.maxConcurrentTurns, contextTokens: CONTEXT_TOKENS, resources: this.resources.status() };
  }

  configureOpenRouterFreeModels(ids: string[]): void {
    if (this.active.size) throw new Error('Stop active turns before changing supplemental inference configuration');
    if (!this.options.openRouterFree) { if (ids.length) throw new Error('OpenRouter secure parent credential configuration is unavailable'); return; }
    this.options.openRouterFree = { ...this.options.openRouterFree, modelIds: [...ids] };
  }

  configureDirectFreeModels(ids:string[]):void {
    if(this.active.size)throw new Error('Stop active turns before changing direct free configuration');
    if(ids.some(id=>!directFreeProvider(id)))throw new Error('Invalid direct free model IDs');
    for(const id of ids)if(!this.options.directFree?.[directFreeProvider(id)!])throw new Error('Direct free protected credential configuration is unavailable');
    for(const provider of ['groq','gemini','zai'] as const){const options=this.options.directFree?.[provider];if(options)options.modelIds=ids.filter(id=>directFreeProvider(id)===provider);}
  }

  private reserveMixedProductive(request:ExecuteRequest,model:RuntimeModel):void {
    const limits=this.resources.limits;
    if(!limits.productiveRemoteModelId&&!limits.productiveRemoteProfiles||request.workload==='social')return;
    if(this.productiveBindings.size&&!productiveSharingAllowed(model,[...this.productiveBindings.values()],limits))throw new ResourceAdmissionError('Qualified mixed productive slot already occupied or binding mismatched');
    this.productiveBindings.set(request.runId,model);
  }
  private async reserveRemote(request:ExecuteRequest,model:RuntimeModel,signal:AbortSignal):Promise<void>{
    const admission=this.admissionTail.then(()=>{signal.throwIfAborted();this.reserveMixedProductive(request,model);});
    this.admissionTail=admission.catch(()=>{});await admission;
  }

  async providerAvailability(modelId:string,context?:Pick<ExecuteRequest,'system'|'prompt'|'provisionOnly'|'corporateOnly'>):Promise<ProviderAvailabilityError|undefined>{
    if(modelId==='free-pool'){
      const unavailable=this.options.freePool?.availability({messages:[{role:'system',content:context?.system??''},{role:'user',content:context?.prompt??''}],tools:[{type:'function',function:{name:'startup'}}],max_tokens:context?(context.provisionOnly&&context.corporateOnly?1024:4096):1,quality:2,dataClass:'internal',purpose:'work'});
      if(!this.options.freePool||unavailable)return new ProviderAvailabilityError('free-pool',new Date(unavailable?.retryAt??Date.now()+60_000).toISOString(),'Free pool capacity unavailable; retain queued work until current quota or cooldown permits admission');
      return;
    }
    const provider=directFreeProvider(modelId),options=provider?this.options.directFree?.[provider]:undefined;
    if(!provider)return;
    if(!options)return new ProviderAvailabilityError(provider,new Date(Date.now()+60_000).toISOString(),'Direct free provider credentials/configuration unavailable; recheck in one minute');
    return new DirectFree(provider,options).availability(modelId);
  }
  providerCooldown(modelId:string):{provider:string;retryAt:string}|undefined {
    const provider=directFreeProvider(modelId),options=provider?this.options.directFree?.[provider]:undefined;
    const retryAt=options?directFreeCooldown(options):undefined;return provider&&retryAt?{provider,retryAt}:undefined;
  }
  async providerStatus():Promise<ProviderStatus[]> {
    const rows:ProviderStatus[]=[];
    for(const id of ['local','openrouter','groq','gemini','zai'] as const){
      const direct=id==='groq'||id==='gemini'||id==='zai'?this.options.directFree?.[id]:undefined;
      const row:ProviderStatus={id,configured:id==='local'||!!(id==='openrouter'?this.options.openRouterFree:direct),health:'unknown',reason:'No recent successful test',modelIds:id==='local'?this.cachedModels.filter(m=>m.local).map(m=>m.id):id==='openrouter'?[...(this.options.openRouterFree?.modelIds??[])]:[],activeRuns:[...this.activeProviders.values()].filter(p=>p===id).length,audit:{status:id==='openrouter'?'free-pricing-required':'unknown'},quota:{status:'unknown'},testing:this.testingProvider===id};
      if(direct){try{const {audit}=await direct.readCredentials();row.modelIds=[...audit.modelIds];row.audit={status:'owner-attested',verifiedAt:audit.verifiedAt,expiresAt:audit.expiresAt};if(Date.parse(audit.expiresAt)<=Date.now()){row.health='red';row.reason='Owner free-tier audit expired';}}catch{row.health='red';row.reason='Protected free-tier credentials or audit unavailable';}}
      if(direct&&row.modelIds.length){const unavailable=await new DirectFree(id as 'groq'|'gemini'|'zai',direct).availability(row.modelIds[0]!);if(unavailable){row.health='red';row.reason=unavailable.message;row.cooldown={retryAt:unavailable.retryAt,basis:unavailable.message};}}
      const retryAt=direct?directFreeCooldown(direct):undefined;if(retryAt){row.cooldown={retryAt,basis:'Estimated five-minute provider hold after HTTP 429'};row.health='red';row.reason='Actual HTTP 429; retry cooldown active';}
      if(id==='local')row.reason=row.modelIds.length?'Local inventory available; no synthetic test performed':'Local inventory has not been loaded';if(!row.configured)row.reason='Not configured';rows.push(row);
    }return rows;
  }
  async testProvider(provider:ProviderId,modelId:string):Promise<ProviderTestResult>{
    if(this.providerShutdown||provider==='local'||this.testingProvider||[...this.activeProviders.values()].includes(provider))throw new ResourceAdmissionError('Provider is busy or not available for remote diagnostics');
    this.testingProvider=provider;this.testController=new AbortController();let finishTest!:()=>void;this.testDone=new Promise<void>(resolve=>{finishTest=resolve;});
    const signal=AbortSignal.any([AbortSignal.timeout(45000),this.testController.signal]),startedAt=new Date().toISOString();
    try{
      let transport:OpenRouterFree|DirectFree;
      if(provider==='openrouter'){if(!this.options.openRouterFree?.modelIds.includes(modelId))throw new Error('Model not configured');transport=new OpenRouterFree(this.options.openRouterFree);}
      else {const config=this.options.directFree?.[provider];if(!config)throw new Error('Provider not configured');const {audit}=await config.readCredentials();if(!audit.modelIds.includes(modelId))throw new Error('Model not audited');transport=new DirectFree(provider,config,[modelId]);}
      const model=(await transport.models(signal)).find(m=>m.id===modelId);if(!model)throw new Error('Model unavailable');
      return await testProvider(provider,modelId,(body,abort)=>transport.infer(model as never,body,abort),signal);
    }catch{return {provider,modelId,status:'failed',startedAt,finishedAt:new Date().toISOString(),responsePassed:false,toolPassed:false,requests:0,latencyMs:Date.now()-Date.parse(startedAt),httpStatuses:[],errorCode:signal.aborted?'test_timeout':'eligibility_unavailable'};}finally{this.testingProvider=undefined;this.testController=undefined;finishTest();this.testDone=undefined;}
  }

  async execute(request: ExecuteRequest): Promise<RuntimeResult> {
    if (this.stopping) throw new Error('Runtime stopping; new dispatch refused');
    const dispatchProvider:ProviderId|'pool'=request.modelId==='free-pool'?'pool':directFreeProvider(request.modelId)??(request.modelId.endsWith(':free')?'openrouter':'local');
    if(this.testingProvider===dispatchProvider)throw new ResourceAdmissionError('Provider diagnostic in progress');
    if (this.active.has(request.runId)) throw new Error('Duplicate active runtime run ID');
    if (this.active.size >= this.resources.limits.maxConcurrentTurns) throw new ResourceAdmissionError('Local resource slots occupied; retain assignment in the durable queue');
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(request.runId)) throw new Error('Invalid run ID');
    if (request.contextTokens && ![16384, 32768, 49152].includes(request.contextTokens)) throw new Error('Local context must be 16K, 32K or the explicit Qwen 48K profile');
    const qwen48 = ['qwen-main-48k', 'Qwen (48K context)', 'qwen-low-reasoning-48k', 'Qwen (48K low reasoning)'].includes(request.modelId);
    if ((request.contextTokens === 49152 && !qwen48) || (qwen48 && (request.workload === 'social' || (request.contextTokens && request.contextTokens !== 49152)))) throw new Error('48K context requires explicit productive Qwen 48K selection');
    request.signal?.throwIfAborted();
    const controller = new AbortController();
    const signal = request.signal ? AbortSignal.any([controller.signal, request.signal]) : controller.signal;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    this.activeProviders.set(request.runId,dispatchProvider);
    this.active.set(request.runId, { controller, done });
    let releaseResources: (() => void) | undefined;
    try {
      if(request.modelId==='free-pool'){
        if(!request.freeInferencePool||!this.options.freePool||request.workload==='social'||request.imagePaths?.length)throw new Error('Free pool is not authorized for this run');
        const unavailable=await this.providerAvailability(request.modelId,request);if(unavailable)throw unavailable;
        const model=this.options.freePool.model();
        await this.reserveRemote(request,model,signal);
        return await this.run({...request,contextTokens:32768},model,signal,this.options.freePool);
      }
      const direct=directFreeProvider(request.modelId);
      if(direct){
        const options=this.options.directFree?.[direct];
        if(request.workload==='social'||request.imagePaths?.length||!request.directFreeModels?.includes(request.modelId)||!options?.modelIds.includes(request.modelId))throw new Error('Direct free inference is not authorized for this run');
        const unavailable=await this.providerAvailability(request.modelId);if(unavailable)throw unavailable;
        const provider=new DirectFree(direct,options,[request.modelId]),model=(await provider.models(signal)).find(item=>item.id===request.modelId);
        if(!model)throw new Error('Direct free model unavailable');
        await this.reserveRemote(request,model,signal);
        return await this.run({...request,contextTokens:32768},model,signal,provider);
      }
      if (request.modelId.endsWith(':free')) {
        if (request.workload === 'social' || request.imagePaths?.length || !request.openRouterFreeModels?.includes(request.modelId) || !this.options.openRouterFree?.modelIds.includes(request.modelId)) throw new Error('Supplemental OpenRouter inference is not authorized for this run');
        const provider = new OpenRouterFree(this.options.openRouterFree);
        const model = (await provider.models(signal)).find(item => item.id === request.modelId);
        if (!model) throw new Error('Requested OpenRouter model has no verified free endpoint');
        await this.reserveRemote(request,model,signal);
        return await this.run({ ...request, contextTokens: 32768 }, model, signal, provider);
      }
      const micro = Object.entries(MODEL_ALIASES).some(([id, alias]) => id.startsWith('micro-') && (request.modelId === id || request.modelId === alias || request.modelId === `opencorp-${id}-${request.contextTokens ?? CONTEXT_TOKENS}:latest`));
      const ollama = micro ? this.microOllama : this.ollama;
      await ollama.start();
      signal.throwIfAborted();
      this.started = true;
      const models = await ollama.models(qwen48 ? 49152 : request.contextTokens ?? CONTEXT_TOKENS);
      const model = selectLocalModel(models, request.modelId);
      if (!model) throw new Error(`Model is outside the installed local pool: ${request.modelId}`);
      try {
        const admission = this.admissionTail.then(async () => {
          signal.throwIfAborted();
          this.reserveMixedProductive(request,model);
          const samePool = [...this.admittedPools.values()].filter(entry => entry.pool === ollama);
          if (samePool.some(entry => entry.identity !== model.artifactIdentity)) throw new ResourceAdmissionError('Owned model pool is occupied by another active profile');
          const residentBytes = await ollama.prepareResidency(model, !samePool.length, signal);
          signal.throwIfAborted();
          releaseResources = this.resources.admit(request.runId, model, request.workload, residentBytes, ollama === this.microOllama ? 'micro' : 'primary');
          this.admittedPools.set(request.runId, { pool: ollama, identity: model.artifactIdentity });
        });
        this.admissionTail = admission.catch(() => {});
        await admission;
      }
      catch (error) {
        const event: RuntimeEvent = { type: 'runtime.resource.refused', runId: request.runId, payload: { modelId: model.id, workload: request.workload ?? 'productive',
          reason: error instanceof Error ? error.message : String(error), resources: this.resources.status() } };
        this.options.onEvent?.(event); request.onEvent?.(event); throw error;
      }
      if (request.imagePaths?.length && !model.capabilities.includes('vision')) throw new Error('Selected local artifact does not support image input');
      signal.throwIfAborted();
      return await this.run(request, model, signal, ollama);
    } finally { releaseResources?.(); this.productiveBindings.delete(request.runId); this.activeProviders.delete(request.runId); this.admittedPools.delete(request.runId); this.active.delete(request.runId); finish(); }
  }

  private async run(request: ExecuteRequest, model: RuntimeModel, signal: AbortSignal, ollama: OwnedOllama | OpenRouterFree | DirectFree | FreeInferencePool): Promise<RuntimeResult> {
    const began = Date.now();
    const workerRoot = join(this.options.dataRoot, 'runtime', 'employees', request.runId);
    const home = join(workerRoot, 'home');
    await prepareHome(home);
    await mkdir(request.workspace, { recursive: true });
    const inspection = new RunInspection(this.options.dataRoot, request.runId, [request.token ?? '']);
    inspection.record('run.context', { employeeId: request.employeeId, model, system: request.system, prompt: request.prompt, contextTokens: request.contextTokens, instructionRevision: request.instructionRevision, workload: request.workload });
    const timeout = new AbortController();
    const observeToolFailure = toolFailureGuard(timeout);
    let latestProgress = Date.now();
    let budgetFailure: RuntimeFailureCode | undefined;
    const activeTools = new Set<string>();
    let observedTool = false;
    const emit = (event: RuntimeEvent): void => {
      latestProgress = Date.now();
      if (event.type === 'runtime.budget.exhausted') budgetFailure = (event.payload as { code: RuntimeFailureCode }).code;
      if (event.type === 'runtime.tool') {
        observedTool = true;
        const part = event.payload as { id: string; state: { status: string } };
        if (part.state.status === 'pending' || part.state.status === 'running') activeTools.add(part.id);
        else activeTools.delete(part.id);
      }
      // Do not flood durable company state with individual token chunks.
      if (event.type === 'runtime.inference.progress') return;
      inspection.record(event.type, event.payload);
      this.options.onEvent?.(event); request.onEvent?.(event);
      if (event.type === 'runtime.tool') observeToolFailure(event.payload as Parameters<typeof observeToolFailure>[0]);
    };
    const gateway = new RunGateway(ollama, model, request, emit, payload => inspection.record('runtime.inference.context', payload));
    await gateway.start();
    const serverPort = await availablePort();
    const localTestProxy = request.toolEnvironment ? new OwnedLoopbackProxy([serverPort, gateway.port]) : undefined;
    const password = randomBytes(32).toString('hex');
    const turnSignal = AbortSignal.any([signal, timeout.signal]);
    const stopWatchdog = startRunWatchdog(timeout, () => ({ latestProgress, activeTools: activeTools.size, inferenceActive: gateway.inferenceActive }), request.timeoutMs);
    const config = runtimeConfig(model, gateway.url, gateway.secret, Boolean(request.brokerUrl), request);
    inspection.record('runtime.configuration', { agent: config.agent, tools: config.tools, permission: config.permission, compaction: config.compaction, model: config.model, modelConfiguration: config.provider?.['opencorp-local']?.models, resources: this.resources.status() });
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
              if (part.type === 'text' && part.sessionID === sessionId) inspection.record('runtime.message.text', { messageId: part.messageID, text: part.text, attribution: 'Message role not established by this part event' });
              if (part.type === 'tool' && part.sessionID === sessionId) emit({ type: 'runtime.tool', runId: request.runId, payload: part });
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
        result = await completeSession({ client, signal: turnSignal, finalResponse, outputLimit:request.provisionOnly&&request.corporateOnly?1024:4096,
          sessionError,
          surplusCompaction: { path: join(workerRoot, 'surplus-compaction.json'),
            onReceipt: receipt => emit({ type: 'runtime.compaction.cancelled', runId: request.runId, payload: receipt }) },
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
            const messages = await observeControl('completion.session.messages', turnSignal, () => {
              if (child?.exitCode !== null) throw new Error('OpenCode exited before completion evidence was retained');
              if (budgetFailure) throw new RuntimeExecutionError(budgetFailure, `Local runtime budget exhausted: ${budgetFailure}`);
              if (finalResponse?.error) throw finalResponse.error;
              if (finalResponse?.active) assertFinalResponseCheckpoint(request.finalResponseCheckpoint!, diagnosticResult);
            }, control => client!.session.messages({ sessionID: sessionId }, { signal: control }), true);
            if (!messages.data) throw new Error('OpenCode completion messages unavailable');
            await writeFile(messagesPath, JSON.stringify(messages.data, null, 2), { mode: 0o600 });
            const finishReason = reply.info.role === 'assistant' ? reply.info.finish ?? null : null;
            diagnosticResult = { sessionId, text: reply.parts.filter(part => part.type === 'text').map(part => part.text).join('\n'),
              modelId: model.id, artifactIdentity: model.artifactIdentity, ...(model.inferenceProfile ? { inferenceProfile: model.inferenceProfile } : {}), usage: { ...gateway.usage, durationMs: Date.now() - began },
              messagesPath, diagnosticsPath, completion: runtimeCompletion(finishReason, continuations, gateway.nativeStepLimit, finalResponse?.receipt, request.provisionOnly&&request.corporateOnly?1024:4096) };
            await writeFile(diagnosticsPath, JSON.stringify(diagnosticResult, null, 2), { mode: 0o600 });
            inspection.record('employee.explanation', { text: diagnosticResult.text, source: 'completed assistant reply' });
            emit({ type: 'runtime.completion.checkpoint', runId: request.runId, payload: diagnosticResult });
            if (finalResponse?.active) assertFinalResponseCheckpoint(request.finalResponseCheckpoint!, diagnosticResult);
          },
        });
      } finally { subscriptionController.abort(); await events; }
      turnSignal.throwIfAborted();
      if (result.info.role !== 'assistant') throw new Error('OpenCode returned without an assistant completion');
      if (result.info.error) throw new Error(`OpenCode local turn error: ${JSON.stringify(result.info.error)}`, { cause: result.info.error });
      if (!diagnosticResult || !gateway.usage.requests) throw new Error('Runtime returned without local inference');
      if (finalResponse?.active) assertFinalResponseCheckpoint(request.finalResponseCheckpoint!, diagnosticResult);
      return diagnosticResult;
    } catch (error) {
      let code: RuntimeFailureCode = error instanceof RuntimeExecutionError ? error.code : budgetFailure ?? 'runtime_failed';
      const message = error instanceof Error ? error.message : String(error);
      const databasePath = join(home, 'data/opencode/opencode.db');
      const snapshot = await captureFailureMessages({ client, sessionId: sessionId || undefined, databasePath, messagesPath,
        preferDatabase: turnSignal.aborted }).catch(() => ({ source: 'unavailable' as const, messages: undefined, messagesPath: undefined }));
      const providerWait = code === 'runtime_failed' && !turnSignal.aborted && !observedTool && gateway.usage.requests === 1
        && gateway.firstRequestCapacityWait && untouchedCapacityRefusal(error, snapshot.messages) ? gateway.firstRequestCapacityWait : undefined;
      if (providerWait) code = 'provider_capacity_wait';
      const latest = snapshot.messages?.findLast(item => item.info.role === 'assistant');
      const assistant = latest?.info.role === 'assistant' ? latest.info : undefined;
      failureEvidence = { runId: request.runId, ...(sessionId ? { sessionId } : {}), modelId: model.id, artifactIdentity: model.artifactIdentity, ...(model.inferenceProfile ? { inferenceProfile: model.inferenceProfile } : {}),
        usage: { ...gateway.usage, durationMs: Date.now() - began }, diagnosticsPath: join(workerRoot, 'failure.json'),
        messagesPath: snapshot.messagesPath, messagesSource: snapshot.source, databasePath,
        latestAssistant: assistant ? { id: assistant.id, finishReason: assistant.finish ?? null, completed: Boolean(assistant.time.completed), errorName: assistant.error?.name } : undefined,
        ...(providerWait ? { providerWait } : {}),
        continuations: admittedContinuations, code, error: message, capturedAt: new Date().toISOString(),
        ...(gateway.nativeStepLimit ? { nativeStepLimit: { ...gateway.nativeStepLimit } } : {}),
        ...(finalResponse?.receipt ? { finalResponse: { ...finalResponse.receipt } } : {}) };
      if (latest && assistant && snapshot.messagesPath) {
        diagnosticResult = { sessionId, text: latest.parts.filter(part => part.type === 'text').map(part => part.text).join('\n'),
          modelId: model.id, artifactIdentity: model.artifactIdentity, ...(model.inferenceProfile ? { inferenceProfile: model.inferenceProfile } : {}), usage: failureEvidence.usage, messagesPath: snapshot.messagesPath, diagnosticsPath,
          completion: runtimeCompletion(assistant.finish ?? null, admittedContinuations, gateway.nativeStepLimit, finalResponse?.receipt, request.provisionOnly&&request.corporateOnly?1024:4096) };
      }
      if (diagnosticResult) {
        diagnosticResult.usage = { ...gateway.usage, durationMs: Date.now() - began };
        await writeFile(diagnosticsPath, JSON.stringify(diagnosticResult, null, 2), { mode: 0o600 });
      }
      await writeFile(failureEvidence.diagnosticsPath, JSON.stringify({ ...failureEvidence, output, result: diagnosticResult }, null, 2), { mode: 0o600 });
      inspection.record('runtime.failure', failureEvidence);
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
    this.stopping = true;this.providerShutdown=true;
    this.testController?.abort();await this.testDone;
    await Promise.all([...this.active.keys()].map((id) => this.cancel(id)));
    const stopped = await Promise.allSettled([this.ollama.stop(), this.microOllama.stop()]); this.started = false;
    const failed = stopped.find(result => result.status === 'rejected');
    this.providerShutdown=false;
    if (failed?.status === 'rejected') throw failed.reason;
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
  finalResponse?: RuntimeResult['completion']['finalResponse'], outputLimit:1024|4096=4096): RuntimeResult['completion'] {
  return { finishReason, continuations, outputLimit, exhausted: finishReason === 'length' || Boolean(nativeStepLimit),
    ...(nativeStepLimit ? { nativeStepLimit: { ...nativeStepLimit } } : {}), ...(finalResponse ? { finalResponse: { ...finalResponse } } : {}) };
}

export function runtimeConfig(model: RuntimeModel, url: string, secret: string, hasBroker: boolean,
  employee?: Pick<ExecuteRequest, 'system' | 'workspace' | 'workload' | 'corporateOnly' | 'provisionOnly'>): Config {
  const selected = `opencorp-local/${model.alias}`;
  // Normal upstream compaction drops promptAsync.system on its synthetic user
  // continuation. The per-run agent prompt is reapplied on every employee turn.
  // https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/session/compaction.ts#L489
  // https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/session/llm/request.ts#L52
  const employeePrompt = [
    employee?.workload==='social'?'You are a persistent AI employee participating in a bounded internal chat. Reply directly without tools or work artifacts.':
    'You are a persistent OpenCorp employee executing the supplied assignment. Use tools to inspect and perform real work. Delegate through corporate tools only. Report actual results and errors. Never fabricate a completed action.',
    employee?.system,
    employee?.corporateOnly && 'This task uses corporate tools only. Read retained company records and imported sources through corporate tools; repository evidence uses corporate repository tools. Native file, shell and todo tools are unavailable for this task. After native compaction, call company_help to refresh the current assignment guide and retained progress. An exact-hash source inspection recorded complete in this same run remains complete after compaction. Reuse retained findings; use skill_read only for specific missing or changed source content. Complete only the missing actual assigned action, then report its retained result.',
    employee && employee.workload!=='social' && !employee.corporateOnly && `The authoritative native workspace is ${JSON.stringify(resolve(employee.workspace))}. Use this workspace for native file and shell tools; repository origin or localPath fields refer to other checkouts and do not change your workspace. Search with grep or glob before reading large files. Native read uses one-based line offsets: specify a focused limit of about 150 lines and read additional relevant ranges only as needed. Corporate repo_read uses character offsets, as its schema states. After compaction, reuse retained findings and source locations; reread only specific missing or changed sections instead of repeatedly loading unchanged documents in full.`,
  ].filter(Boolean).join('\n\n');
  return {
    model: selected, small_model: selected, enabled_providers: ['opencorp-local'],
    share: 'disabled', autoupdate: false, snapshot: false, plugin: [],
    default_agent: 'employee', subagent_depth: 0, lsp: false, formatter: false,
    provider: { 'opencorp-local': { npm: '@ai-sdk/openai-compatible', name: model.local ? 'OpenCorp local Ollama' : `OpenCorp ${model.provider} free`,
      // Pinned OpenCode otherwise adds 300s header/SSE timers even though it
      // already disables Bun's native fetch timeout. The run owns cancellation.
      // https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/provider/provider.ts#L1687
      options: { baseURL: `${url}/v1`, apiKey: secret, timeout: false, headerTimeout: false, chunkTimeout: false },
      models: { [model.alias]: { name: model.alias, tool_call: employee?.workload!=='social' && model.capabilities.includes('tools'), attachment: model.capabilities.includes('vision'),
        modalities: { input: model.capabilities.includes('vision') ? ['text', 'image'] : ['text'], output: ['text'] },
        limit: { context: model.contextTokens, input: model.contextTokens, output: employee?.provisionOnly&&employee.corporateOnly?1024:4096 }, cost: { input: 0, output: 0 } } },
    } },
    mcp: hasBroker ? { corporate: { type: 'remote', url: `${url}/mcp`, headers: { authorization: `Bearer ${secret}` }, oauth: false, timeout: 1800000 } } : {},
    // OpenCode 1.18.30 honors reserved only when limit.input is explicit. Its
    // check uses the last completed turn, excluding the newest tool results.
    // Give 32K work an extra 4K tool-result margin; retain the existing 16K
    // threshold because complex company prompts already approach its floor.
    compaction: { auto: true, prune: true, reserved: model.contextTokens >= 32768 ? 8192 : 4096, preserve_recent_tokens: 2000, tail_turns: 1 },
    tools: { ...(employee?.workload==='social'||employee?.corporateOnly?{read:false,edit:false,write:false,bash:false,glob:false,grep:false,todoread:false,todowrite:false,skill:false}:{}), task: false, question: false, webfetch: false, websearch: false, codesearch: false },
    permission: employee?.workload==='social'?{'*':'deny'}:employee?.corporateOnly?{'*':'deny','corporate_*':'allow'}:{ '*': 'deny', read: 'allow', edit: 'allow', write: 'allow', bash: 'allow', glob: 'allow', grep: 'allow',
      todowrite: 'allow', 'corporate_*': 'allow', external_directory: 'deny', task: 'deny', question: 'deny' },
    agent: { employee: { mode: 'primary', steps: 32, prompt: employeePrompt },
      general: { disable: true }, explore: { disable: true } },
  };
}
