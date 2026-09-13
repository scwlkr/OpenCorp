import { PoolState } from './state.js';
import { createHash } from 'node:crypto';
import type { PooledModel } from '../types.js';
import { ProviderAvailabilityError } from '../resource-budget.js';
import { OpenRouterCooldownError, OpenRouterModelUnavailableError } from '../openrouter.js';
import { PoolAttemptError, PoolUnavailableError, PoolRequestUnsupportedError, PoolContextOverflowError, type PoolProvider, type PoolRequest, type PoolCompletion } from './types.js';

export function retryAfter(headers: Headers, now: number): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return;
  const at = /^\d+(\.\d+)?$/.test(raw) ? now + Number(raw) * 1000 : Date.parse(raw);
  if (Number.isFinite(at) && at > now && at < 8.64e15) return Math.ceil(at);
}
export function nextDailyReset(now: number, zone: 'utc' | 'pacific'): number {
  if(zone==='utc')return (Math.floor(now/86400000)+1)*86400000;
  // Find the next date boundary in the provider's timezone, including DST changes.
  const format=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'});
  const day=format.format(now);let low=now,high=now+27*3600000;
  while(high-low>1){const mid=Math.floor((low+high)/2);if(format.format(mid)===day)low=mid;else high=mid;}
  return Math.ceil(high/1000)*1000;
}
export function validateRequest(request: PoolRequest): number {
  if (!Array.isArray(request.messages) || !request.messages.length || request.messages.some(m => !m || !['system', 'user', 'assistant', 'tool'].includes(m.role) || m.content != null && typeof m.content !== 'string')) throw new Error('Pool requires text chat messages');
  if (request.tools !== undefined && (!Array.isArray(request.tools) || request.tools.length > 128 || request.tools.some(t => t?.type !== 'function' || typeof t.function?.name !== 'string'))) throw new Error('Pool supports client function tools only');
  if (request.quality !== undefined && ![1,2,3].includes(request.quality)) throw new Error('Invalid task quality');
  if(request.tool_choice!==undefined&&!['auto','none','required'].includes(String(request.tool_choice))){const value=request.tool_choice as any;if(value?.type!=='function'||typeof value.function?.name!=='string'||!request.tools?.some(t=>t.function.name===value.function.name))throw new Error('Invalid client tool choice');}
  const output = request.max_tokens ?? 4096;
  if (!Number.isSafeInteger(output) || output < 1 || output > 16384) throw new Error('Invalid output token limit');
  const bytes = Buffer.byteLength(JSON.stringify({ messages: request.messages, tools: request.tools }));
  if (bytes > 2_000_000) throw new Error('Pool context exceeds request bound');
  return Math.ceil(bytes / 3) + output;
}
export function validateCompletion(completion: PoolCompletion, request: PoolRequest) {
  const choice = completion?.choices?.[0], message = choice?.message;
  if (completion.choices?.length !== 1 || !message || message.role !== 'assistant' || !['stop', 'tool_calls', 'length'].includes(choice.finish_reason)) throw new PoolAttemptError(502);
  if (message.content != null && typeof message.content !== 'string') throw new PoolAttemptError(502);
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length > 128) throw new PoolAttemptError(502);
    const ids = new Set();
    for (const call of message.tool_calls) {
      if (call.type !== 'function' || typeof call.id !== 'string' || !call.id || ids.has(call.id) || !request.tools?.some(t => t.function.name === call.function?.name) || typeof call.function.arguments !== 'string') throw new PoolAttemptError(502);
      try { JSON.parse(call.function.arguments); } catch { throw new PoolAttemptError(502); }
      ids.add(call.id);
    }
  }
  const calls = message.tool_calls?.length ?? 0;
  if (choice.finish_reason === 'tool_calls' && !calls || request.tool_choice === 'required' && !calls || request.tool_choice === 'none' && calls) throw new PoolAttemptError(502);
  const forced = request.tool_choice as any;
  if (forced?.type === 'function' && (!calls || message.tool_calls.some((c: any) => c.function.name !== forced.function?.name))) throw new PoolAttemptError(502);
  if (!calls && !message.content) throw new PoolAttemptError(502);
  if (request.response_format?.type === 'json_object' && !calls) { try { const value = JSON.parse(message.content); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); } catch { throw new PoolAttemptError(502); } }
}

