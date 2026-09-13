import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { providerRateBudget } from '../src/runtime/provider-rate-budget.js';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
const wire=vi.hoisted(()=>({calls:[] as any[],status:200}));
vi.mock('node:https',()=>({request:(url:string,options:any,callback:any)=>{const p=new EventEmitter() as any;p.end=(raw:string)=>{wire.calls.push({url,options,body:JSON.parse(raw)});callback(Object.assign(Readable.from([]),{statusCode:wire.status,headers:{}}));};return p;}}));
import { DirectFree } from '../src/runtime/direct-free.js';
import type { DirectFreeOptions, DirectFreeProviderName } from '../src/runtime/types.js';
import { permittedDirectFreeModel } from '../src/core/inference-policy.js';
function fixture(provider:DirectFreeProviderName='groq'){
 const id=`${provider}:fixture-model`,apiKey='PRIVATE_TEST_KEY';
 const audit={provider,accountId:'synthetic-account',billingEnabled:false as const,credentialSha256:createHash('sha256').update(apiKey).digest('hex'),modelIds:[id],verifiedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60_000).toISOString(),evidence:'Owner inspected unbilled synthetic account'};
 const options:DirectFreeOptions={modelIds:[id],readCredentials:vi.fn(async()=>({apiKey,audit}))};
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json(provider==='groq'?{data:[{id:'fixture-model',active:true,context_window:32768}]}:{name:'models/fixture-model',supportedGenerationMethods:['generateContent'],inputTokenLimit:32768})));
 return {id,audit,options,provider:new DirectFree(provider,options)};
}
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();wire.calls=[];wire.status=200;});
it.each(['groq','gemini'] as const)('pins %s endpoint, fresh key-bound audit and text/function-only capped transport',async name=>{
 const f=fixture(name),model=(await f.provider.models())[0]!;
 await f.provider.infer(model,{messages:[{role:'user',content:'Synthetic',images:['discard']}],tools:[{type:'function',function:{name:'sum',parameters:{},description:'Synthetic'}}],max_tokens:256,plugins:['paid'],model:'paid',provider:{fallback:true}},new AbortController().signal);
 expect(wire.calls[0].url).toBe(model.endpoint);expect(wire.calls[0].body).toEqual({messages:[{role:'user',content:'Synthetic'}],tools:[{type:'function',function:{name:'sum',parameters:{},description:'Synthetic'}}],model:'fixture-model',stream:true,max_tokens:256});
 expect(wire.calls[0].options.headers.authorization).toBe('Bearer PRIVATE_TEST_KEY');expect(JSON.stringify(model)).not.toContain('PRIVATE_TEST_KEY');expect(f.options.readCredentials).toHaveBeenCalledTimes(name==='gemini'?4:3);
 expect(permittedDirectFreeModel({directFreeModels:[f.id]} as any,model)).toBe(true);expect(permittedDirectFreeModel({} as any,model)).toBe(false);expect(permittedDirectFreeModel({directFreeModels:[f.id]} as any,{...model,endpoint:'https://paid.example'})).toBe(false);
});
it.each(['billing','expired','future','key','provider','model'] as const)('rejects %s audit changes before inference POST',async bad=>{
 const f=fixture(),model=(await f.provider.models())[0]!;
 if(bad==='billing')(f.audit as any).billingEnabled=true;
 if(bad==='expired')f.audit.expiresAt=new Date(Date.now()-1).toISOString();
 if(bad==='future')f.audit.verifiedAt=new Date(Date.now()+10000).toISOString();
 if(bad==='key')f.audit.credentialSha256='0'.repeat(64);
 if(bad==='provider')f.audit.provider='gemini';
 if(bad==='model')f.audit.modelIds=[];
 await expect(f.provider.infer(model,{messages:[]},new AbortController().signal)).rejects.toThrow('fresh key-bound');expect(wire.calls).toHaveLength(0);
});
it('blocks retry storms across provider instances sharing configuration after a real429',async()=>{
 const f=fixture(),model=(await f.provider.models())[0]!;wire.status=429;
 expect((await f.provider.infer(model,{messages:[]},new AbortController().signal)).statusCode).toBe(429);
 const reads=vi.mocked(fetch).mock.calls.length;
 await expect(new DirectFree('groq',f.options).infer(model,{messages:[]},new AbortController().signal)).rejects.toThrow('cooldown');expect(wire.calls).toHaveLength(1);expect(fetch).toHaveBeenCalledTimes(reads);
});
it.each([9999,0,-1,NaN])('caps malformed or excessive output budget %s',async max_tokens=>{const f=fixture(),model=(await f.provider.models())[0]!;await f.provider.infer(model,{messages:[],max_tokens},new AbortController().signal);expect(wire.calls[0].body.max_tokens).toBe(4096);});
it('refuses provider built-in tools, changed metadata and cancellation without POST',async()=>{
 const f=fixture(),model=(await f.provider.models())[0]!;
 await expect(f.provider.infer(model,{messages:[],tools:[{type:'web_search'}]},new AbortController().signal)).rejects.toThrow('client function');
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({data:[{id:'fixture-model',active:true,context_window:65536}]})));
 await expect(f.provider.infer(model,{messages:[]},new AbortController().signal)).rejects.toThrow('identity changed');
 const controller=new AbortController();controller.abort(new Error('Stopped'));await expect(f.provider.infer(model,{messages:[]},controller.signal)).rejects.toThrow('Stopped');expect(wire.calls).toHaveLength(0);
});

