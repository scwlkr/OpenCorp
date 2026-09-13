import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FreeInferencePool, nextDailyReset } from '../src/runtime/free-pool/pool.js';
import { ProviderAvailabilityError } from '../src/runtime/resource-budget.js';
import { OpenRouterModelUnavailableError } from '../src/runtime/openrouter.js';
import { PoolState } from '../src/runtime/free-pool/state.js';
import { PoolAttemptError, PoolUnavailableError, PoolRequestUnsupportedError, PoolContextOverflowError, type PoolProvider, type PoolCompletion } from '../src/runtime/free-pool/types.js';
import { portableBody, readCompletion } from '../src/runtime/free-pool/transport.js';
import { permittedPooledModel, productiveSharingAllowed } from '../src/core/inference-policy.js';

const states: PoolState[] = [], dirs: string[] = [];
afterEach(() => { for(const state of states.splice(0))state.close();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true}); });
const state = () => { const value = new PoolState(':memory:'); states.push(value); return value; };
const reply = (): PoolCompletion => ({id:'synthetic-completion',object:'chat.completion',model:'synthetic-model',choices:[{index:0,message:{role:'assistant',content:'ok'},finish_reason:'stop'}]});
const request = {messages:[{role:'user',content:'A synthetic test'}],max_tokens:8};
function provider(id:string, overrides:Partial<PoolProvider>={}):PoolProvider{return {id,scope:id,revision:'synthetic-v1',renewable:true,models:[{id:'synthetic-model',context:32768,quality:2,tools:true}],limits:[],concurrency:1,available:async()=>true,complete:vi.fn(async()=>({completion:reply(),headers:new Headers()})),...overrides};}

