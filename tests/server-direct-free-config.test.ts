import { createHash } from 'node:crypto';
import { chmodSync,mkdirSync,mkdtempSync,rmSync,symlinkSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach,expect,it } from 'vitest';
import { directFreeConfig } from '../src/server/direct-free-config.js';
const roots:string[]=[];
afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));
function fixture(provider:'groq'|'gemini'='groq'){
 const root=mkdtempSync(join(tmpdir(),'opencorp-direct-config-'));roots.push(root);
 const directory=join(root,'credentials');mkdirSync(directory,{mode:0o700});
 const config=join(directory,`${provider}-free.json`),key=join(directory,`${provider}-free.key`),modelId=`${provider}:fixture-model`;
 const audit={provider,accountId:'synthetic-account',billingEnabled:false,modelIds:[modelId],credentialSha256:createHash('sha256').update('FIXTURE_KEY').digest('hex'),verifiedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),evidence:'Fixture Owner tier observation, not live provider verification'};
 writeFileSync(config,JSON.stringify(audit),{mode:0o600});
 return {root,directory,config,key,modelId,audit};
}
it.each(['groq','gemini'] as const)('defers %s key reads and keeps callback available with empty Owner selection',async provider=>{
 const f=fixture(provider),options=directFreeConfig(f.root,[])![provider]!;
 expect(options.modelIds).toEqual([]);expect(JSON.stringify(options)).not.toContain('readCredentials');
 await expect(options.readCredentials()).rejects.toThrow('private credential or audit unavailable');
 writeFileSync(f.key,'FIXTURE_KEY\n',{mode:0o600});expect(await options.readCredentials()).toEqual({apiKey:'FIXTURE_KEY',audit:f.audit});
 expect(JSON.stringify(options)).not.toContain('FIXTURE_KEY');
 const ids=[f.modelId,`${provider==='groq'?'gemini':'groq'}:other`],selected=directFreeConfig(f.root,ids)![provider]!;ids.push(`${provider}:later`);expect(selected.modelIds).toEqual([f.modelId]);
 rmSync(f.config);expect(directFreeConfig(f.root,[])).toBeUndefined();
 await expect(options.readCredentials()).rejects.toThrow('private credential or audit unavailable');
});
it.each(['key-mode','config-mode','directory-mode','key-link','config-link','directory-link'])('rejects %s on every dispatch',async kind=>{
 const f=fixture();writeFileSync(f.key,'FIXTURE_KEY',{mode:0o600});const options=directFreeConfig(f.root,[])!.groq!;
 if(kind.endsWith('mode'))chmodSync(kind==='key-mode'?f.key:kind==='config-mode'?f.config:f.directory,kind==='directory-mode'?0o755:0o644);
 if(kind==='key-link'||kind==='config-link'){const path=kind==='key-link'?f.key:f.config,target=join(f.root,'other');writeFileSync(target,kind==='key-link'?'FIXTURE_KEY':JSON.stringify(f.audit),{mode:0o600});rmSync(path);symlinkSync(target,path);}
 if(kind==='directory-link'){rmSync(f.directory,{recursive:true});const target=join(f.root,'other');mkdirSync(target,{mode:0o700});symlinkSync(target,f.directory);}
 await expect(options.readCredentials()).rejects.toThrow('private credential or audit unavailable');
});
it('rereads key-bound billing/tier evidence and rejects expired, wrong-provider or extended audits',async()=>{
 const f=fixture();writeFileSync(f.key,'FIXTURE_KEY',{mode:0o600});const options=directFreeConfig(f.root,[f.modelId])!.groq!;
 for(const patch of [{billingEnabled:true},{provider:'gemini'},{accountId:''},{credentialSha256:'0'.repeat(64)},{modelIds:['gemini:wrong']},{evidence:''},{verifiedAt:new Date(Date.now()+60000).toISOString()},{expiresAt:new Date(Date.now()-1).toISOString()},{expiresAt:new Date(Date.now()+86400001).toISOString()},{keyPath:'/arbitrary'}]){
  writeFileSync(f.config,JSON.stringify({...f.audit,...patch}));await expect(options.readCredentials()).rejects.toThrow('private credential or audit unavailable');
 }
 writeFileSync(f.config,JSON.stringify(f.audit));await expect(options.readCredentials()).resolves.toMatchObject({apiKey:'FIXTURE_KEY'});
 writeFileSync(f.key,'ROTATED_KEY');await expect(options.readCredentials()).rejects.toThrow('private credential or audit unavailable');
 expect(()=>directFreeConfig(f.root,['https://outside/model'])).toThrow('exact namespaced');
});

it('loads only exact Z.ai free model with fresh numeric zero pricing audit, never serialized keys',async()=>{
 const f=fixture();rmSync(f.config);const config=join(f.directory,'zai-free.json'),key=join(f.directory,'zai-free.key'),modelId='zai:glm-4.7-flash';
 const pricing={source:'https://docs.z.ai/guides/overview/pricing',modelId:'glm-4.7-flash',input:0,cachedInput:0,cachedInputStorage:0,output:0,verifiedAt:new Date(Date.now()-1000).toISOString()};const audit={...f.audit,provider:'zai',modelIds:[modelId],pricing};writeFileSync(config,JSON.stringify(audit),{mode:0o600});writeFileSync(key,'FIXTURE_KEY',{mode:0o600});
 const options=directFreeConfig(f.root,[])!.zai!;expect(options.modelIds).toEqual([]);await expect(options.readCredentials()).resolves.toMatchObject({audit});expect(JSON.stringify(options)).not.toMatch(/FIXTURE_KEY|credentialSha256|pricing/);
 for(const patch of [{pricing:undefined},{pricing:{...pricing,input:'0'}},{pricing:{...pricing,output:0.1}},{pricing:{...pricing,modelId:'glm-4.7'}},{pricing:{...pricing,source:'https://other.invalid'}},{pricing:{...pricing,verifiedAt:new Date(Date.now()-86400000).toISOString()}},{pricing:{...pricing,verifiedAt:new Date(Date.now()+60000).toISOString()}},{pricing:{...pricing,unknown:0}},{modelIds:['zai:glm-4.7']}]){writeFileSync(config,JSON.stringify({...audit,...patch}));await expect(options.readCredentials()).rejects.toThrow('private credential or audit unavailable');}
 for(const id of ['zai:glm-4.7','zai:glm-4.7-flashx','zai:glm-4.7-flash:free'])expect(()=>directFreeConfig(f.root,[id])).toThrow('exact namespaced');
});
