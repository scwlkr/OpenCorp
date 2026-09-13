import { providerRateBudget } from './provider-rate-budget.js';
import { nextProviderBackoff, type ProviderBackoff } from '../core/provider-backoff.js';
import { createHash } from 'node:crypto';
import { request } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { OpenRouterFreeModel, RuntimeOptions } from './types.js';

export const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
export const isExactFreeModelId = (id: string): boolean => /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*:free$/.test(id);

/** Reject unknown/nonzero prices, rather than assuming that a free suffix is sufficient. */
export function zeroPricing(value: unknown): value is Record<string, string | number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prices = value as Record<string, unknown>;
  return ['prompt', 'completion'].every(key => Object.hasOwn(prices, key))
    && Object.values(prices).every(price => (typeof price === 'string' && /^0(?:\.0+)?$/.test(price)) || price === 0);
}

export class OpenRouterModelUnavailableError extends Error {}

export class OpenRouterCooldownError extends Error { constructor(readonly retryAt:string){super('OpenRouter retry cooldown active; quota reset time is unknown');} }

export class OpenRouterFree {
  private lastBackoff?:ProviderBackoff;
  private assertReady(signal:AbortSignal){signal.throwIfAborted();const value=(this.options.cooldown?this.options.cooldown.read():this.lastBackoff);if(value&&Date.parse(value.retryAt)>Date.now())throw new OpenRouterCooldownError(value.retryAt);}

