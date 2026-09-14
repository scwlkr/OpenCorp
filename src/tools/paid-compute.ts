import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CompanyStore } from '../storage/store.js';
import { DomainError, type Actor } from '../core/types.js';
import { assertComputeGrant, reserveCompute, supportedComputeRoute } from '../core/compute-budget.js';

export interface ComputeRoute { provider:'openai';model:string;contextTokens:number;maxOutputTokens:number;inputMicrousdPerToken:number;outputMicrousdPerToken:number;verifiedAt:string;expiresAt:string;source:string;allChargesIncluded:true }
export interface ComputeAccess { route:ComputeRoute;apiKey:string }
export type ComputeAccessReader=(provider:string,model:string)=>ComputeAccess;

/** Parent-only opt-in config; no default credential, paid fallback, or model-authored prices. */
export function computeAccess(dataRoot:string):ComputeAccessReader {
 return (provider,model)=>{
  const directory=join(dataRoot,'credentials');
  const read=(name:string)=>{
   const dir=lstatSync(directory);if(!dir.isDirectory()||dir.isSymbolicLink()||(dir.mode&0o7777)!==0o700||dir.uid!==process.getuid!())throw new Error();
   const fd=openSync(join(directory,name),constants.O_RDONLY|constants.O_NOFOLLOW);
   try{const stat=fstatSync(fd);if(!stat.isFile()||(stat.mode&0o7777)!==0o600||stat.uid!==process.getuid!()||stat.size>16000)throw new Error();return readFileSync(fd,'utf8');}finally{closeSync(fd);}
  };
  try{const config=JSON.parse(read('paid-compute.json')),route=config.routes.find((r:ComputeRoute)=>r.provider===provider&&r.model===model),apiKey=read('paid-compute.key').trim();if(!apiKey||/[\r\n]/.test(apiKey)||!route)throw new Error();return {route,apiKey};}
  catch{throw new DomainError('compute_unconfigured','Protected paid compute route/credential is unavailable; no dispatch.',409);}
 };
}
function bound(route:ComputeRoute,maxOutput:number){
 const now=Date.now();
 if(!supportedComputeRoute(route.provider,route.model)||route.allChargesIncluded!==true||!Number.isFinite(Date.parse(route.verifiedAt))||Date.parse(route.verifiedAt)>now||Date.parse(route.expiresAt)<=now||!Number.isFinite(Date.parse(route.expiresAt))||Date.parse(route.expiresAt)-Date.parse(route.verifiedAt)>86400000||!/^https:\/\/(?:developers|platform)\.openai\.com\//.test(route.source)||route.contextTokens!==1047576||!Number.isSafeInteger(route.maxOutputTokens)||route.maxOutputTokens<1||route.maxOutputTokens>32768||!Number.isSafeInteger(maxOutput)||maxOutput<1||maxOutput>route.maxOutputTokens||![route.inputMicrousdPerToken,route.outputMicrousdPerToken].every(n=>Number.isSafeInteger(n)&&n>0))throw new DomainError('compute_unbounded','Fresh all-in upper pricing and supported token bounds are required before dispatch.',403);
 const maximum=route.contextTokens*route.inputMicrousdPerToken+maxOutput*route.outputMicrousdPerToken;
 if(!Number.isSafeInteger(maximum))throw new DomainError('compute_unbounded','Request cost exceeds exact accounting range.',403);
 return maximum;
}

/** Supplemental text inference through the existing broker; employee identity and default engine persist. */
export async function paidCompute(store:CompanyStore,actor:Actor,args:any,signal:AbortSignal,readAccess:ComputeAccessReader=computeAccess(store.dataRoot),transport:typeof fetch=fetch){
 if(typeof args.prompt!=='string'||!args.prompt.trim()||args.prompt.length>100000||typeof args.dedupeKey!=='string'||!args.dedupeKey.trim()||args.dedupeKey.length>200)throw new DomainError('invalid_compute','Supply bounded text and a stable request key.');
 assertComputeGrant(store,actor,args.proposalId,args.provider,args.model);
 const {route,apiKey}=readAccess(args.provider,args.model);
 if(route.provider!==args.provider||route.model!==args.model)throw new DomainError('compute_unbounded','Configured route differs from requested route.',403);
 const maxOutput=args.maxOutputTokens??1024;
 const body={model:route.model,messages:[{role:'user',content:args.prompt}],max_completion_tokens:maxOutput,n:1,stream:false,store:false,service_tier:'default'};
 signal.throwIfAborted();
 const {action,reused}=reserveCompute(store,actor,{proposalId:args.proposalId,provider:route.provider,model:route.model,dedupeKey:args.dedupeKey,promptHash:createHash('sha256').update(JSON.stringify(body)).digest('hex'),maximumMicrousd:()=>bound(route,maxOutput),pricing:route});
 if(reused)return {actionId:action.id,status:action.status,reused:true,result:action.result,reservedMicrousd:action.reservedMicrousd};
 try{
  // Nothing asynchronous separates reservation and dispatch; an ambiguous transport never releases allowance.
  bound(route,maxOutput);signal.throwIfAborted();
  const response=await transport('https://api.openai.com/v1/chat/completions',{method:'POST',redirect:'error',headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.any([signal,AbortSignal.timeout(120000)])});
  if(!response.ok)throw new Error();
  const data=await response.json() as any;
  if(typeof data.id!=='string'||!data.id||typeof data.choices?.[0]?.message?.content!=='string')throw new Error();
  const usage=data.usage,known=Number.isSafeInteger(usage?.prompt_tokens)&&usage.prompt_tokens>=0&&usage.prompt_tokens<=route.contextTokens&&Number.isSafeInteger(usage?.completion_tokens)&&usage.completion_tokens>=0&&usage.completion_tokens<=maxOutput;
  const result={text:data.choices[0].message.content,usage:known?{inputTokens:usage.prompt_tokens,outputTokens:usage.completion_tokens}:null,observedUpperMicrousd:known?usage.prompt_tokens*route.inputMicrousdPerToken+usage.completion_tokens*route.outputMicrousdPerToken:null,limitation:'Full worst-case reservation remains charged against the grant; token usage is not final billing.'};
  store.resolveAction(action.id,{status:'succeeded',remoteRef:data.id,result});
  return {actionId:action.id,status:'succeeded',reservedMicrousd:action.reservedMicrousd,result};
 }catch{
  store.resolveAction(action.id,{status:'uncertain',result:{limitation:'Provider charge/outcome unconfirmed. Full reservation retained. Do not resend this request.'}});
  throw new DomainError('compute_uncertain','Compute outcome or charge is uncertain; inspect the retained action before any further work.',409);
 }
}
