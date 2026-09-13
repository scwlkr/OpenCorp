import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
const wire = vi.hoisted(() => ({ calls: [] as any[], bodies: [] as string[], status:200, headers:{} as Record<string,string> }));
vi.mock('node:https', () => ({ request: (url: string, options: any, callback: any) => {
  wire.calls.push({ url, options });
  const pending = new EventEmitter() as any;
  pending.end = (body: string) => { wire.bodies.push(body); callback(Object.assign(Readable.from(['data: [DONE]\n\n']), { statusCode: wire.status, headers: wire.headers })); };
  return pending;
} }));
import { OpenRouterFree } from '../src/runtime/openrouter.js';
const id = 'vendor/model:free';
function fixture() {
  let paid = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    if (url.endsWith('/key')) { expect(init.headers.authorization).toBe('Bearer PRIVATE_PARENT_KEY'); return Response.json({ data: { limit: 0, limit_remaining: 0 } }); }
    expect(url.startsWith('https://openrouter.ai/api/v1/models')).toBe(true);
    expect(init.redirect).toBe('error'); expect(init.headers).toBeUndefined();
    return Response.json({ data: url.endsWith('/endpoints') ? { id, endpoints: [{ model_id: id, tag: 'vendor/exact', pricing: { prompt: paid ? '1' : '0', completion: '0', discount: 0 }, supported_parameters: ['tools'], context_length: 32768 }] } : [{ id, name: 'Fixture', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] });
  }));
  const readApiKey = vi.fn(async () => 'PRIVATE_PARENT_KEY');
  return { provider: new OpenRouterFree({ modelIds: [id], noByokVerified: true, readApiKey }), readApiKey, charge: () => { paid = true; } };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); wire.calls.length = 0; wire.bodies.length = 0; wire.status=200;wire.headers={}; });
it.each(['qualified', 'pool'])('rechecks fresh endpoint prices for %s calls, pins zero caps, and forwards only text/function fields', async mode => {
  const f = fixture(), model = mode === 'pool' ? id : (await f.provider.models())[0]!;
  await f.provider.infer(model, { messages: [{ role: 'user', content: 'Synthetic fixture', audio: 'omit', cache_control: { type: 'paid' } }], tools: [{ type: 'function', function: { name: 'fixture_tool', parameters: {}, description: 'Fixture' }, provider: 'paid' }], models: ['paid/model'], plugins: [{ id: 'web' }], provider: { max_price: { prompt: 10 } }, max_tokens: 9999 }, new AbortController().signal);
  expect(fetch).toHaveBeenCalledTimes(mode === 'pool' ? 3 : 5);
  const body = JSON.parse(wire.bodies[0]!);
  expect(body).toMatchObject({ model: id, max_tokens: 4096, provider: { only: ['vendor/exact'], allow_fallbacks: false, require_parameters: true, max_price: { prompt: 0, completion: 0, request: 0, image: 0 } } });
  expect(body.messages).toEqual([{ role: 'user', content: 'Synthetic fixture' }]);
  expect(body).not.toHaveProperty('models'); expect(body).not.toHaveProperty('plugins');
  expect(wire.calls[0].options.headers.authorization).toBe('Bearer PRIVATE_PARENT_KEY');
  expect(JSON.stringify(model) + wire.bodies[0]).not.toContain('PRIVATE_PARENT_KEY');
});
it.each(['qualified', 'pool'])('refuses changed pricing for %s calls before credential access or POST', async mode => {
  const f = fixture(), model = mode === 'pool' ? id : (await f.provider.models())[0]!; f.charge();
  await expect(f.provider.infer(model, { messages: [] }, new AbortController().signal)).rejects.toThrow('changed');
  expect(f.readApiKey).not.toHaveBeenCalled(); expect(wire.calls).toHaveLength(0);
});
it.each([
  { tools: [{ type: 'openrouter:web_search' }] },
  { tool_choice: { type: 'openrouter:web_search' } },
  { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: 'https://example.com/a.png' }] }] },
])('rejects non-client tools and multimodal paid feature vectors', async input => {
  const f = fixture(), model = (await f.provider.models())[0]!;
  await expect(f.provider.infer(model, { messages: [], ...input }, new AbortController().signal)).rejects.toThrow(/text-only|function/);
  expect(f.readApiKey).not.toHaveBeenCalled(); expect(wire.calls).toHaveLength(0);
});
it('requires trusted no-BYOK verification', () => {
  expect(() => new OpenRouterFree({ modelIds: [id], readApiKey: async () => 'unused' } as any)).toThrow('BYOK');
});