/** One bounded fallback owner. No SDK retries, sleeping loop, or background probes. */
export class FreeInferencePool {
  constructor(readonly state: PoolState, readonly providers: PoolProvider[], private readonly now = Date.now) {
    if (providers.length > 32 || new Set(providers.map(p => p.id)).size !== providers.length) throw new Error('Invalid provider pool');
    for(const p of providers)if(!Number.isInteger(p.concurrency)||p.concurrency<1||p.concurrency>4||new Set(p.limits.map(l=>l.scope)).size!==p.limits.length||p.limits.some(l=>!Number.isSafeInteger(l.periodMs)||l.periodMs<0))throw new Error('Invalid pool capacity');
  }
  model(): PooledModel {
    return { id: 'free-pool', name: 'Free inference pool', alias: 'free-pool', sourceAlias: 'free-pool', provider: 'pool', local: false, freeOnly: true,
      available: this.providers.length > 0, contextTokens: 32768, capabilities: ['tools'], size: 0, sizeClass: 'remote', endpoint: 'opencorp:free-pool',
      artifactIdentity: createHash('sha256').update(JSON.stringify(this.providers.map(p => ({ id: p.id, revision: p.revision, models: p.models })))).digest('hex') };
  }
  status() {
    const now = this.now();
    return this.providers.map(provider => ({ id: provider.id, renewable: provider.renewable, evaluationOnly: !!provider.evaluationOnly,
      models: provider.models.map(m => ({ ...m, ...this.state.availability(provider, m.id, 1, now) })),
      health: this.state.health(provider.scope, provider.revision), quotaBasis: 'conservative local reservations; other clients may also consume quota' }));
  }
  private eligible(request: PoolRequest, tokens: number) {
    const quality = request.quality ?? (request.tools?.length ? 2 : 1);
    return this.providers.flatMap(provider => provider.models.map(model => ({ provider, model }))).filter(({ provider, model }) =>
      model.quality >= quality && model.context >= tokens && provider.limits.every(limit => limit.tokens === undefined || tokens <= limit.tokens) && (!request.tools?.length || model.tools)
      && (!request.response_format || model.json) && (!model.autoToolsOnly || request.tool_choice === undefined || request.tool_choice === 'auto')
      && (!provider.evaluationOnly || request.purpose === 'evaluation') && (!provider.publicOnly || request.dataClass === 'public') && request.dataClass !== 'confidential');
  }
  availability(request: PoolRequest): PoolUnavailableError | undefined {
    const tokens = validateRequest(request), now = this.now();
    const earliest = Math.min(...this.eligible(request, tokens).map(({provider,model}) => this.state.availability(provider, model.id, tokens, now).retryAt));
    if (earliest > now) return new PoolUnavailableError(earliest < Number.MAX_SAFE_INTEGER ? earliest : now + 60_000);
  }
  async generate(request: PoolRequest, signal = new AbortController().signal): Promise<PoolCompletion> {
    const tokens = validateRequest(request), quality = request.quality ?? (request.tools?.length ? 2 : 1);
    const attempted = new Set<string>();
    const eligible = this.eligible(request, tokens);
    if (this.providers.length && !eligible.length) {
      // Classify only: never dispatch a request stripped of employee history.
      // Compaction cannot remove system instructions, tools or the output budget.
      const floor = { ...request, messages: [...request.messages.filter(message => message.role === 'system'), { role: 'user', content: '' }] };
      if (this.eligible(floor, validateRequest(floor)).length) throw new PoolContextOverflowError();
      throw new PoolRequestUnsupportedError();
    }
    // A whole request has a deadline; each attempt is bounded independently.
    const deadline = this.now() + 120_000;
    for (let attempt = 0; attempt < 4; attempt++) {
      signal.throwIfAborted();
      const now = this.now();
      if (now >= deadline) break;
      const candidates = eligible.filter(({provider,model}) => !attempted.has(`${provider.id}/${model.id}`))
        .map(candidate => ({ ...candidate, availability: this.state.availability(candidate.provider, candidate.model.id, tokens, now) }));
      const ready = candidates.filter(c => c.availability.retryAt <= now).sort((a,b) =>
        (a.model.quality - quality) - (b.model.quality - quality) || Number(b.provider.renewable) - Number(a.provider.renewable)
        || b.availability.remainingFraction - a.availability.remainingFraction || a.provider.id.localeCompare(b.provider.id));
      const candidate = ready[0];
      if (!candidate) break;
      const { provider, model } = candidate;
      attempted.add(`${provider.id}/${model.id}`);
      const lease = this.state.reserve(provider, model.id, tokens, now, deadline + 1000);
      if (!lease) { attempt--; continue; }
      try {
        const combined = AbortSignal.any([signal, AbortSignal.timeout(Math.min(45_000, Math.max(1, deadline - now)))]);
        if (!await provider.available()) throw new PoolAttemptError(401);
        combined.throwIfAborted();
        const result = await provider.complete(model, request, combined);
        combined.throwIfAborted();
        validateCompletion(result.completion, request);
        this.state.success(provider.scope, provider.revision, this.now());
        // Groq documents request resets as RPD, token resets as TPM (duration strings).
        if(provider.id==='groq')for(const kind of ['requests','tokens'])if(result.headers.get(`x-ratelimit-remaining-${kind}`)==='0'){
          const raw=result.headers.get(`x-ratelimit-reset-${kind}`)??'',match=/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(raw);
          const duration=match?(Number(match[1]??0)*3600+Number(match[2]??0)*60+Number(match[3]??0))*1000:0;
          if(duration>0&&duration<=86400000)this.state.hold(provider.scope,provider.revision,this.now()+Math.ceil(duration),'provider-header-reset');
        }
        // Actual serving identity is retained in the response; callers select only free-pool.
        return { ...result.completion, model: `${provider.id}/${model.id}` };
      } catch (error) {
        signal.throwIfAborted();
        const existingHold=error instanceof ProviderAvailabilityError||error instanceof OpenRouterCooldownError?Date.parse(error.retryAt):undefined;
        const status = error instanceof PoolAttemptError ? error.status : error instanceof OpenRouterModelUnavailableError ? 404 : existingHold ? 429 : 503;
        const scoped = [400,404,422,502].includes(status) || provider.id==='gemini'&&error instanceof ProviderAvailabilityError&&error.provider==='gemini'&&error.modelId===model.id ? `${provider.scope}/${model.id}` : provider.scope;
        const failures = this.state.health(scoped, provider.revision).failures;
        const after = error instanceof PoolAttemptError ? retryAfter(error.headers, this.now()) : existingHold;
        const permanent = status === 401 || status === 403 || status === 402 && !provider.renewable;
        const quotaReset=error instanceof PoolAttemptError&&error.quota&&provider.dailyReset?nextDailyReset(this.now(),provider.dailyReset):undefined;
        const until = permanent ? Number.MAX_SAFE_INTEGER : Math.max(after??0,quotaReset??0) || this.now() + Math.min(3_600_000, (status === 402 ? 3_600_000 : status === 429 ? 60_000 : 15_000) * 2 ** Math.min(8, failures)) + Math.floor(Math.random() * 1000);
        this.state.hold(scoped, provider.revision, until, permanent ? 'configuration-required' : after ? 'retry-after' : `estimated-backoff-http-${status}`);
      } finally { this.state.release(lease); }
    }
    // Later attempts can extend an account hold or consume its remaining quota.
    // Report current availability, never the minimum of stale observations.
    const now = this.now();
    const earliest = Math.min(...eligible.map(({provider,model}) => this.state.availability(provider, model.id, tokens, now).retryAt));
    throw new PoolUnavailableError(earliest < Number.MAX_SAFE_INTEGER ? Math.max(now, earliest) : now + 60_000);
  }
}
