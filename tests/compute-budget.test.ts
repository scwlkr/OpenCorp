import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyStore } from '../src/storage/store.js';
import { EmailTransport, type EmailApi } from '../src/server/email.js';
import { paidCompute, type ComputeRoute } from '../src/tools/paid-compute.js';
import { CorporateBroker } from '../src/tools/broker.js';
import type { Actor, Assignment } from '../src/core/types.js';
let root:string,store:CompanyStore,actor:Extract<Actor,{kind:'employee'}>,work:Assignment,proposal:any;
const model='gpt-4.1-mini-2025-04-14',owner={kind:'owner'} as const;
const emailConfig={mailbox:'ceo@example.com',owner:'owner@example.net',endpoint:'https://synthetic.example.com',token:'SYNTHETIC_TEST_TOKEN_NOT_A_REAL_SECRET',replyKey:'a'.repeat(64),dailyHourUtc:23};
const route=():ComputeRoute=>({provider:'openai',model,contextTokens:1047576,maxOutputTokens:1024,inputMicrousdPerToken:1,outputMicrousdPerToken:2,verifiedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),source:'https://developers.openai.com/api/docs/models/gpt-4.1-mini',allChargesIncluded:true});
const access=()=>({route:route(),apiKey:'SYNTHETIC_TEST_KEY_NOT_A_REAL_SECRET'});
const args=(key:string)=>({proposalId:proposal.id,provider:'openai',model,prompt:'Review this public release checklist.',dedupeKey:key,maxOutputTokens:1024});
const reply=()=>new Response(JSON.stringify({id:'synthetic-provider-receipt',choices:[{message:{content:'Check restoration before deployment.'}}],usage:{prompt_tokens:30,completion_tokens:10}}));
const signal=()=>new AbortController().signal;
beforeEach(()=>{
 root=mkdtempSync(join(tmpdir(),'opencorp-compute-'));store=new CompanyStore(root);store.bootstrap();store.command(owner,{type:'control',action:'start'});
 const employee=store.list('employees').find(e=>store.level(e.id)==='ceo')!;
 work=store.command(owner,{type:'assignment.create',employeeId:employee.id,title:'Review public release checklist',instructions:'Review the public release checklist for missing recovery steps.',acceptance:['Useful review of the public checklist'],dataClass:'public'});
 const run=store.put('runs',{employeeId:employee.id,assignmentId:work.id,status:'running',modelId:employee.modelId,policyRevision:store.policy.revision,tokenRevoked:false});
 actor={kind:'employee',employeeId:employee.id,runId:run.id,policyRevision:store.policy.revision};
 new EmailTransport(store,emailConfig,vi.fn());
 proposal=store.command(owner,{type:'owner.propose',title:'Bounded checklist review',content:'Named public checklist review; OpenAI GPT-4.1 mini. Expected useful recovery suggestions. Estimate based on public text token usage, uncertain latency. Free alternative: existing local Qwen.',proposalScope:'One public checklist assignment only.',expiresAt:new Date(Date.now()+3600000).toISOString(),channel:'email',computeGrant:{ceilingMicrousd:1600000,assignmentIds:[work.id],routes:[{provider:'openai',model}]}});
});
afterEach(()=>{if(store.db.open)store.close();rmSync(root,{recursive:true,force:true});});
async function approve(){
 let replyTo='';const api=vi.fn<EmailApi>().mockImplementation(async(path,body)=>path==='profile'?{mailbox:emailConfig.mailbox,owner:emailConfig.owner}:path==='send'?(replyTo=(body as {replyTo:string}).replyTo,{id:'proposal-receipt'}):{messages:[]});
 const transport=new EmailTransport(store,emailConfig,api);await transport.tick();
 api.mockImplementation(async path=>path==='inbox'?{messages:[{id:'b'.repeat(64),from:emailConfig.owner,to:replyTo,text:`APPROVE ${proposal.id}`}]}:{ok:true});await transport.tick();
 expect(store.need('attention',proposal.id).disposition?.decision).toBe('approved');
}
it('binds authenticated email approval to dispatch and prevents concurrent overcommit across connections',async()=>{
 const transport=vi.fn<typeof fetch>().mockResolvedValue(reply());
 await expect(paidCompute(store,actor,args('before'),signal(),access,transport)).rejects.toThrow('approval');expect(transport).not.toHaveBeenCalled();
 await approve();let finish!:(r:Response)=>void;transport.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const first=paidCompute(store,actor,args('first'),signal(),access,transport),other=new CompanyStore(root);
 try{await expect(paidCompute(other,actor,args('second'),signal(),access,transport)).rejects.toThrow('ceiling');expect(transport).toHaveBeenCalledOnce();}finally{other.close();}
 finish(reply());const receipt=await first;expect(receipt.result).toMatchObject({text:'Check restoration before deployment.',observedUpperMicrousd:50});
 expect(receipt.reservedMicrousd).toBe(1049624);expect(store.policy.spendingLimit).toBe(0);
 await expect(paidCompute(store,actor,args('first'),signal(),access,transport)).resolves.toMatchObject({reused:true});expect(transport).toHaveBeenCalledOnce();
 await expect(paidCompute(store,actor,{...args('first'),prompt:'Different work'},signal(),access,transport)).rejects.toThrow('different effect');
});
it.each(['expired','changed-work','wrong-route','private','paused','revoked','stale-policy'])('denies %s after approval without a transport call',async mode=>{
 await approve();const transport=vi.fn<typeof fetch>();
 if(mode==='expired')store.update('attention',proposal.id,{expiresAt:new Date(0).toISOString()});
 if(mode==='changed-work')store.update('assignments',work.id,{instructions:'Do something else'});
 if(mode==='private')store.update('assignments',work.id,{dataClass:'confidential'});
 if(mode==='paused')store.command(owner,{type:'control',action:'stop'});
 if(mode==='revoked')store.update('runs',actor.runId,{tokenRevoked:true});
 if(mode==='stale-policy')store.update('policy',store.policy.id,{revision:store.policy.revision+1});
 await expect(paidCompute(store,actor,{...args(mode),...(mode==='wrong-route'?{model:'gpt-4.1-2025-04-14'}:{})},signal(),access,transport)).rejects.toThrow();expect(transport).not.toHaveBeenCalled();
});
it('retains uncertain reservations and exact approval through database restart and older backup restore',async()=>{
 const backup=store.backup();await approve();const transport=vi.fn<typeof fetch>().mockRejectedValue(new Error('synthetic disconnected response'));
 await expect(paidCompute(store,actor,args('uncertain'),signal(),access,transport)).rejects.toThrow('uncertain');
 store.close();store=new CompanyStore(root);
 await expect(paidCompute(store,actor,args('uncertain'),signal(),access,transport)).resolves.toMatchObject({reused:true,status:'uncertain'});
 await expect(paidCompute(store,actor,args('new-key'),signal(),access,transport)).rejects.toThrow('ceiling');expect(transport).toHaveBeenCalledOnce();
 store.update('company',store.company.id,{state:'paused'});store.restore(backup.path);
 expect(store.need('attention',proposal.id).disposition.decision).toBe('approved');expect(store.list('actions').find(a=>a.kind==='compute.infer')).toMatchObject({status:'uncertain',reservedMicrousd:1049624});
});
it.each(['no-audit','stale-price','unknown-fees','invalid-bound','missing-usage'])('handles %s without treating unknown charges as free',async mode=>{
 await approve();const transport=vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({id:'synthetic-receipt',choices:[{message:{content:'Result'}}]})));
 const read=()=>{if(mode==='no-audit')throw new Error('No protected audit');return {...access(),route:{...route(),...(mode==='stale-price'?{expiresAt:new Date(0).toISOString()}:{ }),...(mode==='unknown-fees'?{allChargesIncluded:false}:{ }),...(mode==='invalid-bound'?{contextTokens:100}:{ })}} as ReturnType<typeof access>;};
 if(mode==='missing-usage'){const result=await paidCompute(store,actor,args(mode),signal(),read,transport);expect(result.result).toMatchObject({observedUpperMicrousd:null});expect(result.reservedMicrousd).toBe(1049624);}
 else{await expect(paidCompute(store,actor,args(mode),signal(),read,transport)).rejects.toThrow();expect(transport).not.toHaveBeenCalled();expect(store.list('actions').some(a=>a.kind==='compute.infer')).toBe(false);}
});
it('exposes the broker boundary but cannot dispatch without protected configuration or authorize through generic commands',async()=>{
 await approve();const broker=new CorporateBroker(store,root);
 await expect(broker.call(actor,'compute_request',args('unconfigured'))).rejects.toThrow('unavailable');
 expect(store.list('actions').some(a=>a.kind==='compute.infer')).toBe(false);
 expect(()=>store.command(actor,{type:'policy.update',spendingLimit:100})).toThrow();
});
it('refuses stale pricing after waiting for a concurrent database writer',async()=>{
 await approve();
 const {spawn}=await import('node:child_process');
 // A separate process owns the SQLite write lock while the service waits for admission.
 const child=spawn(process.execPath,['--input-type=module','-e',`import Database from 'better-sqlite3';const db=new Database(process.argv[1]);db.exec('BEGIN IMMEDIATE');process.stdout.write('locked\\n');setTimeout(()=>{db.exec('COMMIT');db.close();},350);`,join(root,'company.sqlite')],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});
 await new Promise<void>((resolve,reject)=>{child.stdout.once('data',()=>resolve());child.once('error',reject);child.once('exit',code=>{if(code)reject(new Error('Synthetic lock holder failed'));});});
 const transport=vi.fn<typeof fetch>(),read=()=>({...access(),route:{...route(),expiresAt:new Date(Date.now()+100).toISOString()}});
 try{await expect(paidCompute(store,actor,args('lock-expiry'),signal(),read,transport)).rejects.toThrow('pricing');expect(transport).not.toHaveBeenCalled();expect(store.list('actions').some(a=>a.kind==='compute.infer')).toBe(false);}finally{child.kill();}
});