describe('free inference pool',()=>{
 it('defers unavailable work before native startup without reserving quota, then permits expiry',async()=>{
  const {LocalRuntime}=await import('../src/runtime/index.js');
  let now=Date.now();const ledger=state(),held=provider('held'),small=provider('small',{limits:[{scope:'small-minute',tokens:8000,periodMs:60000}]}),evaluation=provider('evaluation',{evaluationOnly:true}),publicOnly=provider('public',{publicOnly:true});
  ledger.hold(held.scope,held.revision,now+600000,'synthetic-cooldown');
  const pool=new FreeInferencePool(ledger,[held,small,evaluation,publicOnly],()=>now),dir=mkdtempSync(join(tmpdir(),'opencorp-pool-admission-'));dirs.push(dir);
  const runtime=new LocalRuntime({dataRoot:dir,freePool:pool});
  expect(await runtime.providerAvailability('free-pool')).toBeUndefined();
  expect(await runtime.providerAvailability('free-pool',{system:'x'.repeat(15000),prompt:'Synthetic work',provisionOnly:true,corporateOnly:true})).toBeUndefined();
  expect(await runtime.providerAvailability('free-pool',{system:'x'.repeat(15000),prompt:'Synthetic work'})).toBeInstanceOf(Error);
  const onSession=vi.fn();await expect(runtime.execute({runId:'synthetic-held',employeeId:'synthetic-worker',modelId:'free-pool',freeInferencePool:true,workspace:dir,system:'Synthetic instructions '.repeat(1000),prompt:'Synthetic work',onSession})).rejects.toMatchObject({name:'ProviderAvailabilityError',provider:'free-pool',retryAt:new Date(now+600000).toISOString()});
  expect(onSession).not.toHaveBeenCalled();for(const p of [held,small,evaluation,publicOnly])expect(p.complete).not.toHaveBeenCalled();
  expect(ledger.availability(small,small.models[0]!.id,8000,now).retryAt).toBe(0);
  now+=600000;expect(await runtime.providerAvailability('free-pool',{system:'Synthetic instructions '.repeat(1000),prompt:'Synthetic work'})).toBeUndefined();
  ledger.hold(held.scope,held.revision,Number.MAX_SAFE_INTEGER,'configuration-required');
  expect((await runtime.providerAvailability('free-pool',{system:'Synthetic instructions '.repeat(1000),prompt:'Synthetic work'}))?.retryAt).toBe(new Date(now+60000).toISOString());
 });
 it('fails over and shares a 429 hold across all models on the account',async()=>{
  let now=100000;const a=provider('a',{complete:vi.fn(async()=>{throw new PoolAttemptError(429,new Headers({'retry-after':'120'}));})}),b=provider('b');
  a.models.push({...a.models[0]!,id:'another'});const pool=new FreeInferencePool(state(),[a,b],()=>now);
  expect((await pool.generate(request)).model).toBe('b/synthetic-model');await pool.generate(request);expect(a.complete).toHaveBeenCalledTimes(1);
  now+=121000;await pool.generate(request);expect(a.complete).toHaveBeenCalledTimes(2);
 });
 it('holds only an unavailable OpenRouter model and can serve another free model',async()=>{
  const ledger=state(),p=provider('openrouter',{models:[{id:'unavailable',context:32768,quality:2,tools:true},{id:'available',context:32768,quality:2,tools:true}],complete:vi.fn(async model=>{
   if(model.id==='unavailable')throw new OpenRouterModelUnavailableError('Selected model no longer qualifies');
   return {completion:reply(),headers:new Headers()};
  })});
  expect((await new FreeInferencePool(ledger,[p]).generate(request)).model).toBe('openrouter/available');
  expect(ledger.health(p.scope,p.revision).failures).toBe(0);expect(ledger.health(`${p.scope}/unavailable`,p.revision).failures).toBe(1);
 });
 it('reports the current account hold after a later fallback supersedes a model hold',async()=>{
  const now=100000,p=provider('a',{models:[{id:'first',context:32768,quality:2,tools:true},{id:'second',context:32768,quality:2,tools:true}],complete:vi.fn(async model=>{
   throw model.id==='first'?new PoolAttemptError(404):new PoolAttemptError(429,new Headers({'retry-after':'120'}));
  })});
  await expect(new FreeInferencePool(state(),[p],()=>now).generate(request)).rejects.toMatchObject({retryAt:now+120000});
  expect(p.complete).toHaveBeenCalledTimes(2);
 });
 it.each(['selected','account','other-model','other-provider'])('narrows only explicit selected Gemini model holds: %s',async scope=>{
  const now=100000,ledger=state(),p=provider('gemini',{models:[{id:'first',context:32768,quality:2,tools:true},{id:'second',context:32768,quality:2,tools:true}],complete:vi.fn(async model=>{
   if(model.id==='first')throw new ProviderAvailabilityError(scope==='other-provider'?'groq':'gemini',new Date(now+600000).toISOString(),'Synthetic quota hold',undefined,scope==='account'?undefined:scope==='other-model'?'other':'first');
   return {completion:reply(),headers:new Headers()};
  })}),pool=new FreeInferencePool(ledger,[p],()=>now);
  if(scope==='selected'){expect((await pool.generate(request)).model).toBe('gemini/second');expect(p.complete).toHaveBeenCalledTimes(2);expect(ledger.health(p.scope,p.revision).failures).toBe(0);expect(ledger.health(`${p.scope}/first`,p.revision).until_ms).toBe(now+600000);}
  else{await expect(pool.generate(request)).rejects.toBeInstanceOf(PoolUnavailableError);expect(p.complete).toHaveBeenCalledOnce();expect(ledger.health(p.scope,p.revision).until_ms).toBe(now+600000);}
 });
 it('retains cooldown and quota reservations across process-style reopen',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'opencorp-pool-'));dirs.push(dir);const path=join(dir,'state.sqlite');
  const p=provider('a',{limits:[{scope:'account-minute',requests:1,periodMs:60000}]});const first=new PoolState(path);
  await new FreeInferencePool(first,[p],()=>1000).generate(request);first.close();const reopened=new PoolState(path);states.push(reopened);
  const pool=new FreeInferencePool(reopened,[p],()=>2000);await expect(pool.generate(request)).rejects.toBeInstanceOf(PoolUnavailableError);
  expect(p.complete).toHaveBeenCalledTimes(1);
 });
 it('selects enough quality/context/tools while preserving stronger models',async()=>{
  const a=provider('a',{models:[{id:'strong',quality:3,context:100000,tools:true}]}),b=provider('b');
  const pool=new FreeInferencePool(state(),[a,b]);expect((await pool.generate(request)).model).toBe('b/synthetic-model');
  expect((await pool.generate({...request,quality:3})).model).toBe('a/strong');
  expect((await pool.generate({...request,messages:[{role:'user',content:'x'.repeat(100000)}]})).model).toBe('a/strong');
 });
 it('reserves concurrent capacity before awaiting a provider',async()=>{
  let resolve!:()=>void;const pending=new Promise<void>(r=>resolve=r);
  const a=provider('a',{complete:vi.fn(async()=>{await pending;return {completion:reply(),headers:new Headers()};})}),b=provider('b');
  const pool=new FreeInferencePool(state(),[a,b]);const first=pool.generate(request);await Promise.resolve();
  expect((await pool.generate(request)).model).toBe('b/synthetic-model');resolve();await first;
 });
 it('does not renew trial reservations',async()=>{
  let now=1000;const a=provider('a',{renewable:false,limits:[{scope:'trial',requests:1,periodMs:0}]});const pool=new FreeInferencePool(state(),[a],()=>now);
  await pool.generate(request);now+=90*86400000;await expect(pool.generate(request)).rejects.toBeInstanceOf(PoolUnavailableError);
 });
 it('renews rolling free quota without a background polling loop',async()=>{
  let now=1000;const a=provider('a',{limits:[{scope:'daily',requests:1,periodMs:86400000}]});const pool=new FreeInferencePool(state(),[a],()=>now);
  await pool.generate(request);await expect(pool.generate(request)).rejects.toBeInstanceOf(PoolUnavailableError);now+=86400000;await pool.generate(request);expect(a.complete).toHaveBeenCalledTimes(2);
 });
 it('keeps auth failures disabled until configuration changes',async()=>{
  let now=1000;const a=provider('a',{available:vi.fn(async()=>false)});const pool=new FreeInferencePool(state(),[a],()=>now);
  await expect(pool.generate(request)).rejects.toBeInstanceOf(PoolUnavailableError);now+=86400000;await expect(pool.generate(request)).rejects.toBeInstanceOf(PoolUnavailableError);expect(a.available).toHaveBeenCalledTimes(1);
  a.revision='synthetic-v2';a.available=async()=>true;await pool.generate(request);
 });
 it('stops after four attempts and never cycles through extra keys/models',async()=>{
  const providers=Array.from({length:8},(_,i)=>provider(String(i),{complete:vi.fn(async()=>{throw new PoolAttemptError(503);})}));
  await expect(new FreeInferencePool(state(),providers).generate(request)).rejects.toBeInstanceOf(PoolUnavailableError);
  expect(providers.reduce((n,p)=>n+vi.mocked(p.complete).mock.calls.length,0)).toBe(4);
 });
 it('compacts removable history but ends oversized fixed context without dispatch or quota use',async()=>{
  const p=provider('small',{models:[{id:'small',context:1024,quality:2,tools:true}]}),ledger=state(),pool=new FreeInferencePool(ledger,[p],()=>1000);
  await expect(pool.generate({...request,messages:[{role:'user',content:'x'.repeat(4000)}]})).rejects.toBeInstanceOf(PoolContextOverflowError);
  await expect(pool.generate({...request,messages:[{role:'system',content:'x'.repeat(4000)},...request.messages]})).rejects.toBeInstanceOf(PoolRequestUnsupportedError);
  await expect(pool.generate({...request,tools:[{type:'function',function:{name:'synthetic',description:'x'.repeat(4000)}}]})).rejects.toBeInstanceOf(PoolRequestUnsupportedError);
  expect(p.complete).not.toHaveBeenCalled();
  const capped=provider('capped',{limits:[{scope:'minute',tokens:1000,periodMs:60000}]});
  await expect(new FreeInferencePool(state(),[capped]).generate({...request,max_tokens:1024})).rejects.toBeInstanceOf(PoolRequestUnsupportedError);expect(capped.complete).not.toHaveBeenCalled();
  ledger.hold(p.scope,p.revision,9000,'synthetic-cooldown');
  await expect(pool.generate(request)).rejects.toMatchObject({retryAt:9000});
  await expect(new FreeInferencePool(state(),[],()=>1000).generate(request)).rejects.toMatchObject({retryAt:61000});
 });
 it('never dispatches confidential or ineligible evaluation traffic',async()=>{
  const p=provider('trial',{evaluationOnly:true,publicOnly:true});const pool=new FreeInferencePool(state(),[p]);
  await expect(pool.generate(request)).rejects.toBeInstanceOf(PoolRequestUnsupportedError);
  await expect(pool.generate({...request,purpose:'evaluation',dataClass:'confidential'})).rejects.toBeInstanceOf(PoolRequestUnsupportedError);
  expect(p.complete).not.toHaveBeenCalled();await pool.generate({...request,purpose:'evaluation',dataClass:'public'});
 });
 it('does not retry after caller cancellation',async()=>{
  const controller=new AbortController();const a=provider('a',{complete:async()=>{controller.abort();throw new Error();}}),b=provider('b');
  await expect(new FreeInferencePool(state(),[a,b]).generate(request,controller.signal)).rejects.toBeDefined();expect(b.complete).not.toHaveBeenCalled();
 });
 it('rejects a malformed tool reply before falling back',async()=>{
  const bad=reply();bad.choices[0]!.message={role:'assistant',content:null,tool_calls:[{type:'function',id:'synthetic-call',function:{name:'ping',arguments:'broken'}}]};bad.choices[0]!.finish_reason='tool_calls';
  const a=provider('a',{complete:async()=>({completion:bad,headers:new Headers()})}),b=provider('b');
  const pool=new FreeInferencePool(state(),[a,b]);expect((await pool.generate({...request,tools:[{type:'function',function:{name:'ping',parameters:{type:'object'}}}]})).model).toBe('b/synthetic-model');
 });
 it('preserves split tool arguments and rejects interrupted streams',async()=>{
  const chunk=(delta:any,finish_reason:string|null=null)=>`data: ${JSON.stringify({id:'synthetic',choices:[{index:0,delta,finish_reason}]})}\n\n`;
  const first=chunk({tool_calls:[{index:0,id:'synthetic-call',type:'function',function:{name:'ping',arguments:'{"ok":'}}]});
  const last=chunk({tool_calls:[{index:0,function:{arguments:'true}'}}]},'tool_calls');
  const completion=await readCompletion(new Response(first+last+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}}));
  expect(completion.choices[0]!.message.tool_calls[0].function.arguments).toBe('{"ok":true}');
  await expect(readCompletion(new Response(first,{headers:{'content-type':'text/event-stream'}}))).rejects.toBeInstanceOf(PoolAttemptError);
 });
 it('drops caller routing, server tools, and cross-provider signature fields',()=>{
  const body=portableBody({...request,messages:[{role:'assistant',content:null,tool_calls:[{id:'synthetic-call',type:'function',function:{name:'ping',arguments:'{}'},extra_content:{google:{thought_signature:'synthetic-signature'}}}]}],...{provider:{order:['paid']},plugins:[{id:'web'}]}} as any,'synthetic');
  expect(JSON.stringify(body)).not.toMatch(/paid|plugins|thought_signature/);
 });
 it('requires Owner pool policy and preserves the local concurrency pin',()=>{
  const model=new FreeInferencePool(state(),[provider('a')]).model();expect(permittedPooledModel({},model)).toBe(false);expect(permittedPooledModel({freeInferencePool:true},model)).toBe(true);
  expect(productiveSharingAllowed(model,[model],{maxProductiveTurns:5,productiveArtifactIdentity:'local-pin'})).toBe(true);
  expect(productiveSharingAllowed(model,[{local:true,artifactIdentity:'wrong'}],{maxProductiveTurns:5,productiveArtifactIdentity:'local-pin'})).toBe(false);
 });
 it('uses actual Pacific midnight across daylight saving time',()=>{
  expect(new Date(nextDailyReset(Date.parse('2026-03-08T09:30:00Z'),'pacific')).toISOString()).toBe('2026-03-09T07:00:00.000Z');
  expect(new Date(nextDailyReset(Date.parse('2026-11-01T08:30:00Z'),'pacific')).toISOString()).toBe('2026-11-02T08:00:00.000Z');
 });
});

it('serves the employee gateway alias while reporting the actual provider',async()=>{
 const { RunGateway }=await import('../src/runtime/gateway.js');
 const pool=new FreeInferencePool(state(),[provider('a')]);const events:any[]=[];
 const gateway=new RunGateway(pool,pool.model(),{runId:'synthetic-run',employeeId:'synthetic-employee',workspace:'/tmp/synthetic-workspace',modelId:'free-pool',freeInferencePool:true,system:'synthetic',prompt:'synthetic'},e=>events.push(e));
 await gateway.start();gateway.sessionId='synthetic-session';
 try{const response=await fetch(`${gateway.url}/v1/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${gateway.secret}`,'content-type':'application/json'},body:JSON.stringify({...request,model:'free-pool',stream:true})});
 expect(response.status).toBe(200);expect(await response.text()).toContain('[DONE]');expect(events.some(e=>e.type==='runtime.inference.routed'&&e.payload.modelId==='a/synthetic-model')).toBe(true);
 }finally{await gateway.close();}
});