it('optional unavailable direct inventory preserves local model discovery',async()=>{
 const {LocalRuntime}=await import('../src/runtime/index.js'),{OwnedOllama}=await import('../src/runtime/ollama.js');
 const start=vi.spyOn(OwnedOllama.prototype,'start').mockResolvedValue();
 const inventory=vi.spyOn(OwnedOllama.prototype,'models').mockResolvedValue([{id:'local-fixture',local:true}] as any);
 const f=fixture();f.audit.expiresAt=new Date(Date.now()-1).toISOString();const onEvent=vi.fn();
 try{const runtime=new LocalRuntime({dataRoot:'/unused-direct-fixture',directFree:{groq:f.options},onEvent});expect(await runtime.models()).toEqual([{id:'local-fixture',local:true},{id:'local-fixture',local:true}]);expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({type:'runtime.models.unavailable'}));expect(wire.calls).toHaveLength(0);}finally{start.mockRestore();inventory.mockRestore();}
});
it('does not interpret missing context metadata as sufficient capacity',async()=>{const f=fixture();vi.stubGlobal('fetch',vi.fn(async()=>Response.json({data:[{id:'fixture-model',active:true}]})));await expect(f.provider.models()).rejects.toThrow('context');expect(wire.calls).toHaveLength(0);});
it('runtime requires both exact policy and configured IDs and forbids social before any inference',async()=>{
 const {LocalRuntime}=await import('../src/runtime/index.js'),f=fixture();
 const runtime=new LocalRuntime({dataRoot:'/unused-direct-fixture',directFree:{groq:f.options}});
 const base={runId:'synthetic-run',employeeId:'synthetic-employee',workspace:'/unused',modelId:f.id,system:'Synthetic',prompt:'Synthetic'};
 for(const patch of [{directFreeModels:[]},{directFreeModels:[f.id],workload:'social'},{directFreeModels:['groq:other']}])await expect(runtime.execute({...base,...patch} as any)).rejects.toThrow('not authorized');
 expect(wire.calls).toHaveLength(0);expect(fetch).not.toHaveBeenCalled();expect(runtime.status().activeRuns).toEqual([]);
 expect(()=>runtime.configureDirectFreeModels(['gemini:missing'])).toThrow('configuration');expect(f.options.modelIds).toEqual([f.id]);
});