  constructor(private readonly options: NonNullable<RuntimeOptions['openRouterFree']>) {
    if (options.noByokVerified !== true) throw new Error('OpenRouter requires verified absence of workspace BYOK');
    if (!options.modelIds.length || !options.modelIds.every(isExactFreeModelId)) throw new Error('OpenRouter requires explicitly selected exact :free model IDs');
  }
  private async json(path: string, signal?: AbortSignal): Promise<any> {
    try {
      const response = await fetch(`https://openrouter.ai/api/v1/${path}`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000), redirect: 'error' });
      if (!response.ok) throw new Error();
      return await response.json();
    } catch { throw new Error('OpenRouter free-model metadata unavailable; inference refused'); }
  }
  async models(signal?: AbortSignal): Promise<OpenRouterFreeModel[]> {
    const catalog = await this.json('models', signal);
    const result: OpenRouterFreeModel[] = [];
    for (const id of this.options.modelIds) {
      const item = catalog.data?.find((model: any) => model.id === id);
      if (!item || !zeroPricing(item.pricing) || !item.supported_parameters?.includes('tools')) continue;
      const detail = await this.json(`models/${id}/endpoints`, signal);
      const endpoints = detail.data?.id === id && Array.isArray(detail.data.endpoints) ? detail.data.endpoints.filter((entry: any) => entry.model_id === id && zeroPricing(entry.pricing) && typeof entry.tag === 'string' && entry.supported_parameters?.includes('tools') && entry.context_length >= 32768) : [];
      if (!endpoints.length) continue;
      const providers: string[] = [...new Set<string>(endpoints.map((entry: any) => entry.tag))].sort();
      const contextTokens = 32768;
      const identity = { provider: 'openrouter', id, contextTokens, pricing: item.pricing, providers, freeOnly: true };
      result.push({ ...identity, provider: 'openrouter', freeOnly: true, id, name: `${item.name ?? id} [OpenRouter free]`, alias: id, sourceAlias: id, endpoint: OPENROUTER_ENDPOINT, local: false, available: true, size: 0, sizeClass: 'remote', capabilities: ['tools'], pricingVerifiedAt: new Date().toISOString(), artifactIdentity: createHash('sha256').update(JSON.stringify(identity)).digest('hex') });
    }
    return result;
  }
  async infer(model: OpenRouterFreeModel | string, input: Record<string, unknown>, signal: AbortSignal, onDispatch?: (body: Record<string, unknown>) => void): Promise<IncomingMessage> {
    this.assertReady(signal);
    const priorBackoff=(this.options.cooldown?this.options.cooldown.read():this.lastBackoff);
    // The dynamic pool supplies an allowed ID; qualified direct runs also pin identity.
    const id = typeof model === 'string' ? model : model.id;
    if (!this.options.modelIds.includes(id) || !isExactFreeModelId(id)) throw new Error('OpenRouter unassigned model refused');
    const current = (await this.models(signal)).find(item => item.id === id);
    if (!current) throw new OpenRouterModelUnavailableError('OpenRouter free pricing or endpoint identity changed; inference refused');
    if (typeof model !== 'string' && current.artifactIdentity !== model.artifactIdentity) throw new Error('OpenRouter free pricing or endpoint identity changed; inference refused');
    // Only ordinary text chat/tool parameters survive. No routing, plugins,
    // paid server tools, BYOK, cache controls or provider keys from the worker.
    const body: Record<string, unknown> = {};
    for (const key of ['messages', 'tools', 'tool_choice', 'temperature', 'stop']) if (input[key] !== undefined) body[key] = input[key];
    if (!Array.isArray(body.messages) || body.messages.some((message: any) => typeof message.content !== 'string' && message.content !== null && message.content !== undefined)) throw new Error('OpenRouter supplemental inference supports text-only messages');
    body.messages = (body.messages as any[]).map(message => Object.fromEntries(['role', 'content', 'tool_calls', 'tool_call_id', 'name'].filter(field => message[field] !== undefined).map(field => [field, message[field]])));
    if (body.tools !== undefined) {
      if (!Array.isArray(body.tools) || body.tools.some((tool: any) => tool.type !== 'function' || !tool.function)) throw new Error('OpenRouter permits client function tools only');
      body.tools = body.tools.map((tool: any) => ({ type: 'function', function: Object.fromEntries(['name', 'description', 'parameters', 'strict'].filter(field => tool.function[field] !== undefined).map(field => [field, tool.function[field]])) }));
    }
    if (body.tool_choice !== undefined && !['auto', 'none', 'required'].includes(String(body.tool_choice)) && !(typeof body.tool_choice === 'object' && body.tool_choice !== null && (body.tool_choice as any).type === 'function' && typeof (body.tool_choice as any).function?.name === 'string')) throw new Error('OpenRouter permits client function tool choices only');
    if (typeof body.tool_choice === 'object' && body.tool_choice !== null) body.tool_choice = { type: 'function', function: { name: (body.tool_choice as any).function.name } };
    body.model = id; body.stream = true; body.max_tokens = Math.min(Number(input.max_tokens) || 4096, 4096);
    body.provider = { only: current.providers, allow_fallbacks: false, require_parameters: true, max_price: { prompt: 0, completion: 0, request: 0, image: 0 } };
    // Shared across models, native runs and dashboard tests. Reservations contain no request content.
    await providerRateBudget('openrouter',this.options).reserve(1,signal);
    this.assertReady(signal);
    let key: string;
    try { key = await this.options.readApiKey(); } catch { throw new Error('OpenRouter credential unavailable'); }
    if (!key || /[\r\n]/.test(key)) throw new Error('OpenRouter credential unavailable');
    try {
      const response = await fetch('https://openrouter.ai/api/v1/key', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), redirect: 'error' });
      const account = response.ok ? await response.json() as any : undefined;
      if (account?.data?.limit !== 0 || account.data.limit_remaining !== 0) throw new Error();
    } catch { throw new Error('OpenRouter dedicated zero-limit credential verification failed'); }
    this.assertReady(signal);
    onDispatch?.(body);
    return new Promise((resolve, reject) => {
      const pending = request(OPENROUTER_ENDPOINT, { method: 'POST', signal, agent: false, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' } }, response=>{
        if(response.statusCode===429){
          const value=nextProviderBackoff(id,response.headers['retry-after'],(this.options.cooldown?this.options.cooldown.read():this.lastBackoff),Date.now(),response.headers);
          this.lastBackoff=value;
          try{this.options.cooldown?.write(value);}catch{response.destroy();reject(new Error('OpenRouter cooldown persistence failed'));return;}
        }
        if(response.statusCode!==undefined&&response.statusCode>=200&&response.statusCode<300&&priorBackoff
          &&JSON.stringify((this.options.cooldown?this.options.cooldown.read():this.lastBackoff))===JSON.stringify(priorBackoff)){
          this.lastBackoff=undefined;
          try{this.options.cooldown?.write(undefined);}catch{response.destroy();reject(new Error('OpenRouter cooldown persistence failed'));return;}
        }
        resolve(response);
      });
      pending.on('error', () => reject(new Error('OpenRouter inference transport failed')));
      pending.end(JSON.stringify(body));
    });
  }
}
