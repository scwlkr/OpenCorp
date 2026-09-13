import type { OwnerPolicy } from './types.js';

export function permittedPooledModel(policy: Pick<OwnerPolicy,'freeInferencePool'>, model: any): boolean {
 return policy.freeInferencePool === true && model?.id === 'free-pool' && model.provider === 'pool' && model.local === false && model.freeOnly === true && model.available === true && model.endpoint === 'opencorp:free-pool' && /^[a-f0-9]{64}$/.test(model.artifactIdentity);
}

export const validOpenRouterFreeId = (id: unknown): id is string => typeof id === 'string' && /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*:free$/.test(id);

/** Stored eligibility is necessary but runtime must freshly verify zero pricing before dispatch. */
export function permittedOpenRouterFreeModel(policy: Pick<OwnerPolicy, 'openRouterFreeModels'>, model: any): boolean {
  return !!model && validOpenRouterFreeId(model.id) && !!policy.openRouterFreeModels?.includes(model.id)
    && model.provider === 'openrouter' && model.local === false && model.available === true && model.freeOnly === true
    && model.endpoint === 'https://openrouter.ai/api/v1/chat/completions' && /^[a-f0-9]{64}$/.test(model.artifactIdentity)
    && typeof model.pricingVerifiedAt === 'string' && Number.isFinite(Date.parse(model.pricingVerifiedAt))
    && !!model.pricing && typeof model.pricing === 'object' && !Array.isArray(model.pricing)
    && Object.hasOwn(model.pricing, 'prompt') && Object.hasOwn(model.pricing, 'completion')
    && Object.values(model.pricing).every(value => typeof value === 'string' && /^0(?:\.0+)?$/.test(value) || value === 0);
}

export const DIRECT_FREE_ENDPOINTS={groq:'https://api.groq.com/openai/v1/chat/completions',gemini:'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',zai:'https://api.z.ai/api/paas/v4/chat/completions'} as const;
export function directFreeProvider(id:unknown):'groq'|'gemini'|'zai'|undefined {
 if(id==='zai:glm-4.7-flash')return 'zai';
 return typeof id==='string'&&/^(groq|gemini):[a-zA-Z0-9][a-zA-Z0-9._/-]{0,150}$/.test(id)?id.split(':')[0] as 'groq'|'gemini':undefined;
}
/** Dated official pricing observation; not a live pricing API guarantee. */
export function validZaiPricingAudit(value:any,now=Date.now()):boolean {
 const keys=['source','modelId','input','cachedInput','cachedInputStorage','output','verifiedAt'];
 return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key))&&value.source==='https://docs.z.ai/guides/overview/pricing'&&value.modelId==='glm-4.7-flash'&&['input','cachedInput','cachedInputStorage','output'].every(key=>value[key]===0)&&typeof value.verifiedAt==='string'&&Number.isFinite(Date.parse(value.verifiedAt))&&Date.parse(value.verifiedAt)<=now&&now-Date.parse(value.verifiedAt)<86400000;
}
export function permittedDirectFreeModel(policy:Pick<OwnerPolicy,'directFreeModels'>,model:any):boolean {
 const provider=directFreeProvider(model?.id);
 return !!provider&&!!policy.directFreeModels?.includes(model.id)&&model.provider===provider&&model.endpoint===DIRECT_FREE_ENDPOINTS[provider]&&model.local===false&&model.available===true&&model.freeOnly===true&&/^[a-f0-9]{64}$/.test(model.artifactIdentity)&&model.tierVerification==='owner-tier-audit'&&Date.parse(model.tierVerifiedAt)<=Date.now()&&Date.parse(model.tierExpiresAt)>Date.now()&&Date.parse(model.tierExpiresAt)-Date.parse(model.tierVerifiedAt)<=86400000;
}