it('rejects an oversized Groq request without metadata, credentials or inference traffic',async()=>{
 const f=fixture(),model=(await f.provider.models())[0]!;vi.mocked(fetch).mockClear();vi.mocked(f.options.readCredentials).mockClear();
 await expect(f.provider.infer(model,{messages:[{role:'user',content:'x'.repeat(68_000)}],max_tokens:4096},new AbortController().signal)).rejects.toThrow('Estimated request tokens exceed');
 expect(wire.calls).toHaveLength(0);expect(fetch).not.toHaveBeenCalled();expect(f.options.readCredentials).not.toHaveBeenCalled();
});
it('paces shared adapters and revalidates expired authorization after waiting before POST',async()=>{
 vi.useFakeTimers();try{
  const f=fixture(),model=(await f.provider.models())[0]!;await f.provider.infer(model,{messages:[],max_tokens:4096},new AbortController().signal);
  const pending=new DirectFree('groq',f.options).infer(model,{messages:[],max_tokens:4096},new AbortController().signal);const rejected=expect(pending).rejects.toThrow('fresh key-bound');
  await vi.advanceTimersByTimeAsync(59_999);expect(wire.calls).toHaveLength(1);await vi.advanceTimersByTimeAsync(1);await rejected;expect(wire.calls).toHaveLength(1);
 }finally{vi.useRealTimers();}
});
it('shares cooldown after metadata429 without repeated availability traffic',async()=>{
 const f=fixture();vi.stubGlobal('fetch',vi.fn(async()=>new Response('',{status:429})));await expect(f.provider.models()).rejects.toMatchObject({name:'ProviderCooldownError',provider:'groq'});await expect(new DirectFree('groq',f.options).models()).rejects.toThrow('cooldown');expect(fetch).toHaveBeenCalledTimes(1);expect(wire.calls).toHaveLength(0);const {LocalRuntime}=await import('../src/runtime/index.js');const runtime=new LocalRuntime({dataRoot:'/tmp/unused-cooldown-status',directFree:{groq:f.options}});const row=(await runtime.providerStatus()).find(r=>r.id==='groq')!;expect(row.health).toBe('red');expect(row.cooldown?.retryAt).toBe(runtime.providerCooldown(f.id)?.retryAt);expect(runtime.providerCooldown('qwen-main')).toBeUndefined();expect(row.reason).toContain('cooldown');
});
it('timestamps outbound reservations after slow metadata verification',async()=>{
 vi.useFakeTimers();const {mkdtempSync,readFileSync,rmSync}=await import('node:fs'),{join}=await import('node:path'),{tmpdir}=await import('node:os');const root=mkdtempSync(join(tmpdir(),'direct-reservation-'));
 try{const f=fixture(),model=(await f.provider.models())[0]!;f.options.rateBudgetPath=join(root,'budget.json');const began=Date.now();vi.stubGlobal('fetch',vi.fn(async()=>{await new Promise(resolve=>setTimeout(resolve,15_000));return Response.json({data:[{id:'fixture-model',active:true,context_window:32768}]});}));const pending=f.provider.infer(model,{messages:[],max_tokens:256},new AbortController().signal);await vi.advanceTimersByTimeAsync(15_000);await pending;expect(JSON.parse(readFileSync(f.options.rateBudgetPath,'utf8')).entries[0].at).toBe(began+15_000);expect(wire.calls).toHaveLength(1);
 }finally{vi.useRealTimers();rmSync(root,{recursive:true,force:true});}
});

it('holds expired or unavailable free audit without network and accepts only actually renewed evidence',async()=>{
 const f=fixture(),{LocalRuntime}=await import('../src/runtime/index.js'),runtime=new LocalRuntime({dataRoot:'/tmp/unused-provider-availability',directFree:{groq:f.options}});f.audit.expiresAt=new Date(Date.now()-1).toISOString();
 const blocked=await runtime.providerAvailability(f.id);expect(blocked).toMatchObject({name:'ProviderAvailabilityError',provider:'groq'});expect(blocked?.message).toContain('no automatic renewal');expect(Date.parse(blocked!.retryAt)).toBeGreaterThan(Date.now());expect(fetch).not.toHaveBeenCalled();expect(wire.calls).toHaveLength(0);expect((await runtime.providerStatus()).find(r=>r.id==='groq')?.health).toBe('red');
 f.audit.expiresAt=new Date(Date.now()+60_000).toISOString();expect(await runtime.providerAvailability(f.id)).toBeUndefined();expect(await runtime.providerAvailability('qwen-main')).toBeUndefined();expect(fetch).not.toHaveBeenCalled();
});