it('refuses a positive spending key and never issues inference', async () => {
  const f = fixture(), model = (await f.provider.models())[0]!;
  const original = fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => String(url).endsWith('/key') ? Response.json({ data: { limit: 1, limit_remaining: 1 } }) : original(url, init)));
  await expect(f.provider.infer(model, { messages: [] }, new AbortController().signal)).rejects.toThrow('zero-limit');
  expect(wire.calls).toHaveLength(0);
});
it('redacts credential callback failures', async () => {
  const f = fixture(), model = (await f.provider.models())[0]!;
  f.readApiKey.mockRejectedValue(new Error('PRIVATE_PARENT_KEY'));
  await expect(f.provider.infer(model, { messages: [] }, new AbortController().signal)).rejects.toThrow('credential unavailable');
  expect(wire.calls).toHaveLength(0);
});

 it('persists real 429 across provider instances and blocks same-session retry before any HTTP or key read',async()=>{
  const f=fixture(), model=(await f.provider.models())[0]!;
  let retained:import('../src/core/provider-backoff.js').ProviderBackoff|undefined;
  const options={modelIds:[id],noByokVerified:true as const,readApiKey:f.readApiKey,cooldown:{read:()=>retained,write:(value:typeof retained)=>{retained=value;}}};
  const first=new OpenRouterFree(options);wire.status=429;wire.headers={'retry-after':'600','x-ratelimit-limit':'20','x-ratelimit-remaining':'0','x-ratelimit-reset':'1789230000000','authorization':'DO_NOT_RETAIN'};
  const response=await first.infer(model,{messages:[{role:'user',content:'Fixture'}]},new AbortController().signal);
  expect(response.statusCode).toBe(429);expect(retained).toMatchObject({provider:'openrouter',status:429,basis:'retry-after',failures:1,rateLimitHeaders:{'x-ratelimit-limit':20,'x-ratelimit-remaining':0,'x-ratelimit-reset':1789230000000}});expect(JSON.stringify(retained)).not.toContain('DO_NOT_RETAIN');
  const calls=vi.mocked(fetch).mock.calls.length,keys=f.readApiKey.mock.calls.length;
  for(const provider of [first,new OpenRouterFree(options)])await expect(provider.infer(model,{messages:[]},new AbortController().signal)).rejects.toThrow('cooldown active');
  expect(wire.calls).toHaveLength(1);expect(fetch).toHaveBeenCalledTimes(calls);expect(f.readApiKey).toHaveBeenCalledTimes(keys);
  retained={...retained!,retryAt:new Date(Date.now()-1).toISOString()};wire.status=200;
  await new OpenRouterFree(options).infer(model,{messages:[]},new AbortController().signal);expect(retained).toBeUndefined();
  wire.status=429;wire.headers={};await new OpenRouterFree(options).infer(model,{messages:[]},new AbortController().signal);
  expect(retained).toMatchObject({failures:1,basis:'estimated-backoff'});
  const cancel=new AbortController();cancel.abort(new Error('Owner cancelled'));
  await expect(first.infer(model,{messages:[]},cancel.signal)).rejects.toThrow('Owner cancelled');
 });

it('shares protected pacing across two models and adapter instances, including cancellation and restart', async () => {
 vi.useFakeTimers();const root=mkdtempSync(join(tmpdir(),'openrouter-pacing-')),rateBudgetPath=join(root,'private','openrouter.json'),ids=['vendor/first:free','vendor/second:free'];
 try{
  vi.stubGlobal('fetch',vi.fn(async (url:string)=>{
   if(url.endsWith('/key'))return Response.json({data:{limit:0,limit_remaining:0}});
   const selected=ids.find(value=>url.includes(`${value}/endpoints`));
   return Response.json({data:selected?{id:selected,endpoints:[{model_id:selected,tag:'vendor/exact',pricing:{prompt:'0',completion:'0'},supported_parameters:['tools'],context_length:32768}]}:ids.map(id=>({id,name:id,pricing:{prompt:'0',completion:'0'},supported_parameters:['tools']}))});
  }));
  const options={modelIds:ids,noByokVerified:true as const,rateBudgetPath,readApiKey:vi.fn(async()=>'fixture')},first=new OpenRouterFree(options),second=new OpenRouterFree({...options}),models=await first.models();
  await Promise.all(Array.from({length:18},(_,index)=>(index%2?second:first).infer(models[index%2]!,{messages:[]},new AbortController().signal)));
  expect(wire.calls).toHaveLength(18);expect(new Set(wire.bodies.map(body=>JSON.parse(body).model))).toEqual(new Set(ids));
  const cancelled=new AbortController(),pending=second.infer(models[1]!,{messages:[]},cancelled.signal),rejected=expect(pending).rejects.toThrow('Owner cancelled');
  await vi.advanceTimersByTimeAsync(0);cancelled.abort(new Error('Owner cancelled'));await rejected;
  expect(JSON.parse(readFileSync(rateBudgetPath,'utf8')).entries).toHaveLength(18);
  let done=false;const resumed=new OpenRouterFree({...options}).infer(models[0]!,{messages:[]},new AbortController().signal).then(()=>{done=true;});
  await vi.advanceTimersByTimeAsync(59_999);expect(done).toBe(false);expect(wire.calls).toHaveLength(18);
  await vi.advanceTimersByTimeAsync(1);await resumed;expect(wire.calls).toHaveLength(19);
  expect(readFileSync(rateBudgetPath,'utf8')).not.toMatch(/fixture|vendor|messages|authorization/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
