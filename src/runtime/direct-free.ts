import {ProviderCooldownError, ProviderAvailabilityError} from './resource-budget.js';
import { createHash } from 'node:crypto';
import { request } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { DirectFreeModel, DirectFreeOptions, DirectFreeProviderName, DirectFreeTierAudit } from './types.js';

import { estimatedRequestTokens, providerRateBudget, validateEstimatedRequest } from './provider-rate-budget.js';
import { DIRECT_FREE_ENDPOINTS, directFreeProvider, validZaiPricingAudit } from '../core/inference-policy.js';
const cooldowns=new WeakMap<DirectFreeOptions,number>();
export function directFreeCooldown(options:DirectFreeOptions):string|undefined {const at=cooldowns.get(options);return at&&at>Date.now()?new Date(at).toISOString():undefined;}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
/** Free account eligibility uses bounded, key-bound Owner evidence. Model APIs do not attest billing tier. */
export class DirectFree {
 constructor(readonly provider:DirectFreeProviderName,private readonly options:DirectFreeOptions,private readonly selection=options.modelIds){
  if(!selection.every(id=>directFreeProvider(id)===provider))throw new Error('Direct free provider requires exact namespaced model IDs');
 }
 private checkCooldown(){const retryAt=directFreeCooldown(this.options);if(retryAt)throw new ProviderCooldownError(this.provider,retryAt);}
 private scope(audit:DirectFreeTierAudit|undefined,id?:string){return this.provider==='gemini'&&audit?hash(JSON.stringify(['gemini',audit.accountId,id??null])):undefined;}
 private checkScopedAvailability(audit:DirectFreeTierAudit,id:string,includeDaily=true){
  if(this.provider!=='gemini'){this.checkCooldown();return;}
  const budget=providerRateBudget(this.provider,this.options),until=[budget.cooldown(this.scope(audit)),budget.cooldown(this.scope(audit,id))].filter((v):v is string=>!!v).sort().at(-1);
  if(until)throw new ProviderCooldownError(this.provider,until);
  const scope=this.scope(audit,id),retryAt=includeDaily?budget.dailyAvailability(scope):undefined;if(retryAt)throw new ProviderAvailabilityError(this.provider,retryAt,'Local rolling 24-hour provider reservation budget exhausted; this is not account remaining quota',scope,id);
 }
 private retainCooldown(audit:DirectFreeTierAudit){if(this.provider==='gemini')providerRateBudget(this.provider,this.options).hold(Date.now()+300000,this.scope(audit));else cooldowns.set(this.options,Date.now()+300000);}
 private async credentials(id:string){
  try{
   const {apiKey,audit}=await this.options.readCredentials(),now=Date.now(),verified=Date.parse(audit.verifiedAt),expires=Date.parse(audit.expiresAt);
   if(!apiKey||/[\r\n]/.test(apiKey)||apiKey.length>4096||audit.provider!==this.provider||audit.billingEnabled!==false||!audit.accountId?.trim()||!audit.evidence?.trim()||audit.credentialSha256!==hash(apiKey)||!Array.isArray(audit.modelIds)||!audit.modelIds.includes(id)||!Number.isFinite(verified)||!Number.isFinite(expires)||verified>now||expires<=now||expires-verified>86400000||expires<=verified)throw new Error();
   if(this.provider==='zai'&&(id!=='zai:glm-4.7-flash'||!validZaiPricingAudit(audit.pricing,now)))throw new Error();
   return {apiKey,audit:{...audit,modelIds:[...audit.modelIds]}};
  }catch{throw new ProviderAvailabilityError(this.provider,new Date(Date.now()+60_000).toISOString(),'Direct free provider requires fresh key-bound Owner evidence of a free account/project with billing disabled and explicit zero-price evidence where required; recheck in one minute, no automatic renewal');}
 }
 async availability(id:string):Promise<ProviderAvailabilityError|undefined>{
  try{const {audit}=await this.credentials(id);this.checkScopedAvailability(audit,id);const retryAt=providerRateBudget(this.provider,this.options).dailyAvailability(this.scope(audit,id));if(retryAt)return new ProviderAvailabilityError(this.provider,retryAt,'Local rolling 24-hour provider reservation budget exhausted; this is not account remaining quota');}
  catch(error){return error instanceof ProviderAvailabilityError?error:new ProviderAvailabilityError(this.provider,new Date(Date.now()+60_000).toISOString(),'Protected provider reservation state unavailable; recheck in one minute');}
 }
 async models(signal?:AbortSignal):Promise<DirectFreeModel[]>{
  if(this.provider!=='gemini')this.checkCooldown();const result:DirectFreeModel[]=[];
  for(const id of this.selection){
   signal?.throwIfAborted();const {apiKey,audit}=await this.credentials(id),upstream=id.slice(this.provider.length+1);
   try{this.checkScopedAvailability(audit,id);}catch(error){if(this.selection.length>1&&error instanceof ProviderAvailabilityError)continue;throw error;}
   const url=this.provider==='groq'?'https://api.groq.com/openai/v1/models':`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(upstream)}`;
   let metadata:any;
   // Z.ai inventory reflects dated account/pricing evidence, not a successful live API probe.
   if(this.provider==='zai')metadata={id:upstream,contextTokens:200000,profile:'zai-flash-text-no-thinking-v1',pricing:{source:audit.pricing!.source,modelId:upstream,input:0,cachedInput:0,cachedInputStorage:0,output:0}};
   else {
    const timeout=AbortSignal.timeout(15000),unavailable=(detail:string)=>new ProviderAvailabilityError(this.provider,new Date(Date.now()+60_000).toISOString(),`Direct free metadata ${detail}; recheck in one minute without inference`);
    const fail=(phase:'request'|'response',error:unknown):never=>{signal?.throwIfAborted();if(timeout.aborted)throw unavailable(`${phase} timeout`);if(phase==='request'||error instanceof TypeError)throw unavailable(`${phase} transport unavailable`);throw new Error('Direct free metadata response invalid; model availability not verified');};
    let response:Response;
    try{response=await fetch(url,{headers:this.provider==='groq'?{authorization:`Bearer ${apiKey}`}:{'x-goog-api-key':apiKey},redirect:'error',signal:signal?AbortSignal.any([signal,timeout]):timeout});}catch(error){fail('request',error);}
    signal?.throwIfAborted();
    if(!response!.ok){await response!.body?.cancel().catch(()=>{});if(response!.status===429){this.retainCooldown(audit);this.checkScopedAvailability(audit,id);}if(response!.status===408||response!.status>=500&&response!.status<=599)throw unavailable(`request HTTP ${response!.status}`);throw new Error(`Direct free metadata request HTTP ${response!.status}; model availability not verified`);}
    try{metadata=await response!.json();}catch(error){fail('response',error);}
    signal?.throwIfAborted();if(this.provider==='groq')metadata=metadata?.data?.find((entry:any)=>entry.id===upstream);
   }
   if(!metadata||(this.provider==='zai'?metadata.id!=='glm-4.7-flash':this.provider==='groq'?(metadata.id!==upstream||metadata.active!==true||!Number.isSafeInteger(metadata.context_window)||metadata.context_window<32768):(metadata.name!==`models/${upstream}`||!Array.isArray(metadata.supportedGenerationMethods)||!metadata.supportedGenerationMethods.includes('generateContent')||!Number.isSafeInteger(metadata.inputTokenLimit)||metadata.inputTokenLimit<32768)))throw new Error('Direct free model identity or context is unavailable');
   const identity={provider:this.provider,id,contextTokens:32768,metadata,accountId:audit.accountId};
   result.push({id,name:`${id} [free account]`,alias:id,sourceAlias:id,artifactIdentity:hash(JSON.stringify(identity)),provider:this.provider,local:false,available:true,freeOnly:true,endpoint:DIRECT_FREE_ENDPOINTS[this.provider],size:0,sizeClass:'remote',capabilities:['tools'],contextTokens:32768,tierVerification:'owner-tier-audit',tierVerifiedAt:audit.verifiedAt,tierExpiresAt:this.provider==='zai'?new Date(Math.min(Date.parse(audit.expiresAt),Date.parse(audit.pricing!.verifiedAt)+86400000)).toISOString():audit.expiresAt});
  }
  return result;
 }
 async infer(model:DirectFreeModel,input:Record<string,unknown>,signal:AbortSignal,onDispatch?:(body:Record<string,unknown>)=>void):Promise<IncomingMessage>{
  signal.throwIfAborted();if(this.provider!=='gemini')this.checkCooldown();if(model.provider!==this.provider||!this.selection.includes(model.id)||model.endpoint!==DIRECT_FREE_ENDPOINTS[this.provider])throw new Error('Direct free model is not authorized');
  const body:Record<string,unknown>={};
  if(!Array.isArray(input.messages)||input.messages.some((m:any)=>!m||typeof m.content!=='string'&&m.content!==null&&m.content!==undefined))throw new Error('Direct free inference permits text messages only');
  body.messages=input.messages.map((m:any)=>Object.fromEntries(['role','content','tool_calls','tool_call_id','name'].filter(k=>m[k]!==undefined).map(k=>[k,m[k]])));
  if(input.tools!==undefined){if(!Array.isArray(input.tools)||input.tools.some((t:any)=>t?.type!=='function'||!t.function))throw new Error('Direct free inference permits client function tools only');body.tools=input.tools.map((t:any)=>({type:'function',function:Object.fromEntries(['name','description','parameters','strict'].filter(k=>t.function[k]!==undefined).map(k=>[k,t.function[k]]))}));}
  if(this.provider==='zai'&&input.tool_choice!==undefined&&input.tool_choice!=='auto')throw new Error('Z.ai supports auto tool choice only; omit tools for final-only requests');
  if(input.tool_choice!==undefined){if(['auto','none','required'].includes(String(input.tool_choice)))body.tool_choice=input.tool_choice;else{const choice=input.tool_choice as any;if(choice?.type!=='function'||typeof choice.function?.name!=='string')throw new Error('Invalid direct free tool choice');body.tool_choice={type:'function',function:{name:choice.function.name}};}}
  if(typeof input.temperature==='number'&&Number.isFinite(input.temperature))body.temperature=input.temperature;
  body.model=model.id.slice(this.provider.length+1);body.stream=true;body.max_tokens=typeof input.max_tokens==='number'&&Number.isSafeInteger(input.max_tokens)&&input.max_tokens>0?Math.min(input.max_tokens,4096):4096;
  if(this.provider==='zai')body.thinking={type:'disabled'};
  const estimatedTokens=estimatedRequestTokens(body);validateEstimatedRequest(this.provider,estimatedTokens);
  const admissionAudit=this.provider==='gemini'?(await this.credentials(model.id)).audit:undefined;if(admissionAudit)this.checkScopedAvailability(admissionAudit,model.id);
  const current=(await this.models(signal)).find(item=>item.id===model.id);if(!current&&this.provider==='gemini'){const unavailable=await this.availability(model.id);signal.throwIfAborted();if(unavailable)throw unavailable;}if(!current||current.artifactIdentity!==model.artifactIdentity)throw new Error('Direct free model identity changed');
  const budget=providerRateBudget(this.provider,this.options),release=await budget.acquireStream(signal);
  try{
  const reservation=await budget.reserve(estimatedTokens,signal,this.scope(admissionAudit,model.id)).catch(error=>{
   signal.throwIfAborted();
   if(this.provider==='gemini'&&admissionAudit&&error instanceof ProviderAvailabilityError&&error.budgetScope===this.scope(admissionAudit,model.id))throw new ProviderAvailabilityError(this.provider,error.retryAt,error.message,error.budgetScope,model.id);
   throw error;
  });
  signal.throwIfAborted();
  const {apiKey,audit}=await this.credentials(model.id);
  if(admissionAudit&&audit.accountId!==admissionAudit.accountId)throw new ProviderAvailabilityError(this.provider,new Date(Date.now()+60000).toISOString(),'Verified provider account changed during admission; no request dispatched');
  signal.throwIfAborted();this.checkScopedAvailability(audit,model.id,false);
  onDispatch?.(body);
  return await new Promise<IncomingMessage>((resolve,reject)=>{const pending=request(DIRECT_FREE_ENDPOINTS[this.provider],{method:'POST',signal,agent:false,headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json'}},response=>{response.once('end',release);response.once('close',release);response.once('error',release);try{if(response.statusCode===429)this.retainCooldown(audit);budget.observe(response.headers,reservation);resolve(response);}catch{response.destroy();reject(new Error('Protected provider pacing observation could not be retained'));}});pending.on('error',()=>reject(new Error('Direct free inference transport failed')));pending.end(JSON.stringify(body));});
  }catch(error){release();throw error;}
 }
}