import {ProviderAvailabilityError} from '../src/runtime/resource-budget.js';
it.each([408,500,503])('defers transient metadata HTTP%s without inference or raw response retention',async status=>{
 const f=fixture();vi.stubGlobal('fetch',vi.fn(async()=>new Response('PRIVATE_BODY',{status})));
 const failure=await f.provider.models().catch(error=>error);expect(failure).toBeInstanceOf(ProviderAvailabilityError);expect(failure.message).toContain(`metadata request HTTP ${status}`);expect(failure.message).not.toContain('PRIVATE_BODY');expect(Date.parse(failure.retryAt)).toBeGreaterThan(Date.now());expect(wire.calls).toHaveLength(0);expect(fetch).toHaveBeenCalledOnce();
});
it.each([400,401,403,404])('does not reclassify metadata HTTP%s authentication/model rejection as transient',async status=>{
 const f=fixture();vi.stubGlobal('fetch',vi.fn(async()=>new Response('PRIVATE_BODY',{status})));const failure=await f.provider.models().catch(error=>error);expect(failure).toBeInstanceOf(Error);expect(failure).not.toBeInstanceOf(ProviderAvailabilityError);expect(failure.message).toContain(`metadata request HTTP ${status}`);expect(failure.message).not.toContain('PRIVATE_BODY');expect(wire.calls).toHaveLength(0);
});
it('retains malformed metadata as failed verification rather than an availability retry',async()=>{
 const f=fixture();vi.stubGlobal('fetch',vi.fn(async()=>new Response('PRIVATE_INVALID_JSON')));const failure=await f.provider.models().catch(error=>error);expect(failure).not.toBeInstanceOf(ProviderAvailabilityError);expect(failure.message).toBe('Direct free metadata response invalid; model availability not verified');expect(wire.calls).toHaveLength(0);
});
it('classifies transport failure safely before native worker dispatch',async()=>{
 const f=fixture(),{LocalRuntime}=await import('../src/runtime/index.js');vi.stubGlobal('fetch',vi.fn(async()=>{throw new TypeError('PRIVATE_NETWORK_DETAIL');}));
 const runtime=new LocalRuntime({dataRoot:'/unused-metadata-test',directFree:{groq:f.options}}),run=vi.spyOn(runtime as any,'run');
 const failure=await runtime.execute({runId:'unstarted',employeeId:'employee',modelId:f.id,directFreeModels:[f.id],workspace:'/unused',system:'',prompt:''}).catch(error=>error);
 expect(failure).toBeInstanceOf(ProviderAvailabilityError);expect(failure.message).toContain('metadata request transport');expect(failure.message).not.toContain('PRIVATE_NETWORK_DETAIL');expect(run).not.toHaveBeenCalled();expect(runtime.status().activeRuns).toHaveLength(0);expect(wire.calls).toHaveLength(0);run.mockRestore();
});
it.each(['timeout','caller'] as const)('distinguishes owned metadata timeout from %s cancellation',async kind=>{
 const f=fixture(),timer=new AbortController(),caller=new AbortController(),reason=new Error('CALLER_CANCELLATION'),timeout=vi.spyOn(AbortSignal,'timeout').mockReturnValue(timer.signal);
 vi.stubGlobal('fetch',vi.fn(async(_url:any,init:any)=>new Promise<Response>((_resolve,reject)=>{init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});})));
 try{const pending=f.provider.models(caller.signal).catch(error=>error);await vi.waitFor(()=>expect(fetch).toHaveBeenCalledOnce());if(kind==='caller')caller.abort(reason);else timer.abort(new DOMException('owned timeout','TimeoutError'));const failure=await pending;
 if(kind==='caller')expect(failure).toBe(reason);else{expect(failure).toBeInstanceOf(ProviderAvailabilityError);expect(failure.message).toContain('metadata request timeout');}expect(wire.calls).toHaveLength(0);
 }finally{timeout.mockRestore();}
});