export interface ProductiveRemoteProfile {modelId:string;artifactIdentity:string;maxConcurrentTurns:number}
export interface ProductiveProviderCap {provider:'groq'|'gemini'|'zai'|'openrouter';maxConcurrentTurns:number}
export const inferenceProvider=(id:string)=>directFreeProvider(id)??(validOpenRouterFreeId(id)?'openrouter':undefined);
export function validProductiveRemoteCapacity(profiles:unknown,caps:unknown):boolean {
 if(!Array.isArray(profiles)||!profiles.length||profiles.length>4||!Array.isArray(caps)||!caps.length||caps.length>4)return false;
 const bounded=(n:unknown)=>Number.isInteger(n)&&Number(n)>=1&&Number(n)<=4;
 return profiles.every(p=>p&&inferenceProvider(p.modelId)&&/^[a-f0-9]{64}$/.test(p.artifactIdentity)&&bounded(p.maxConcurrentTurns))&&new Set(profiles.map(p=>p.modelId)).size===profiles.length&&caps.every(p=>p&&['groq','gemini','zai','openrouter'].includes(p.provider)&&bounded(p.maxConcurrentTurns)&&(p.provider!=='zai'||p.maxConcurrentTurns===1))&&new Set(caps.map(p=>p.provider)).size===caps.length&&profiles.every(p=>caps.some(c=>c.provider===inferenceProvider(p.modelId)))&&caps.every(c=>profiles.some(p=>inferenceProvider(p.modelId)===c.provider));
}
export function productiveCapacity(profiles:ProductiveRemoteProfile[],caps:ProductiveProviderCap[]):number {return 1+caps.reduce((total,cap)=>total+Math.min(cap.maxConcurrentTurns,profiles.filter(p=>inferenceProvider(p.modelId)===cap.provider).reduce((n,p)=>n+p.maxConcurrentTurns,0)),0);}
export interface ProductiveLimits {maxProductiveTurns?:number;productiveArtifactIdentity?:string;productiveRemoteModelId?:string;productiveRemoteArtifactIdentity?:string;productiveRemoteProfiles?:ProductiveRemoteProfile[];productiveProviderCaps?:ProductiveProviderCap[]}
/** Exact qualified sharing only; no model access is granted here. */
export function productiveSharingAllowed(candidate:any,active:any[],limits:ProductiveLimits):boolean {
 const count=limits.maxProductiveTurns??1;
 if(count<2||active.length>=count||!candidate||active.some(model=>!model))return false;
 // Local capacity is an Owner limit, not a fixed model class or qualification ceremony.
 if(!limits.productiveRemoteModelId&&!limits.productiveRemoteProfiles&&[candidate,...active].every(model=>model.local===true))return true;
 if(!limits.productiveArtifactIdentity)return false;
 // Pool reservations enforce actual account capacities per request. Keep the owned local slot pinned.
 if ([candidate,...active].some(m=>m.provider==='pool')) {
  const all=[candidate,...active],locals=all.filter(m=>m.local===true);
  return locals.length<=1 && locals.every(m=>m.artifactIdentity===limits.productiveArtifactIdentity)
   && all.every(m=>m.local===true || m.provider==='pool' && m.id==='free-pool' && m.freeOnly===true);
 }
 if(limits.productiveRemoteProfiles){
  if(!validProductiveRemoteCapacity(limits.productiveRemoteProfiles,limits.productiveProviderCaps))return false;
  const all=[candidate,...active],locals=all.filter(m=>m.local===true),remotes=all.filter(m=>m.local===false);
  return locals.length<=1&&locals.every(m=>m.artifactIdentity===limits.productiveArtifactIdentity)&&locals.length+remotes.length===all.length&&remotes.every(m=>limits.productiveRemoteProfiles!.some(p=>m.id===p.modelId&&m.artifactIdentity===p.artifactIdentity&&m.provider===inferenceProvider(p.modelId)))&&limits.productiveRemoteProfiles.every(p=>remotes.filter(m=>m.id===p.modelId).length<=p.maxConcurrentTurns)&&limits.productiveProviderCaps!.every(p=>remotes.filter(m=>m.provider===p.provider).length<=p.maxConcurrentTurns);
 }
 if(count!==2)return false;
 if(limits.productiveRemoteModelId){
  const side=(model:any)=>model.local===true&&model.artifactIdentity===limits.productiveArtifactIdentity?'local':model.local===false&&model.id===limits.productiveRemoteModelId&&model.artifactIdentity===limits.productiveRemoteArtifactIdentity?'remote':undefined;
  const sides=[candidate,...active].map(side);return sides.every(Boolean)&&new Set(sides).size===sides.length;
 }
 return candidate.artifactIdentity===limits.productiveArtifactIdentity&&active.every(model=>model.artifactIdentity===limits.productiveArtifactIdentity);
}
