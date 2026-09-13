import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, writeFile, open, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { serve } from '@hono/node-server';
import { OwnerClient } from '../src/cli/client.js';
import { assertRetainedSourceLicense } from '../src/core/source-license.js';
import { CompanyStore } from '../src/storage/store.js';
import { CorporateBroker } from '../src/tools/broker.js';
import { workerApp } from '../src/server/app.js';
import { directFreeConfig } from '../src/server/direct-free-config.js';
import { DirectFree } from '../src/runtime/direct-free.js';
import { LocalRuntime } from '../src/runtime/index.js';
import { observeHostMemory, type HostMemory } from '../src/runtime/resource-budget.js';
import type { RuntimeModel } from '../src/runtime/types.js';
const owner={kind:'owner'} as const,modelId='groq:openai/gpt-oss-120b';

/** Copy real approved evidence; never invent approval, source inspection or a hire. */
export async function setupProvisionFixture(store:CompanyStore,snapshot:any,sourceRoot:string,candidateId:string,model:RuntimeModel,workspace:string){
 const candidate=snapshot.experiences.find((r:any)=>r.id===candidateId&&r.kind==='candidate');assert.equal(candidate?.status,'approved','Requires a currently approved, unprovisioned candidate');
 const requisition=snapshot.experiences.find((r:any)=>r.id===candidate.requisitionId&&r.kind==='requisition');assert.equal(requisition?.status,'open');
 const recruiter=snapshot.employees.find((e:any)=>e.id===requisition.recruiterId&&e.status==='active');assert.ok(recruiter);assert.ok(candidate.approval&&candidate.authorship&&candidate.sourceIds?.length);
 store.put('company',{...snapshot.company,id:randomUUID(),state:'stopped',qualification:true});
 store.put('policy',{...snapshot.policy,id:randomUUID(),companyId:store.company.id,maxInference:1,maxProductiveTurns:1,qualification:true});
 for(const table of ['departments','positions','employees','appointments','models'] as const)for(const record of snapshot[table])store.put(table,{...record,qualificationCopy:true});
 for(const sourceId of candidate.sourceIds){
  const source=snapshot.experiences.find((r:any)=>r.id===sourceId&&r.kind==='skill-source');assert.ok(source);
  assertRetainedSourceLicense({dataRoot:sourceRoot} as CompanyStore,source);
  const directory=join(store.dataRoot,'skills/vendor',source.id);await mkdir(directory,{recursive:true});
  await copyFile(source.sourcePath,join(directory,'SOURCE.md'));await copyFile(join(sourceRoot,'skills/vendor',source.id,'LICENSE'),join(directory,'LICENSE'));
  const copied=store.put('experiences',{...source,sourcePath:join(directory,'SOURCE.md'),qualificationCopy:true});assertRetainedSourceLicense(store,copied);
 }
 store.vault.initialize();
 store.put('experiences',{...requisition,qualificationCopy:true});store.put('experiences',{...candidate,qualificationCopy:true});store.put('models',model);
 store.command(owner,{type:'policy.update',directFreeModels:[model.id]});
 store.command(owner,{type:'employee.model',employeeId:recruiter.id,modelId:model.id,rationale:'Private provisioning qualification only; production identity remains unchanged.'});
 const retained=snapshot.assignments.find((a:any)=>a.schedulerKey===`formation:provision:${candidate.id}`&&a.employeeId===recruiter.id);
 const task=store.command(owner,{type:'assignment.create',employeeId:recruiter.id,supervisorId:requisition.homeManagerId,kind:'management',title:retained?.title??'Private approved candidate provisioning qualification',instructions:retained?.instructions??`Provision manager-approved candidate ${candidate.id} with recruitment.provision. Retain its receipt and notify home manager ${requisition.homeManagerId} of the tailored onboarding and firstWork from requisition ${requisition.id}. Do not claim manager onboarding acceptance.`,acceptance:retained?.acceptance??['Actual approved candidate provision receipt and attributed home-manager handoff retained.']});
 store.update('assignments',task.id,{schedulerKey:`formation:provision:${candidate.id}`,payload:{formation:true}});store.command(owner,{type:'control',action:'start'});
 const run=store.claimNext({assignmentId:task.id,workspace});assert.ok(run);return {candidate,requisition,recruiter,task,run};
}
export function verifyProvisionReceipts(store:CompanyStore,fixture:Awaited<ReturnType<typeof setupProvisionFixture>>,beforeEmployees:number){
 const {candidate,requisition,run}=fixture,retained=store.need('experiences',candidate.id),hired=store.need('employees',retained.employeeId);
 assert.equal(retained.status,'hired');assert.equal(store.list('employees').length,beforeEmployees+1);assert.equal(hired.positionId,requisition.positionId);assert.equal(hired.homeManagerId,requisition.homeManagerId);assert.equal(hired.role,candidate.role);assert.deepEqual(retained.approval,candidate.approval);
 assert.ok(store.need('runs',run.id).corporateCommands?.some((c:any)=>c.type==='recruitment.provision'));
 const handoff=store.list('messages').find(m=>m.runId===run.id&&m.senderId===run.employeeId&&m.recipientId===requisition.homeManagerId&&m.projectId==null&&m.content?.trim());assert.ok(handoff,'Actual attributed internal handoff required');
 assert.ok(handoff.content.includes(hired.id)||handoff.content.includes(candidate.name),'Handoff must identify the actual hire');
 return {employeeId:hired.id,candidateId:candidate.id,runId:run.id,handoffId:handoff.id,rolePreserved:true,approvalPreserved:true};
}
export function assertProvisionSourceDrained(snapshot:any){
 assert.ok(['stopped','paused'].includes(snapshot.company.state),'Production company must already be stopped');
 assert.ok(!snapshot.runs.some((r:any)=>['running','cancelling','queued','uncertain'].includes(r.status)),'Production runs are not drained');
 assert.equal(snapshot.resources.runtime.ollama.running,false);assert.equal(snapshot.resources.runtime.microOllama.running,false);assert.equal(snapshot.resources.runtime.activeRuns.length,0);
}
class ProvisionAdmissionError extends Error {constructor(readonly code:string){super(code);}}
export function provisionFailureCode(error:unknown):string{return error instanceof ProvisionAdmissionError?error.code:'qualification_failed';}
export function assertProvisionAlongside(snapshot:any,providers:any[],memory:HostMemory){
 const require=(okay:boolean,code:string)=>{if(!okay)throw new ProvisionAdmissionError(code);};
 require(['running','paused','stopped'].includes(snapshot.company.state),'company_state_unknown');
 require(!snapshot.employees.some((e:any)=>e.status==='active'&&e.modelId?.startsWith('groq:')),'production_groq_selection');
 require(!snapshot.runs.some((r:any)=>['running','cancelling','queued','uncertain'].includes(r.status)&&r.modelId?.startsWith('groq:')),'production_groq_run');
 const provider=providers.find(p=>p.id==='groq');require(!!provider&&provider.activeRuns===0&&!provider.testing,'production_groq_busy_or_unknown');
 require(memory.pressure==='normal','host_pressure_not_normal');require((memory.available??memory.free)>=2*1024**3,'host_reserve_below_two_gib');
}
export async function acquireProvisionQualificationLock(source:string){
 const path=join(source,'runtime','groq-provision-qualification.lock'),handle=await open(path,'wx',0o600);
 return async()=>{await handle.close();await unlink(path);};
}
async function main(){
 const {values}=parseArgs({strict:true,options:{'candidate-id':{type:'string'},'company-drained':{type:'boolean'},'alongside-company':{type:'boolean'},help:{type:'boolean'}}});
 if(values.help){console.log('verify-groq-provision.ts --candidate-id ID (--company-drained | --alongside-company)\nPrivate copied approved-candidate provisioning only; no production company writes. Shared provider quota reservations retained.');return;}
 assert.ok(values['candidate-id']&&!!values['company-drained']!==!!values['alongside-company'],'Requires exact candidate and one admission mode');
 const source=join(homedir(),'.local/share/opencorp'),client=new OwnerClient(source),snapshot=await client.state();
 const samples:any[]=[];const observe=async()=>{const began=Date.now();let state:any,status:any;try{[state,status]=await Promise.all([client.state(AbortSignal.timeout(5000)),client.request<any>('providers',undefined,AbortSignal.timeout(5000))]);}catch{throw new ProvisionAdmissionError('owner_api_observation_failed');}const memory=observeHostMemory(),sample={at:new Date().toISOString(),ownerLatencyMs:Date.now()-began,memory};samples.push(sample);if(sample.ownerLatencyMs>=5000)throw new ProvisionAdmissionError('owner_api_observation_slow');assertProvisionAlongside(state,status.providers,memory);};
 if(values['alongside-company'])await observe();else assertProvisionSourceDrained(snapshot);
 const direct=directFreeConfig(source,[modelId]);assert.ok(direct?.groq);
 const root=await mkdtemp(join(homedir(),'.local/share/opencorp-groq-provision-')),workspace=join(root,'workspace');await mkdir(workspace);
 const store=new CompanyStore(root),broker=new CorporateBroker(store,root),controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),900000),stop=()=>controller.abort();process.on('SIGINT',stop);process.on('SIGTERM',stop);
 const report:any={root,modelId,passed:false,copiedRealEvidence:true,productionCompanyWrites:false,sharedProviderRateReservations:true,outputLimit:1024,deadlineMs:900000};
 const runtime=new LocalRuntime({dataRoot:root,directFree:direct,onEvent:e=>{if(e.type==='runtime.inference.failed'||e.type==='runtime.resource.refused')controller.abort();}});
 let releaseLock:(()=>Promise<void>)|undefined,monitor:ReturnType<typeof setInterval>|undefined,observation:Promise<void>|undefined;
 let host='',fixture:Awaited<ReturnType<typeof setupProvisionFixture>>|undefined,heartbeat:ReturnType<typeof setInterval>|undefined;
 const server=serve({fetch:workerApp(broker,()=>host).fetch,hostname:'127.0.0.1',port:0});let stage='worker-server';
 try{
  await new Promise<void>(resolve=>server.once('listening',resolve));
  stage='qualification-lock';releaseLock=await acquireProvisionQualificationLock(source);
  report.admissionMode=values['alongside-company']?'alongside-company':'company-drained';report.quietHost=false;report.hostSamples=samples;
  if(values['alongside-company']){stage='alongside-admission';await observe();monitor=setInterval(()=>{if(observation)return;observation=observe().catch(error=>{report.observationFailureCode=provisionFailureCode(error);report.resourceAborted=true;controller.abort();}).finally(()=>{observation=undefined;});},5000);}
  const address=server.address();assert.ok(address&&typeof address!=='string');host=`127.0.0.1:${address.port}`;
  stage='model-eligibility';const model=(await new DirectFree('groq',direct.groq).models(controller.signal)).find(m=>m.id===modelId);assert.ok(model);
  stage='fixture-copy';fixture=await setupProvisionFixture(store,snapshot,source,values['candidate-id'],model,workspace);const {run}=fixture,before=store.list('employees').length;
  stage='trusted-prompt';const actor={kind:'employee',employeeId:run.employeeId,runId:run.id,policyRevision:run.policyRevision} as const,packet=broker.provisionPrompt(actor);assert.ok(packet);
  report.knownRequestCharacters=packet.system.length+packet.prompt.length+JSON.stringify(broker.toolsFor(actor)).length;report.requestTokenCount='Unknown until provider response; character count is not token qualification.';
  heartbeat=setInterval(()=>store.heartbeat(run.id),30000);stage='inference';
  const result=await runtime.execute({runId:run.id,employeeId:run.employeeId,modelId,workspace,directFreeModels:[modelId],contextTokens:32768,corporateOnly:true,provisionOnly:true,workload:'productive',timeoutMs:900000,system:packet.system,prompt:packet.prompt,signal:controller.signal,brokerUrl:`http://${host}/mcp/${run.id}`,token:broker.mint(run),onSession:id=>{store.bindSession(run.id,id,workspace);}});
  controller.signal.throwIfAborted();stage='receipt-verification';assert.equal(result.artifactIdentity,model.artifactIdentity);assert.equal(result.completion.outputLimit,1024);assert.equal(result.completion.exhausted,false);assert.ok(result.usage.requests>0);
  const binding=JSON.parse(await readFile(join(root,'runtime/employees',run.id,'binding.json'),'utf8'));assert.equal(binding.model.id,model.id);assert.equal(binding.model.artifactIdentity,model.artifactIdentity);
  report.receipts=verifyProvisionReceipts(store,fixture,before);store.finishRun(run.id,{status:'succeeded',modelIdentity:result.artifactIdentity,usage:result.usage,managementResult:{passed:true,summary:'Private actual provision and handoff receipts verified.'}});report.usage=result.usage;if(values['alongside-company']){stage='final-alongside-admission';await observe();}controller.signal.throwIfAborted();report.passed=true;
 }catch(error){report.failedStage=stage;report.error=controller.signal.aborted?'aborted':provisionFailureCode(error);process.exitCode=1;if(fixture)store.finishRun(fixture.run.id,{status:'failed',error:report.error});}
 finally{if(monitor)clearInterval(monitor);if(observation)await observation;if(report.resourceAborted){report.passed=false;process.exitCode=1;}clearTimeout(timer);if(heartbeat)clearInterval(heartbeat);controller.abort();try{await runtime.stop();await broker.cancel();}catch{report.passed=false;report.stopError='cleanup_unconfirmed';process.exitCode=1;}await new Promise<void>(resolve=>server.close(()=>resolve()));await writeFile(join(root,'qualification.json'),JSON.stringify(report,null,2),{mode:0o600});store.close();if(releaseLock&&!report.stopError)await releaseLock();process.off('SIGINT',stop);process.off('SIGTERM',stop);console.log(JSON.stringify({root,passed:report.passed,failedStage:report.failedStage}));}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