it('isolates Gemini model reservations, shares project limits across keys, and persists ambiguous429 account holds',async()=>{
 const root=mkdtempSync(join(tmpdir(),'gemini-scopes-'));try{
  const f=fixture('gemini'),second='gemini:second-model';f.options.rateBudgetPath=join(root,'private','gemini.json');f.options.modelIds.push(second);f.audit.modelIds.push(second);
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>Response.json({name:`models/${decodeURIComponent(url.split('/').at(-1)!)}`,supportedGenerationMethods:['generateContent'],inputTokenLimit:32768})));
  const models=await f.provider.models(),scope=(id:string)=>createHash('sha256').update(JSON.stringify(['gemini',f.audit.accountId,id])).digest('hex');
  const budget=providerRateBudget('gemini',f.options);await budget.reserve(200000,new AbortController().signal,scope(f.id));
  await f.provider.infer(models[1]!,{messages:[],max_tokens:1},new AbortController().signal);expect(wire.calls).toHaveLength(1);
  const rotated='ROTATED_KEY',otherOptions={...f.options,readCredentials:async()=>({apiKey:rotated,audit:{...f.audit,credentialSha256:createHash('sha256').update(rotated).digest('hex')}})},other=new DirectFree('gemini',otherOptions),cancel=new AbortController();
  const blocked=other.infer(models[0]!,{messages:[],max_tokens:1},cancel.signal);const rejected=expect(blocked).rejects.toThrow();await new Promise(resolve=>setImmediate(resolve));expect(wire.calls).toHaveLength(1);cancel.abort();await rejected;expect(wire.calls).toHaveLength(1);
  wire.status=429;await other.infer(models[1]!,{messages:[],max_tokens:1},new AbortController().signal);
  for(const id of [f.id,second])expect(await new DirectFree('gemini',{...f.options}).availability(id)).toMatchObject({name:'ProviderCooldownError'});
  const different=new DirectFree('gemini',{...f.options,readCredentials:async()=>({apiKey:rotated,audit:{...f.audit,accountId:'different-project',credentialSha256:createHash('sha256').update(rotated).digest('hex')}})});expect(await different.availability(second)).toBeUndefined();
  expect(readFileSync(f.options.rateBudgetPath,'utf8')).not.toMatch(/PRIVATE_TEST_KEY|ROTATED_KEY|synthetic-account|different-project/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
it('fails closed if verified Gemini account changes while waiting for its reservation',async()=>{
 vi.useFakeTimers();const f=fixture('gemini');f.audit.expiresAt=new Date(Date.now()+3600000).toISOString();const model=(await f.provider.models())[0]!,scope=createHash('sha256').update(JSON.stringify(['gemini',f.audit.accountId,f.id])).digest('hex');
 await providerRateBudget('gemini',f.options).reserve(200000,new AbortController().signal,scope);
 const pending=f.provider.infer(model,{messages:[],max_tokens:1},new AbortController().signal),rejected=expect(pending).rejects.toThrow('account changed');await vi.advanceTimersByTimeAsync(0);f.audit.accountId='changed-project';await vi.advanceTimersByTimeAsync(60000);await rejected;expect(wire.calls).toHaveLength(0);
});

it('keeps a healthy Gemini sibling in inventory when another exact model has exhausted local daily reservations',async()=>{
 const root=mkdtempSync(join(tmpdir(),'gemini-daily-'));try{
  const f=fixture('gemini'),second='gemini:other-model';f.options.rateBudgetPath=join(root,'private','gemini.json');f.options.modelIds.push(second);f.audit.modelIds.push(second);
  const scope=createHash('sha256').update(JSON.stringify(['gemini',f.audit.accountId,f.id])).digest('hex'),budget=providerRateBudget('gemini',f.options);await budget.reserve(1,new AbortController().signal,scope);
  writeFileSync(f.options.rateBudgetPath,JSON.stringify({version:1,entries:Array.from({length:500},()=>({at:Date.now()-120000,tokens:1,scope})),headers:[]}));
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>Response.json({name:`models/${decodeURIComponent(url.split('/').at(-1)!)}`,supportedGenerationMethods:['generateContent'],inputTokenLimit:32768})));
  expect((await f.provider.models()).map(m=>m.id)).toEqual([second]);expect(fetch).toHaveBeenCalledTimes(1);expect(await f.provider.availability(f.id)).toMatchObject({name:'ProviderAvailabilityError'});expect(await f.provider.availability(second)).toBeUndefined();
  const ledger=JSON.parse(readFileSync(f.options.rateBudgetPath,'utf8'));ledger.entries.pop();writeFileSync(f.options.rateBudgetPath,JSON.stringify(ledger));const last=(await f.provider.models()).find(m=>m.id===f.id)!;await f.provider.infer(last,{messages:[],max_tokens:1},new AbortController().signal);expect(wire.calls).toHaveLength(1);expect(await f.provider.availability(f.id)).toMatchObject({name:'ProviderAvailabilityError'});
 }finally{rmSync(root,{recursive:true,force:true});}
});

