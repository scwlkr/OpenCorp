import { afterEach,expect,it } from 'vitest';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CompanyStore } from '../src/storage/store.js';
import { CorporateBroker } from '../src/tools/broker.js';
import { provisionFailureCode, assertProvisionAlongside, acquireProvisionQualificationLock, setupProvisionFixture,verifyProvisionReceipts,assertProvisionSourceDrained } from '../scripts/verify-groq-provision.js';
import type { RuntimeModel } from '../src/runtime/types.js';
const roots:string[]=[],stores:CompanyStore[]=[];afterEach(async()=>{for(const s of stores.splice(0))s.close();for(const r of roots.splice(0))await rm(r,{recursive:true,force:true});});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'groq-provision-test-'));roots.push(root);const source=new CompanyStore(root);stores.push(source);source.bootstrap();
 const owner={kind:'owner'} as const,ceo=source.list('employees').find(e=>source.level(e.id)==='ceo')!,department=source.command(owner,{type:'department.create',name:'Fixture department',managerId:ceo.id,responsibilities:'Useful staffing'}),position=source.command(owner,{type:'position.create',title:'Fixture specialist',level:'worker',departmentId:department.id,responsibilities:'Useful work'});
 const content='---\nlicense: MIT\n---\n# Useful compatible source',license='MIT License\nPermission is hereby granted, free of charge',hash=(s:string)=>createHash('sha256').update(s).digest('hex'),id=hash('source'),directory=join(root,'skills/vendor',id);await mkdir(directory,{recursive:true});await writeFile(join(directory,'SOURCE.md'),content);await writeFile(join(directory,'LICENSE'),license);
 source.put('experiences',{id,kind:'skill-source',sha256:hash(content),licenseHash:hash(license),sourcePath:join(directory,'SOURCE.md'),repository:'fixture/source',commit:'a'.repeat(40)});
 const req=source.put('experiences',{kind:'requisition',status:'open',positionId:position.id,departmentId:department.id,departmentManagerId:ceo.id,homeManagerId:ceo.id,recruiterId:ceo.id,firstWork:'Inspect staffing'}),candidate=source.put('experiences',{kind:'candidate',name:'Synthetic fixture candidate',status:'approved',version:1,requisitionId:req.id,sourceIds:[id],modelId:'groq:openai/gpt-oss-120b',role:'Inspect and report actual staffing records.',onboarding:'Read responsibilities',approval:{authorId:ceo.id,runId:'retained-approval'},authorship:{authorId:ceo.id,runId:'retained-author'}});
 const model={id:candidate.modelId,name:candidate.modelId,alias:candidate.modelId,provider:'groq',endpoint:'https://api.groq.com/openai/v1/chat/completions',local:false,available:true,capabilities:['tools'],freeOnly:true,artifactIdentity:'a'.repeat(64),tierVerification:'owner-tier-audit',tierVerifiedAt:new Date(Date.now()-1000).toISOString(),tierExpiresAt:new Date(Date.now()+600000).toISOString()} as RuntimeModel;
 const privateRoot=await mkdtemp(join(tmpdir(),'groq-provision-copy-'));roots.push(privateRoot);const target=new CompanyStore(privateRoot);stores.push(target);return {source,target,candidate,model,root};
}
it('copies approved evidence without altering source; real domain provisioning and handoff are required',async()=>{
 const f=await fixture(),snapshot=f.source.snapshot(),before=JSON.stringify(snapshot),run=await setupProvisionFixture(f.target,snapshot,f.root,f.candidate.id,f.model,join(f.target.dataRoot,'workspace')),broker=new CorporateBroker(f.target,f.target.dataRoot),actor={kind:'employee',employeeId:run.run.employeeId,runId:run.run.id,policyRevision:run.run.policyRevision} as const,count=f.target.list('employees').length;
 expect(broker.provisionPrompt(actor)).toBeDefined();expect(()=>verifyProvisionReceipts(f.target,run,count)).toThrow();
 const employee=await broker.call(actor,'company_command',{command:{type:'recruitment.provision',candidateId:f.candidate.id}});expect(()=>verifyProvisionReceipts(f.target,run,count)).toThrow();
 await broker.call(actor,'send_message',{recipientId:run.requisition.homeManagerId,content:`Employee ${employee.id} provisioned. Read responsibilities and inspect staffing.`});expect(verifyProvisionReceipts(f.target,run,count)).toMatchObject({candidateId:f.candidate.id,rolePreserved:true,approvalPreserved:true});expect(JSON.stringify(f.source.snapshot())).toBe(before);await broker.cancel();
});
it('rejects already hired candidates instead of resetting retained approval state',async()=>{const f=await fixture();f.source.update('experiences',f.candidate.id,{status:'hired'});await expect(setProvision(f)).rejects.toThrow(/approved/);expect(f.target.list('employees')).toHaveLength(0);});
it('rejects restricted source bytes before inference or provision',async()=>{const f=await fixture(),source=f.source.need('experiences',f.candidate.sourceIds[0]);const restricted='---\nlicense: MIT + Commons Clause\n---';await writeFile(source.sourcePath,restricted);f.source.update('experiences',source.id,{sha256:createHash('sha256').update(restricted).digest('hex')});await expect(setProvision(f)).rejects.toThrow();expect(f.target.list('experiences').some(r=>r.kind==='candidate')).toBe(false);});
const setProvision=(f:Awaited<ReturnType<typeof fixture>>)=>setupProvisionFixture(f.target,f.source.snapshot(),f.root,f.candidate.id,f.model,join(f.target.dataRoot,'workspace'));

