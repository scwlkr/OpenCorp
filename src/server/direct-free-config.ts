import { createHash } from 'node:crypto';
import { directFreeProvider, validZaiPricingAudit } from '../core/inference-policy.js';
import { constants,closeSync,fstatSync,lstatSync,openSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeOptions } from '../runtime/types.js';

/** Parent-only callbacks. Audit/key material never enters serializable runtime
 * configuration. The adapter validates the fresh audit before each dispatch. */
export function directFreeConfig(dataRoot:string,modelIds:string[]):RuntimeOptions['directFree'] {
 if(!modelIds.every(id=>directFreeProvider(id)))throw new Error('Direct free configuration requires exact namespaced model IDs');
 const directory=join(dataRoot,'credentials');
 const result:NonNullable<RuntimeOptions['directFree']>={};
 for(const provider of ['groq','gemini','zai'] as const){
  const configPath=join(directory,`${provider}-free.json`),keyPath=join(directory,`${provider}-free.key`);
  try{lstatSync(configPath);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw new Error('Direct free-provider configuration unavailable');}
  const readPrivate=(path:string,maximumBytes:number)=>{
   const directoryStat=lstatSync(directory);
   if(!directoryStat.isDirectory()||directoryStat.isSymbolicLink()||(directoryStat.mode&0o7777)!==0o700||process.getuid&&directoryStat.uid!==process.getuid())throw new Error();
   const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
   try{
    const stat=fstatSync(fd);
    if(!stat.isFile()||(stat.mode&0o7777)!==0o600||stat.size>maximumBytes||process.getuid&&stat.uid!==process.getuid())throw new Error();
    return readFileSync(fd,'utf8');
   }finally{closeSync(fd);}
  };
  result[provider]={rateBudgetPath:join(dataRoot,'runtime','provider-rate-budgets',`${provider}.json`),modelIds:modelIds.filter(id=>directFreeProvider(id)===provider),readCredentials:async()=>{
   try{
    const audit=JSON.parse(readPrivate(configPath,8192));
    const apiKey=readPrivate(keyPath,4096).trim();
    if(!apiKey||/[\r\n]/.test(apiKey))throw new Error();
    const keys=['provider','accountId','billingEnabled','credentialSha256','modelIds','verifiedAt','expiresAt','evidence',...(provider==='zai'?['pricing']:[])];
    if(!audit||typeof audit!=='object'||Array.isArray(audit)||Object.keys(audit).length!==keys.length||Object.keys(audit).some(key=>!keys.includes(key))
      ||audit.provider!==provider||audit.billingEnabled!==false||typeof audit.accountId!=='string'||!audit.accountId.trim()||audit.accountId.length>200||/[\r\n]/.test(audit.accountId)
      ||typeof audit.evidence!=='string'||!audit.evidence.trim()||audit.evidence.length>2000
      ||!Array.isArray(audit.modelIds)||!audit.modelIds.length||audit.modelIds.length>32||new Set(audit.modelIds).size!==audit.modelIds.length||audit.modelIds.some((id:unknown)=>directFreeProvider(id)!==provider)
      ||audit.credentialSha256!==createHash('sha256').update(apiKey).digest('hex')
      ||typeof audit.verifiedAt!=='string'||typeof audit.expiresAt!=='string')throw new Error();
    const verified=Date.parse(audit.verifiedAt),expires=Date.parse(audit.expiresAt),now=Date.now();
    if(!Number.isFinite(verified)||!Number.isFinite(expires)||verified>now||expires<=now||expires<=verified||expires-verified>86400000)throw new Error();
    if(provider==='zai'&&!validZaiPricingAudit(audit.pricing,now))throw new Error();
    return {apiKey,audit};
   }catch{throw new Error('Direct free-provider private credential or audit unavailable');}
  }};
 }
 return Object.keys(result).length?result:undefined;
}