it.each(['inventory','reservation'])('retains exact-model availability when another worker exhausts Gemini during %s',async phase=>{
 const root=mkdtempSync(join(tmpdir(),'gemini-race-'));try{
  const f=fixture('gemini'),model=(await f.provider.models())[0]!;f.options.rateBudgetPath=join(root,'private','gemini.json');f.options.modelIds.push('gemini:sibling');f.audit.modelIds.push('gemini:sibling');
  const scope=createHash('sha256').update(JSON.stringify(['gemini',f.audit.accountId,f.id])).digest('hex');await providerRateBudget('gemini',f.options).reserve(1,new AbortController().signal,scope);
  const exhaust=()=>writeFileSync(f.options.rateBudgetPath!,JSON.stringify({version:1,entries:Array.from({length:500},()=>({at:Date.now()-120000,tokens:1,scope})),headers:[]}));
  if(phase==='inventory')vi.spyOn(f.provider,'models').mockImplementationOnce(async()=>{exhaust();return [{...model,id:'gemini:sibling'}];});
  else{vi.spyOn(f.provider,'models').mockResolvedValue([model]);const budget=providerRateBudget('gemini',f.options),reserve=budget.reserve.bind(budget);vi.spyOn(budget,'reserve').mockImplementationOnce(async(...args)=>{exhaust();return reserve(...args);});}
  await expect(f.provider.infer(model,{messages:[],max_tokens:1},new AbortController().signal)).rejects.toMatchObject({name:'ProviderAvailabilityError',modelId:f.id,budgetScope:scope});expect(wire.calls).toHaveLength(0);
 }finally{rmSync(root,{recursive:true,force:true});}
});

it('pooled direct inference checks only selected metadata and retains shared cooldown',async()=>{
 const root=mkdtempSync(join(tmpdir(),'gemini-selected-')),f=fixture('gemini');
 f.options.modelIds.push('gemini:unrelated');f.audit.modelIds.push('gemini:unrelated');
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>{if(url.endsWith('/unrelated'))throw new Error('Unrelated model unavailable');return Response.json({name:'models/fixture-model',supportedGenerationMethods:['generateContent'],inputTokenLimit:32768});}));
 const {createFreePool}=await import('../src/server/free-pool-config.js'),pool=createFreePool(root,{directFree:{gemini:f.options}}),provider=pool.providers[0]!,input={messages:[{role:'user',content:'Synthetic request'}],max_tokens:8},signal=new AbortController().signal;
 try{
  wire.status=429;
  await expect(provider.complete(provider.models[0]!,input,signal)).rejects.toMatchObject({status:429});
  expect(fetch).toHaveBeenCalledTimes(2);expect(wire.calls).toHaveLength(1);expect(wire.calls[0].body.model).toBe('fixture-model');
  await expect(provider.complete(provider.models[0]!,input,signal)).rejects.toMatchObject({name:'ProviderCooldownError'});
  expect(fetch).toHaveBeenCalledTimes(2);expect(wire.calls).toHaveLength(1);
 }finally{pool.state.close();rmSync(root,{recursive:true,force:true});}
});