it('requires fully drained production runs and owned runtime pools before isolated work',()=>{
 const safe={company:{state:'paused'},runs:[{status:'succeeded'}],resources:{runtime:{ollama:{running:false},microOllama:{running:false},activeRuns:[]}}};expect(()=>assertProvisionSourceDrained(safe)).not.toThrow();
 for(const status of ['running','cancelling','queued','uncertain'])expect(()=>assertProvisionSourceDrained({...safe,runs:[{status}]})).toThrow();
 for(const field of ['ollama','microOllama'])expect(()=>assertProvisionSourceDrained({...safe,resources:{runtime:{...safe.resources.runtime,[field]:{running:true}}}})).toThrow();
 expect(()=>assertProvisionSourceDrained({...safe,resources:{runtime:{...safe.resources.runtime,activeRuns:['active']}}})).toThrow();expect(()=>assertProvisionSourceDrained({...safe,company:{state:'running'}})).toThrow();
});

it('admits remote-only qualification alongside local/Gemini work but refuses Groq contention or host pressure',()=>{
 const state={company:{state:'running'},employees:[{status:'active',modelId:'gemini:fixture'},{status:'active',modelId:'qwen-main-48k'}],runs:[{status:'running',modelId:'qwen-main-48k'}]},providers=[{id:'groq',activeRuns:0,testing:false}],memory={free:3*1024**3,total:64*1024**3,pressure:'normal' as const};
 expect(()=>assertProvisionAlongside(state,providers,memory)).not.toThrow();
 expect(()=>assertProvisionAlongside({...state,employees:[{status:'active',modelId:'groq:fixture'}]},providers,memory)).toThrow(/selection/);
 expect(()=>assertProvisionAlongside({...state,runs:[{status:'uncertain',modelId:'groq:fixture'}]},providers,memory)).toThrow(/run/);
 expect(()=>assertProvisionAlongside(state,[{id:'groq',activeRuns:0,testing:true}],memory)).toThrow(/busy/);
 expect(()=>assertProvisionAlongside(state,providers,{...memory,pressure:'elevated'})).toThrow(/pressure/);
 expect(()=>assertProvisionAlongside(state,providers,{...memory,free:1024})).toThrow(/reserve/);
});
it('allows only one qualification holder and releases only its own lock',async()=>{
 const root=await mkdtemp(join(tmpdir(),'groq-qualification-lock-'));roots.push(root);await mkdir(join(root,'runtime'));const release=await acquireProvisionQualificationLock(root);await expect(acquireProvisionQualificationLock(root)).rejects.toThrow();await release();await (await acquireProvisionQualificationLock(root))();
});

it('retains only known admission failure codes, never raw exception contents',()=>{
 expect(provisionFailureCode(new Error('PRIVATE_UPSTREAM_BODY'))).toBe('qualification_failed');
 try{assertProvisionAlongside({company:{state:'running'},employees:[],runs:[]},[{id:'groq',activeRuns:0}],{free:3*1024**3,total:64*1024**3,pressure:'elevated'});}catch(error){expect(provisionFailureCode(error)).toBe('host_pressure_not_normal');}
});
