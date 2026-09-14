import { migrate } from '../src/storage/schema.js';
import Database from 'better-sqlite3';
import { selectLocalModel } from '../src/runtime/ollama.js';
import type { LocalModel } from '../src/runtime/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { CompanyStore } from '../src/storage/store.js';
import { corporateOnlyFormation, checkpointFinalResponseEligible, checkpointFinalResponseReady, governanceDispatchAllowed, managementOutcome, Scheduler } from '../src/scheduler/scheduler.js';
import { CorporateBroker } from '../src/tools/broker.js';
import type { LocalRuntime } from '../src/runtime/index.js';
import { RuntimeExecutionError, type RuntimeResult } from '../src/runtime/types.js';
import type { Actor, Assignment, EmployeeRun } from '../src/core/types.js';

let root:string,store:CompanyStore,assignment:Assignment,run:EmployeeRun,actor:Actor;
const owner={kind:'owner'} as const;
const model='wlkr-management-qwen3.8-27b-q4-k-m:latest';
beforeEach(()=>{
  root=mkdtempSync(join(tmpdir(),'opencorp-scheduler-'));store=new CompanyStore(root);store.bootstrap();store.put('models',{name:model,artifactIdentity:'local-digest',local:true,available:true,capabilities:['tools']});store.command(owner,{type:'control',action:'start'});
  const ceo=store.list('employees').find(e=>store.level(e.id)==='ceo')!;
  assignment=store.command(owner,{type:'assignment.create',employeeId:ceo.id,supervisorId:ceo.id,title:'Assess actual company state',instructions:'Choose useful work',acceptance:['Persist concrete decisions'],kind:'management'});
  run=store.put('runs',{employeeId:ceo.id,assignmentId:assignment.id,modelId:model,policyRevision:store.policy.revision,workspace:root,sessionId:'session',status:'running',attempt:1,leaseUntil:new Date(Date.now()+60000).toISOString(),heartbeatAt:new Date().toISOString(),tokenRevoked:false});actor={kind:'employee',employeeId:ceo.id,runId:run.id,policyRevision:store.policy.revision};
});

describe('unchanged organization reconciliation',()=>{
 let scheduler:Scheduler;
 const availability=vi.fn(async()=>undefined);
 beforeEach(()=>{
  availability.mockClear();
  scheduler=new Scheduler(store,{status:()=>({inferenceSlots:0}),providerAvailability:availability} as unknown as LocalRuntime,{} as CorporateBroker,'http://broker.invalid');
  Object.assign(scheduler,{initialized:true,recoveryComplete:true});
 });
 it('keeps dispatch checks live and rechecks writes, elapsed time and clock rollback',async()=>{
  let now=Date.now();const clock=vi.spyOn(Date,'now').mockImplementation(()=>now),reconcile=vi.spyOn(scheduler as any,'reconcileOrganization').mockImplementation(()=>{});
  try{
   await scheduler.tick();now+=1000;await scheduler.tick();expect(reconcile).toHaveBeenCalledTimes(1);expect(availability).toHaveBeenCalledTimes(2);
   store.update('assignments',assignment.id,{title:'Changed local obligation'});await scheduler.tick();expect(reconcile).toHaveBeenCalledTimes(2);
   const external=new Database(join(root,'company.sqlite'));
   try{external.prepare("UPDATE assignments SET data=json_set(data,'$.title',?) WHERE id=?").run('Changed external obligation',assignment.id);}finally{external.close();}
   await scheduler.tick();expect(reconcile).toHaveBeenCalledTimes(3);
   now+=4999;await scheduler.tick();expect(reconcile).toHaveBeenCalledTimes(3);
   now++;await scheduler.tick();expect(reconcile).toHaveBeenCalledTimes(4);
   now--;await scheduler.tick();expect(reconcile).toHaveBeenCalledTimes(5);
  }finally{clock.mockRestore();}
 });
 it('follows through on its own writes and never marks a failed pass reconciled',async()=>{
  const reconcile=vi.spyOn(scheduler as any,'reconcileOrganization').mockImplementation(()=>{});
  reconcile.mockImplementationOnce(()=>{store.update('assignments',assignment.id,{title:'Next phase must observe this'});});
  await scheduler.tick();await scheduler.tick();await scheduler.tick();expect(reconcile).toHaveBeenCalledTimes(2);
  store.update('assignments',assignment.id,{title:'Changed obligation before failure'});
  reconcile.mockImplementationOnce(()=>{throw new Error('Synthetic reconciliation failure');});
  await scheduler.tick();await scheduler.tick();expect(reconcile).toHaveBeenCalledTimes(4);
  expect(store.list('attention').some(item=>item.detail.includes('Synthetic reconciliation failure'))).toBe(true);
 });
});

describe('trusted checkpoint final-response eligibility',()=>{
  it.each(['conversation','implementation','review','assessment','management'])('does not enable final steering for ordinary %s work',kind=>{
    expect(checkpointFinalResponseEligible({...assignment,kind} as Assignment)).toBe(false);
  });
  it('requires the exact current-run recorded independent vote and current dispatch authority',()=>{
    const elder=store.list('employees').find(employee=>store.level(employee.id)==='elder')!;
    const decision=store.command(owner,{type:'decision.create',kind:'executive.review',subject:'Fixture independent judgment',rationale:'Observe actual checkpoint',payload:{employeeId:run.employeeId}});
    assignment=store.update('assignments',assignment.id,{employeeId:elder.id,supervisorId:elder.id,kind:'governance',status:'running',schedulerKey:`vote:${decision.id}:${elder.id}`,payload:{decisionId:decision.id}});
    run=store.update('runs',run.id,{employeeId:elder.id});actor={kind:'employee',employeeId:elder.id,runId:run.id,policyRevision:store.policy.revision};
    expect(checkpointFinalResponseReady(store,assignment,run.id)).toBe(false);
    store.command(actor,{type:'decision.vote',decisionId:decision.id,approve:false,rationale:'Independent fixture disagreement'});
    expect(checkpointFinalResponseReady(store,assignment,run.id)).toBe(true);
    expect(store.need('assignments',assignment.id).status).toBe('completed');expect(store.list('votes')).toHaveLength(1);
    store.update('assignments',assignment.id,{supervisorId:'changed-supervisor'});expect(checkpointFinalResponseReady(store,assignment,run.id)).toBe(false);
    store.update('assignments',assignment.id,{supervisorId:elder.id});store.command(owner,{type:'control',action:'pause'});
    expect(()=>checkpointFinalResponseReady(store,assignment,run.id)).toThrow();expect(store.list('votes')).toHaveLength(1);
  });
});

describe('candidate final-response checkpoint',()=>{
 it('requires a trusted candidate phase and leaves partial multi-action formation stages excluded',()=>{
  const candidate={...assignment,kind:'management',projectId:null,schedulerKey:'formation:candidate:req:0',payload:{formation:true}} as Assignment;
  expect(checkpointFinalResponseEligible(candidate)).toBe(true);
  for(const patch of [{kind:'implementation'},{projectId:'project'},{payload:{}},{schedulerKey:'formation:candidate:req'},{schedulerKey:'formation:candidate:req:invalid'},...['request:position:manager','provision:candidate','onboard:employee','recruiter-bootstrap','office:Chief Product Officer','department:Web Engineering'].map(key=>({schedulerKey:`formation:${key}`}))])expect(checkpointFinalResponseEligible({...candidate,...patch} as Assignment)).toBe(false);
 });
 it('uses only retained candidate evidence from this exact assignment, including a resumed attempt',()=>{
  assignment=store.update('assignments',assignment.id,{status:'running',schedulerKey:'formation:candidate:req:0',payload:{formation:true}});
  expect(checkpointFinalResponseReady(store,assignment,run.id)).toBe(false);
  const unrelated=store.put('runs',{...run,id:undefined,assignmentId:'other-assignment',sessionId:randomUUID(),status:'interrupted'});
  const candidate=store.put('experiences',{kind:'candidate',requisitionId:'req',status:'proposed',authorship:{runId:unrelated.id}});
  expect(checkpointFinalResponseReady(store,assignment,run.id)).toBe(false);
  store.update('experiences',candidate.id,{authorship:{runId:run.id}});
  expect(checkpointFinalResponseReady(store,assignment,run.id)).toBe(true);
  store.update('runs',run.id,{status:'interrupted',tokenRevoked:true});
  const resumed=store.put('runs',{...run,id:undefined,sessionId:randomUUID(),status:'running',tokenRevoked:false});
  expect(checkpointFinalResponseReady(store,assignment,resumed.id)).toBe(true);
  store.update('experiences',candidate.id,{status:'changes_requested'});
  expect(checkpointFinalResponseReady(store,assignment,resumed.id)).toBe(true);
  const correction=store.put('assignments',{...assignment,id:undefined,schedulerKey:'formation:candidate:req:1'});
  const correctionRun=store.put('runs',{...resumed,id:undefined,assignmentId:correction.id,sessionId:randomUUID()});
  expect(checkpointFinalResponseReady(store,correction,correctionRun.id)).toBe(false);
  store.update('assignments',assignment.id,{supervisorId:'changed'});
  expect(checkpointFinalResponseReady(store,assignment,resumed.id)).toBe(false);
  store.update('assignments',assignment.id,{supervisorId:assignment.supervisorId});
  store.command(owner,{type:'control',action:'pause'});
  expect(()=>checkpointFinalResponseReady(store,assignment,resumed.id)).toThrow();
 });
 it('passes the candidate predicate to runtime without completing an unfulfilled task',async()=>{
  assignment=store.update('assignments',assignment.id,{status:'running',schedulerKey:'formation:candidate:req:0',payload:{formation:true}});
  const execute=vi.fn(async(request:any)=>{expect(request.finalResponseCheckpoint()).toBe(false);throw new Error('Fixture stops before inference');});
  await (new Scheduler(store,{execute} as unknown as LocalRuntime,new CorporateBroker(store,root),'http://localhost') as any).execute(run);
  expect(execute).toHaveBeenCalledOnce();expect(store.need('assignments',assignment.id).status).not.toBe('completed');
 });
});

describe('corporate-only formation dispatch',()=>{
 it('selects only known company formation phases with the trusted marker',()=>{
  for(const key of ['office:Chief Product Officer','department:Web Engineering','recruiter-bootstrap','request:position','candidate:req:0','approve:candidate:1','provision:candidate','onboard:employee']){
   store.update('assignments',assignment.id,{kind:'management',projectId:null,schedulerKey:`formation:${key}`,payload:{formation:true}});expect(corporateOnlyFormation(store,run)).toBe(true);
  }
  const valid={kind:'management',projectId:null,schedulerKey:'formation:recruiter-bootstrap',payload:{formation:true}};
  for(const patch of [{kind:'implementation'},{projectId:'product-project'},{payload:{}},{schedulerKey:'formation:unknown:fixture'},{schedulerKey:'duty:department:0'}]){
   store.update('assignments',assignment.id,{...valid,...patch});expect(corporateOnlyFormation(store,run)).toBe(false);
  }
 });
 it('includes only trusted faults whose original assignment is corporate formation',async()=>{
  store.update('assignments',assignment.id,{schedulerKey:'formation:recruiter-bootstrap',payload:{formation:true},status:'blocked'});store.update('runs',run.id,{status:'failed'});
  const diagnosis=store.command(owner,{type:'assignment.create',employeeId:run.employeeId,title:'Diagnose formation',instructions:'Inspect retained records',acceptance:['Correct original'],kind:'management'});
  store.update('assignments',diagnosis.id,{schedulerKey:`fault:${run.id}`,payload:{failedRunId:run.id,failedAssignmentId:assignment.id}});
  const diagnosticRun=store.put('runs',{...run,id:undefined,sessionId:randomUUID(),assignmentId:diagnosis.id,status:'running'});
  expect(corporateOnlyFormation(store,diagnosticRun)).toBe(true);
  const execute=vi.fn(async(_request:any)=>{throw new Error('Fixture stops at runtime dispatch');}),scheduler=new Scheduler(store,{execute} as unknown as LocalRuntime,new CorporateBroker(store,root),'http://localhost');
  await (scheduler as any).execute(diagnosticRun);expect(execute.mock.calls[0][0].corporateOnly).toBe(true);expect(execute.mock.calls[0][0].prompt).toContain('inspect retained corporate records and source-inspection receipts');expect(execute.mock.calls[0][0].prompt).not.toContain('inspect preserved files');
  store.update('assignments',assignment.id,{projectId:'product-project'});expect(corporateOnlyFormation(store,diagnosticRun)).toBe(false);
  store.update('assignments',assignment.id,{projectId:null});store.update('assignments',diagnosis.id,{payload:{failedRunId:run.id,failedAssignmentId:'wrong-target'}});expect(corporateOnlyFormation(store,diagnosticRun)).toBe(false);
 });
 it.each([true,false])('passes corporate-only selection %s and the matching interruption guidance to runtime',async enabled=>{
  if(enabled)store.update('assignments',assignment.id,{schedulerKey:'formation:recruiter-bootstrap',payload:{formation:true}});
  const execute=vi.fn(async(_request:any)=>{throw new Error('Fixture stops at runtime dispatch');}),scheduler=new Scheduler(store,{execute} as unknown as LocalRuntime,new CorporateBroker(store,root),'http://localhost');
  await (scheduler as any).execute(store.need('runs',run.id));const request=execute.mock.calls[0][0];
  expect(request.corporateOnly).toBe(enabled?true:undefined);
  expect(request.prompt.includes('Use the retained formation records above')).toBe(enabled);expect(request.prompt.includes('inspect preserved files')).toBe(!enabled);
 });
});

describe('durable dispatch boundaries',()=>{
  it('uses the tailored expansion role and selected references without a generic hierarchy seed',async()=>{
    store.update('company',store.company.id,{direction:undefined});store.command(owner,{type:'company.expand',mandate:'Form specialist departments through actual recruitment'});
    store.command(owner,{type:'role.update',employeeId:run.employeeId,content:'Own tailored workforce competency adaptation and onboarding.',source:'Pinned competencies',rationale:'Tailor the skill'});
    store.update('employees',run.employeeId,{competencies:['candidate adaptation'],sourceIds:['pinned-recruitment-source']});
    const execute=vi.fn(async(_request:any)=>{throw new Error('Fixture stops at runtime dispatch');}),scheduler=new Scheduler(store,{execute} as unknown as LocalRuntime,new CorporateBroker(store,root),'http://localhost');
    await (scheduler as any).execute(store.need('runs',run.id));
    const system=execute.mock.calls[0][0].system;expect(system).toContain('Own tailored workforce competency adaptation and onboarding.');expect(system).toContain(`Current run ID: ${run.id}.`);
    const seed=system.split('Relevant competency seed (authority remains above):')[1];expect(seed).toContain('pinned-recruitment-source');expect(seed).toContain('candidate adaptation');expect(seed).not.toContain('#');
    const legacyStyleHire=store.update('employees',run.employeeId,{sourceIds:undefined,roleAuthorship:undefined});expect((scheduler as any).roleSeed(legacyStyleHire)).toContain('Use the retained role above');
  });

  it.each([
    ['Acknowledge this controls check only.','Acknowledged.'],
    ['Explain which artifacts support the current project result.','No artifacts have been recorded in this fixture; there is no completed product outcome to report.'],
  ])('guides and persists an internal Owner final reply for %s',async(content,text)=>{
    const message=store.command(owner,{type:'message.send',recipientId:run.employeeId,content,wake:false});
    store.update('assignments',assignment.id,{kind:'conversation',status:'running',instructions:`Owner message ${message.id}: ${content}\nRespond through message.send with recipientId omitted (CEO) or in your final answer.`,payload:{messageId:message.id}});
    const result:RuntimeResult={sessionId:'session',text,modelId:'qwen-main',artifactIdentity:'fixture-local-model',usage:{inputTokens:20,outputTokens:10,requests:1,durationMs:10},messagesPath:join(root,'fixture-messages.json'),diagnosticsPath:join(root,'fixture-diagnostics.json'),completion:{finishReason:'stop',continuations:0,outputLimit:4096,exhausted:false}};
    const execute=vi.fn(async(_request:any)=>result),broker=new CorporateBroker(store,root),call=vi.spyOn(broker,'call'),scheduler=new Scheduler(store,{execute} as unknown as LocalRuntime,broker,'http://localhost');
    await (scheduler as any).execute(store.need('runs',run.id));
    expect(execute.mock.calls[0][0].contextTokens).toBe(16384);
    const system=execute.mock.calls[0][0].system;expect(system).toContain('answer in your final response');expect(system).toContain('persists it as an attributed reply');expect(system).toContain('Your final response is the requested conversation deliverable');expect(execute.mock.calls[0][0].prompt).toContain('Respond through message.send');expect(system).toContain('actual question or request');expect(system).toContain('brief acknowledgment and finish without unsolicited portfolio work');expect(system).not.toContain('Final prose is not a deliverable');
    expect(store.need('runs',run.id)).toMatchObject({status:'succeeded',text});expect(store.need('assignments',assignment.id).status).toBe('completed');expect(store.need('messages',message.id)).toMatchObject({senderId:'owner',content});
    expect(store.list('messages').find(item=>item.runId===run.id)).toMatchObject({senderId:run.employeeId,content:text});expect(store.list('assignments')).toHaveLength(1);expect(store.list('actions')).toEqual([]);expect(call).not.toHaveBeenCalled();
  });
  it.each(['checkpoint','output-limit'])('retains actual runtime diagnostics when %s validation fails',async failure=>{
    store.update('assignments',assignment.id,{kind:'governance',status:'running',payload:{decisionId:'unrecorded-vote'}});
    const result:RuntimeResult={sessionId:'session',text:failure==='checkpoint'?'Evidence read, required vote still missing.':'',modelId:'qwen-main',artifactIdentity:'observed-local-artifact',usage:{inputTokens:17688,outputTokens:4096,requests:2,durationMs:1070000},messagesPath:join(root,'retained-messages.json'),diagnosticsPath:join(root,'retained-diagnostics.json'),completion:{finishReason:failure==='checkpoint'?'stop':'length',continuations:failure==='checkpoint'?0:2,outputLimit:4096,exhausted:failure==='output-limit'}};
    const execute=vi.fn(async()=>{if(failure==='output-limit')throw new RuntimeExecutionError('output_limit_exhausted','Local response allowance exhausted after two continuations',result);return result;});
    const scheduler=new Scheduler(store,{execute} as unknown as LocalRuntime,new CorporateBroker(store,root),'http://localhost');
    await (scheduler as any).execute(store.need('runs',run.id));
    const retained=store.need('runs',run.id);expect(retained).toMatchObject({status:'failed',text:result.text,modelIdentity:result.artifactIdentity,usage:result.usage,messagesPath:result.messagesPath,runtimeDiagnosticsPath:result.diagnosticsPath,runtimeCompletion:result.completion});
    expect(retained.error).toContain(failure==='checkpoint'?'assigned independent governance vote':'response allowance exhausted');
    if(failure==='output-limit')expect(retained.runtimeFailureCode).toBe('output_limit_exhausted');
    expect(store.list('votes')).toHaveLength(0);expect(store.need('assignments',assignment.id).status).not.toBe('completed');
  });
  it.each(['governance','implementation'])('dispatches %s with the qualified 32K company context budget',async kind=>{
    store.update('assignments',assignment.id,{kind,status:'running'});
    const execute=vi.fn(async()=>{throw new Error('Fixture stops at the runtime dispatch boundary');}),scheduler=new Scheduler(store,{execute} as unknown as LocalRuntime,new CorporateBroker(store,root),'http://localhost');
    await (scheduler as any).execute(store.need('runs',run.id));
    expect(execute).toHaveBeenCalledOnce();expect(execute).toHaveBeenCalledWith(expect.objectContaining({runId:run.id,employeeId:run.employeeId,modelId:model,contextTokens:32768}));expect(store.list('artifacts')).toHaveLength(0);
  });
  it.each([false,true])('explains corporate state location only for a company workspace (project=%s)',async projectBound=>{
    if(projectBound){const project=store.command(owner,{type:'project.create',name:'Fixture workspace',outcome:'Fixture result',acceptance:['Fixture evidence'],supervisorId:run.employeeId,rationale:'Prompt boundary test'});store.update('assignments',assignment.id,{projectId:project.id});}
    const execute=vi.fn(async(_request:any)=>{throw new Error('Fixture stops at runtime dispatch');}),scheduler=new Scheduler(store,{execute} as unknown as LocalRuntime,new CorporateBroker(store,root),'http://localhost');
    await (scheduler as any).execute(store.need('runs',run.id));expect(execute).toHaveBeenCalledOnce();
    const system=execute.mock.calls[0][0].system;expect(system.includes('Company records are served by corporate tools, not native files')).toBe(!projectBound);
    if(!projectBound){expect(system).toContain('company_read, company_detail, company_help and knowledge_search');expect(system).toContain('repository broker tools for registered products');}
  });
  it.each(['parked','blocked','completed','cancelled'])('does not claim %s project work, preserves its owner, and can resume when reactivated',status=>{
    store.update('runs',run.id,{status:'succeeded'});store.update('assignments',assignment.id,{status:'completed'});
    const project=store.command(owner,{type:'project.create',name:'Deferred product work',productId:store.list('products')[0].id,outcome:'Useful outcome',acceptance:['Actual evidence'],supervisorId:run.employeeId,rationale:'Fixture'});
    const work=store.command(owner,{type:'assignment.create',projectId:project.id,employeeId:run.employeeId,title:'Preserved assignment',instructions:'Keep responsibility while parked',acceptance:['Real output']});store.update('projects',project.id,{status});
    expect(store.claimNext({assignmentId:work.id})).toBeUndefined();expect(store.need('assignments',work.id).employeeId).toBe(run.employeeId);
    store.update('projects',project.id,{status:'active'});const claimed=store.claimNext({assignmentId:work.id});expect(claimed?.assignmentId).toBe(work.id);expect(claimed?.runtimeDispatch).toBe('claimed');
  });
  it('filters parked work before workspace creation even when it has the highest priority',async()=>{
    store.update('runs',run.id,{status:'succeeded'});store.update('assignments',assignment.id,{status:'completed'});
    const project=store.command(owner,{type:'project.create',name:'Parked',productId:store.list('products')[0].id,outcome:'Deferred',acceptance:['Actual evidence'],supervisorId:run.employeeId,rationale:'Fixture'});
    store.command(owner,{type:'assignment.create',projectId:project.id,employeeId:run.employeeId,title:'Parked high priority',instructions:'Do not dispatch',acceptance:['Evidence'],priority:1000});store.update('projects',project.id,{status:'parked'});
    const broker=new CorporateBroker(store,root),ensure=vi.spyOn(broker.workspaces,'ensure');const scheduler=new Scheduler(store,{recoverTools:async()=>({status:'absent',jobs:[]})} as unknown as LocalRuntime,broker,'http://localhost');await scheduler.recover();
    vi.spyOn(scheduler,'initialize').mockResolvedValue();vi.spyOn(scheduler as any,'reconcileOrganization').mockImplementation(()=>{});vi.spyOn(scheduler as any,'deliveryEvents').mockResolvedValue(undefined);
    await scheduler.tick();expect(ensure).not.toHaveBeenCalled();expect(store.list('runs')).toHaveLength(1);
  });
  it.each([true,false])('preserves unscoped narratives without blocking scoped review or dispatch (verified=%s)',async verified=>{
    const broker=new CorporateBroker(store,root);store.update('assignments',assignment.id,{kind:'conversation'});writeFileSync(join(root,'reply.md'),'# Retained company conversation finding\n');
    const recorded=await broker.call(actor,'record_artifact',{path:'reply.md',summary:'Company-only finding'});if(!verified)store.update('artifacts',recorded.id,{verification:{identity:recorded.identity,passed:false}});
    store.update('runs',run.id,{status:'succeeded',tokenRevoked:true});
    const unscoped={artifact:store.need('artifacts',recorded.id),assignment:store.need('assignments',assignment.id),run:store.need('runs',run.id)};
    const position=store.command(owner,{type:'position.create',title:'Fixture implementer',level:'worker',responsibilities:'Scoped product implementation'}),worker=store.command(owner,{type:'employee.hire',name:'Scoped author',positionId:position.id,homeManagerId:run.employeeId,modelId:model});
    const project=store.command(owner,{type:'project.create',name:'Unrelated finite project',productId:store.list('products')[0].id,outcome:'Actual scoped result',acceptance:['Verified source change'],supervisorId:run.employeeId,rationale:'Fixture'});
    const original=store.command(owner,{type:'assignment.create',employeeId:worker.id,projectId:project.id,title:'Scoped completed source',instructions:'Actual source change',acceptance:['Verified source change'],kind:'implementation'});store.update('assignments',original.id,{status:'awaiting_review'});
    const artifact=store.put('artifacts',{assignmentId:original.id,projectId:project.id,employeeId:worker.id,runId:'fixture-prior-author-run',kind:'commit',identity:'a'.repeat(40),uri:'fixture://commit',summary:'Scoped change',checks:[],verification:{identity:'a'.repeat(40),passed:true}});
    const next=store.command(owner,{type:'assignment.create',employeeId:worker.id,projectId:project.id,title:'Unrelated queued implementation',instructions:'Continue the actual project',acceptance:['Source evidence'],kind:'implementation',priority:1000}),projects=store.list('projects');
    const scheduler=new Scheduler(store,{recoverTools:async()=>({status:'absent',jobs:[]})} as unknown as LocalRuntime,broker,'http://localhost');await scheduler.recover();
    vi.spyOn(scheduler,'initialize').mockResolvedValue();vi.spyOn(scheduler as any,'deliveryEvents').mockResolvedValue(undefined);const ensure=vi.spyOn(broker.workspaces,'ensure').mockResolvedValue({...project,workspace:root}),execute=vi.spyOn(scheduler as any,'execute').mockResolvedValue(undefined);
    (scheduler as any).reconcileOrganization();(scheduler as any).reconcileOrganization();await scheduler.tick();
    expect(ensure).toHaveBeenCalledExactlyOnceWith(project);expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({assignmentId:next.id,employeeId:worker.id,workspace:root,runtimeDispatch:'claimed'}));
    expect(store.list('assignments').filter(task=>task.kind==='review')).toEqual([expect.objectContaining({projectId:project.id,employeeId:run.employeeId,payload:{artifactId:artifact.id},status:'queued'})]);
    expect(store.need('artifacts',recorded.id)).toEqual(unscoped.artifact);expect(store.need('assignments',assignment.id)).toEqual(unscoped.assignment);expect(store.need('runs',run.id)).toEqual(unscoped.run);expect(store.list('projects')).toEqual(projects);expect(store.list('reviews')).toEqual([]);
  });
  it('reclaims only positively undispatched runs without native reconciliation',async()=>{
    const broker=new CorporateBroker(store,root),recoverRun=vi.fn(async()=>({status:'uncertain' as const}));const scheduler=new Scheduler(store,{recoverRun,recoverTools:async()=>({status:'absent',jobs:[]})} as unknown as LocalRuntime,broker,'http://localhost');
    store.update('runs',run.id,{runtimeDispatch:'claimed'});store.update('assignments',assignment.id,{status:'running'});
    const preparedAssignment=store.put('assignments',{...assignment,id:undefined,status:'running'}),prepared=store.put('runs',{...run,id:undefined,sessionId:randomUUID(),assignmentId:preparedAssignment.id,runtimeDispatch:'prepared'});
    const dispatchedAssignment=store.put('assignments',{...assignment,id:undefined,status:'running'}),dispatched=store.put('runs',{...run,id:undefined,sessionId:randomUUID(),assignmentId:dispatchedAssignment.id,runtimeDispatch:'dispatched'});
    await scheduler.recover();expect(recoverRun).toHaveBeenCalledExactlyOnceWith(dispatched.id);
    expect(store.need('runs',run.id).status).toBe('interrupted');expect(store.need('runs',prepared.id).status).toBe('interrupted');expect(store.need('assignments',assignment.id).status).toBe('queued');expect(store.need('runs',dispatched.id).status).toBe('uncertain');expect(store.need('assignments',dispatchedAssignment.id).status).toBe('blocked');
  });
  it('holds an early start until asynchronous recovery completes, then honors the pending start',async()=>{
    store.update('runs',run.id,{status:'succeeded'});store.update('assignments',assignment.id,{status:'completed'});
    let resolveRecovery!:(value:any)=>void;const recovery=new Promise<any>(resolve=>{resolveRecovery=resolve;});
    const scheduler=new Scheduler(store,{recoverTools:()=>recovery} as unknown as LocalRuntime,new CorporateBroker(store,root),'http://localhost');
    const initialize=vi.spyOn(scheduler,'initialize').mockResolvedValue();vi.spyOn(scheduler as any,'reconcileOrganization').mockImplementation(()=>{});vi.spyOn(scheduler as any,'deliveryEvents').mockResolvedValue(undefined);
    const recovering=scheduler.recover();scheduler.start();await scheduler.tick();expect(initialize).not.toHaveBeenCalled();
    resolveRecovery({status:'absent',jobs:[]});await recovering;await new Promise(resolve=>setImmediate(resolve));expect(initialize).toHaveBeenCalledOnce();
    (scheduler as any).stopping=true;clearInterval((scheduler as any).timer);
  });
  it('holds dispatch for uncertain native ownership even when no persisted employee run is active',async()=>{
    store.update('runs',run.id,{status:'succeeded'});store.update('assignments',assignment.id,{status:'completed'});
    const scheduler=new Scheduler(store,{recoverTools:async()=>({status:'uncertain',jobs:[{status:'uncertain',receiptPath:'owned-job-receipt'}]})} as unknown as LocalRuntime,new CorporateBroker(store,root),'http://localhost');
    const initialize=vi.spyOn(scheduler,'initialize').mockResolvedValue();scheduler.start();await scheduler.recover();await scheduler.tick();expect(initialize).not.toHaveBeenCalled();expect(store.list('attention').find(a=>a.recoveryKey==='native-tools')?.detail).toContain('owned-job-receipt');
  });
});

describe('shared staffing decisions',()=>{
  function setup(){
    const manager=(name:string)=>{const position=store.command(owner,{type:'position.create',title:name,level:'manager',responsibilities:'Supervise useful work'});return store.command(owner,{type:'employee.hire',name,positionId:position.id,homeManagerId:run.employeeId,modelId:model});};
    const home=manager('Home manager'),requester=manager('Requesting manager'),position=store.command(owner,{type:'position.create',title:'Shared specialist',level:'worker',responsibilities:'Useful product work'}),worker=store.command(owner,{type:'employee.hire',name:'Shared specialist',positionId:position.id,homeManagerId:home.id,modelId:model});
    const project=store.command(owner,{type:'project.create',name:'Borrowing project',productId:store.list('products')[0].id,outcome:'Verified outcome',acceptance:['Actual review'],supervisorId:requester.id,rationale:'Fixture'});
    const requestRun=store.put('runs',{...run,id:undefined,sessionId:randomUUID(),employeeId:requester.id}),requestActor:Actor={kind:'employee',employeeId:requester.id,runId:requestRun.id,policyRevision:store.policy.revision};
    const work=store.command(requestActor,{type:'assignment.create',projectId:project.id,employeeId:worker.id,title:'Shared specialist task',instructions:'Concrete implementation request',acceptance:['Actual reviewed result'],priority:30});
    const scheduler=new Scheduler(store,{} as LocalRuntime,new CorporateBroker(store,root),'http://localhost');(scheduler as any).reconcileOrganization();(scheduler as any).reconcileOrganization();
    const requests=store.list('assignments').filter(a=>a.schedulerKey?.startsWith(`staffing:${work.id}:`));expect(requests).toHaveLength(1);const request=requests[0];expect(request.employeeId).toBe(home.id);expect(request.projectId).toBeNull();expect(store.need('assignments',work.id).accepted).toBe(false);
    const homeRun=store.put('runs',{...run,id:undefined,sessionId:randomUUID(),employeeId:home.id,assignmentId:request.id}),homeActor:Actor={kind:'employee',employeeId:home.id,runId:homeRun.id,policyRevision:store.policy.revision};
    return {home,worker,work,scheduler,request,homeRun,homeActor,requestActor};
  }
  it('queues one home-manager decision and requires that actual acceptance for completion',()=>{
    const {worker,work,request,homeRun,homeActor,requestActor}=setup();expect(managementOutcome(store,request,homeRun).passed).toBe(false);
    expect(()=>store.command(requestActor,{type:'assignment.accept',assignmentId:work.id,accept:true})).toThrow(/home management/);
    const workerRun=store.put('runs',{...homeRun,id:undefined,sessionId:randomUUID(),employeeId:worker.id});
    expect(()=>store.command({kind:'employee',employeeId:worker.id,runId:workerRun.id,policyRevision:store.policy.revision},{type:'assignment.accept',assignmentId:work.id,accept:true})).toThrow(/home management/);
    store.command(homeActor,{type:'assignment.accept',assignmentId:work.id,accept:true,rationale:'Existing commitment completed; capacity available'});
    expect(managementOutcome(store,request,store.need('runs',homeRun.id)).passed).toBe(true);expect(store.need('assignments',work.id).accepted).toBe(true);expect(store.need('employees',worker.id).homeManagerId).toBe(homeActor.kind==='employee'?homeActor.employeeId:undefined);
  });
  it('routes managerless staffing to voluntary recipient consent without giving the requester authority',()=>{
    const elder=store.list('employees').find(e=>store.level(e.id)==='elder')!;
    const work=store.command(actor,{type:'assignment.create',employeeId:elder.id,title:'Independent strategy advice',instructions:'Assess the useful scope independently',acceptance:['Source-linked advice'],kind:'assessment'});
    const scheduler=new Scheduler(store,{} as LocalRuntime,new CorporateBroker(store,root),'http://localhost');(scheduler as any).reconcileOrganization();(scheduler as any).reconcileOrganization();
    const requests=store.list('assignments').filter(a=>a.schedulerKey?.startsWith(`staffing:${work.id}:`));expect(requests).toHaveLength(1);
    expect(requests[0].employeeId).toBe(elder.id);expect(store.need('assignments',work.id).accepted).toBe(false);
    expect(()=>store.command(actor,{type:'assignment.accept',assignmentId:work.id,accept:true})).toThrow(/home management/);
    const consentRun=store.put('runs',{...run,id:undefined,sessionId:randomUUID(),employeeId:elder.id,assignmentId:requests[0].id});
    store.command({kind:'employee',employeeId:elder.id,runId:consentRun.id,policyRevision:store.policy.revision},{type:'assignment.accept',assignmentId:work.id,accept:true,rationale:'Independent advice is useful and capacity is available'});
    expect(store.need('assignments',work.id).accepted).toBe(true);expect(store.need('employees',elder.id).homeManagerId).toBeNull();
    expect(managementOutcome(store,requests[0],store.need('runs',consentRun.id)).passed).toBe(true);
  });
  it('preserves a declined staffing decision and routes the conflict back to its requester',()=>{
    const {work,scheduler,request,homeRun,homeActor}=setup();
    expect(()=>store.command(homeActor,{type:'assignment.accept',assignmentId:work.id,accept:false})).toThrow(/Reason/);
    store.command(homeActor,{type:'assignment.accept',assignmentId:work.id,accept:false,rationale:'Current critical repair consumes available capacity'});(scheduler as any).reconcileOrganization();
    expect(store.need('assignments',work.id).status).toBe('blocked');expect(managementOutcome(store,request,store.need('runs',homeRun.id)).passed).toBe(true);
    const followup=store.list('assignments').find(a=>a.schedulerKey?.startsWith(`staffing-declined:${work.id}:`));expect(followup?.employeeId).toBe(work.supervisorId);expect(store.need('assignments',work.id).staffingDecisions).toHaveLength(1);
  });
});
afterEach(()=>{store.close();rmSync(root,{recursive:true,force:true});});

describe('artifact-scoped delivery governance',()=>{
 function partialMerge(merged=true){
  const project=store.command(owner,{type:'project.create',name:'Release and onboarding',productId:store.list('products')[0].id,outcome:'Release and complete onboarding',acceptance:['External contribution merged','Public release published','Onboarding verified'],supervisorId:run.employeeId,rationale:'Finite fixture scope'});
  const original=store.command(owner,{type:'assignment.create',projectId:project.id,employeeId:run.employeeId,title:'Original broader commitment',instructions:'Preserve every original criterion',acceptance:project.acceptance,kind:'implementation'});store.update('assignments',original.id,{status:'blocked',blockedReason:'Broader criteria remain unmet'});
  const artifact=store.put('artifacts',{assignmentId:original.id,projectId:project.id,employeeId:run.employeeId,runId:'fixture-author-run',kind:'commit',identity:'a'.repeat(40),uri:'fixture://commit',summary:'Partial CI correction',checks:[]}),review=store.put('reviews',{artifactId:artifact.id,artifactIdentity:artifact.identity,employeeId:store.list('employees').find(e=>store.level(e.id)==='elder')!.id,runId:'fixture-review-run',verdict:'approved',rationale:'Only the exact source correction is ready',checks:[]});
  const delivery={state:merged?'merged':'awaiting_checks',artifactId:artifact.id,identity:artifact.identity,prUrl:'https://github.com/fixture/product/pull/7',prNumber:7,mergeCommit:merged?'b'.repeat(40):undefined};store.update('projects',project.id,{delivery});const scheduler=new Scheduler(store,{} as LocalRuntime,new CorporateBroker(store,root),'http://localhost');
  return {project,original:store.need('assignments',original.id),artifact,review,delivery,key:`delivery:${project.id}:${delivery.mergeCommit}`,reconcile:()=>{(scheduler as any).reconcileOrganization();}};
 }
 it('frames one partial artifact merge with exact source identities while broader active criteria stay unmet',()=>{
  const fixture=partialMerge();fixture.reconcile();const decision=store.list('decisions').find(d=>d.triggerKey===fixture.key)!;
  expect(decision).toMatchObject({kind:'executive.review',status:'pending',payload:{employeeId:run.employeeId}});for(const value of [fixture.artifact.id,fixture.artifact.identity,fixture.review.id,fixture.delivery.prUrl,fixture.delivery.mergeCommit!,fixture.project.id,fixture.project.name,'active'])expect(decision.rationale).toContain(value);
  expect(decision.rationale).toContain('does not establish original assignment acceptance, project acceptance, or a public release');expect(decision.rationale).not.toContain(`Delivered ${fixture.project.name}`);expect(store.need('projects',fixture.project.id)).toMatchObject({status:'active',acceptance:fixture.project.acceptance});expect(store.need('assignments',fixture.original.id)).toEqual(fixture.original);expect(store.list('actions')).toEqual([]);
 });
 it.each(['pending','approved','rejected'] as const)('preserves an existing %s delivery decision and its independent votes on reconciliation',status=>{
  const fixture=partialMerge(),elders=store.list('employees').filter(e=>store.level(e.id)==='elder'),decision=store.put('decisions',{authorId:'system',kind:'executive.review',subject:`Review CEO delivery judgment (${fixture.key})`,rationale:`Delivered ${fixture.project.name}; retained historical wording.`,payload:{employeeId:run.employeeId},status:'pending',policyRevision:store.policy.revision,eligibleElders:elders.map(e=>e.id),triggerKey:fixture.key});
  for(const [index,elder] of elders.slice(0,status==='pending'?1:3).entries()){const task=store.command(owner,{type:'assignment.create',employeeId:elder.id,title:'Independent retained judgment',instructions:'Judge observed evidence independently',acceptance:['Initial vote recorded'],kind:'governance',payload:{decisionId:decision.id}}),voteRun=store.put('runs',{...run,id:randomUUID(),sessionId:randomUUID(),employeeId:elder.id,assignmentId:task.id});store.command({kind:'employee',employeeId:elder.id,runId:voteRun.id,policyRevision:store.policy.revision},{type:'decision.vote',decisionId:decision.id,approve:status!=='rejected'||index===2,rationale:`Independent retained judgment ${index}`});}
  const before=store.need('decisions',decision.id),votes=store.list('votes');expect(before.status).toBe(status);fixture.reconcile();fixture.reconcile();const restarted=new Scheduler(store,{} as LocalRuntime,new CorporateBroker(store,root),'http://localhost');(restarted as any).reconcileOrganization();expect(store.need('decisions',decision.id)).toEqual(before);expect(store.list('votes')).toEqual(votes);expect(store.list('decisions').filter(d=>d.triggerKey===fixture.key)).toHaveLength(1);
 });
 it('does not create a delivery review for a PR awaiting merge',()=>{const fixture=partialMerge(false);fixture.reconcile();expect(store.list('decisions').some(d=>d.triggerKey?.startsWith(`delivery:${fixture.project.id}:`))).toBe(false);expect(store.list('votes')).toEqual([]);});
});
const outcome=()=>managementOutcome(store,store.need('assignments',assignment.id),store.need('runs',run.id));

describe('management completion requires actual outcomes',()=>{
  it.each(['revised proposal','withdrawal','replacement pending','replacement approved','replacement rejected'])('routes a rejected appointment once and requires an evidenced current-run %s',correctionKind=>{
    store.update('company',store.company.id,{direction:undefined});store.command(owner,{type:'company.expand',mandate:'Form governed specialized departments'});
    const position=store.command(actor,{type:'position.create',title:'Chief Technology Officer',level:'executive',responsibilities:'Own useful product delivery'}),proposal={positionId:position.id,name:'Proposed executive',modelId:model,role:'Initial delivery scope'};
    const decision=store.command(actor,{type:'decision.create',kind:'executive.appoint',subject:'Initial executive appointment',rationale:'Concrete delivery ownership',payload:proposal});
    const scheduler=new Scheduler(store,{} as LocalRuntime,new CorporateBroker(store,root),'http://localhost');
    for(const elder of store.list('employees').filter(e=>store.level(e.id)==='elder')){
      const voteAssignment=store.command(owner,{type:'assignment.create',employeeId:elder.id,title:'Independent initial vote',instructions:'Judge the actual proposal',acceptance:['Actual initial judgment'],kind:'governance',payload:{decisionId:decision.id}}),voteRun=store.put('runs',{...run,id:undefined,employeeId:elder.id,assignmentId:voteAssignment.id,sessionId:randomUUID()});
      store.command({kind:'employee',employeeId:elder.id,runId:voteRun.id,policyRevision:store.policy.revision},{type:'decision.vote',decisionId:decision.id,approve:false,rationale:`Independent objection from ${elder.id}: scope needs actual delivery evidence`});
    }
    (scheduler as any).reconcileOrganization();(scheduler as any).reconcileOrganization();
    expect(store.list('assignments').filter(a=>a.schedulerKey?.startsWith('formation:office:Chief Technology Officer'))).toHaveLength(0);
    const followups=store.list('assignments').filter(a=>a.schedulerKey===`appointment-rejected:${decision.id}`);expect(followups).toHaveLength(1);const followup=followups[0],voteIds=store.list('votes').filter(v=>v.decisionId===decision.id).map(v=>v.id);
    expect(followup).toMatchObject({employeeId:run.employeeId,projectId:null,status:'queued',payload:{rejectedDecisionId:decision.id,voteIds}});expect(followup.instructions).toContain(decision.id);for(const id of voteIds)expect(followup.instructions).toContain(id);
    const correctionRun=store.put('runs',{...run,id:undefined,assignmentId:followup.id,sessionId:randomUUID(),text:'The staffing issue is resolved.'}),correctionActor:Actor={kind:'employee',employeeId:run.employeeId,runId:correctionRun.id,policyRevision:store.policy.revision},result=()=>managementOutcome(store,followup,store.need('runs',correctionRun.id));
    expect(result().passed).toBe(false);store.command(correctionActor,{type:'product.assess',productId:store.list('products')[0].id,assessment:'Updated product evidence',rationale:'Unrelated assessment cannot complete governance correction'});expect(result().passed).toBe(false);
    const payload={...(correctionKind==='withdrawal'?{disposition:'withdrawn'}:proposal),rejectedDecisionId:decision.id},kind=correctionKind==='withdrawal'?'strategy':correctionKind.startsWith('replacement')?'executive.replace':'executive.appoint';
    store.command(correctionActor,{type:'decision.create',kind,subject:'Unlinked response',rationale:'No finalized vote evidence linked yet',payload});expect(result().passed).toBe(false);
    store.command(actor,{type:'decision.create',kind,subject:'Foreign-run linked correction',rationale:'A different assignment cannot satisfy this correction',payload:{...payload,reviewedVoteIds:voteIds}});expect(result().passed).toBe(false);
    const corrected=store.command(correctionActor,{type:'decision.create',kind,subject:'Evidence-based staffing correction',rationale:'Address the retained scope objections with concrete product evidence',payload:{...payload,reviewedVoteIds:voteIds}});if(correctionKind.startsWith('replacement'))store.update('decisions',corrected.id,{status:correctionKind.split(' ')[1]});expect(result().passed).toBe(true);
    store.update('assignments',followup.id,{status:'completed'});(scheduler as any).reconcileOrganization();expect(store.list('assignments').filter(a=>a.schedulerKey===followup.schedulerKey)).toHaveLength(1);expect(store.need('decisions',decision.id).status).toBe('rejected');expect(store.list('votes').filter(v=>v.decisionId===decision.id).map(v=>v.id)).toEqual(voteIds);
    const remaining=store.list('assignments').filter(a=>a.schedulerKey?.startsWith('formation:office:Chief Technology Officer'));
    if(correctionKind==='withdrawal'){
      expect(remaining).toHaveLength(1);expect(remaining[0].status).toBe('queued');expect(remaining[0].instructions).toContain('Do not retry the withdrawn candidate unchanged');
      (scheduler as any).reconcileOrganization();expect(store.list('assignments').filter(a=>a.schedulerKey===remaining[0].schedulerKey)).toHaveLength(1);
    }else expect(remaining).toHaveLength(0);
  });
  it('returns a verified retained artifact to review after a verification-only implementation retry',()=>{
    store.update('assignments',assignment.id,{kind:'implementation',status:'running'});const artifact=store.put('artifacts',{assignmentId:assignment.id,employeeId:run.employeeId,runId:'prior-author-run',projectId:null,uri:'actual-commit',identity:'exact-head',kind:'commit',summary:'Retained implementation',checks:[]});
    expect(outcome().passed).toBe(false);store.update('artifacts',artifact.id,{verification:{runId:run.id,passed:true,identity:artifact.identity,receiptId:'current-run-verifier-receipt'}});expect(outcome().passed).toBe(true);
    store.finishRun(run.id,{status:'succeeded'});expect(store.need('assignments',assignment.id).status).toBe('awaiting_review');
  });
  it('requires an actual review verdict from this run before a reviewer can report success',()=>{
    store.update('assignments',assignment.id,{kind:'review',payload:{artifactId:'assigned-artifact'}});expect(outcome().passed).toBe(false);
    store.put('reviews',{artifactId:'assigned-artifact',artifactIdentity:'exact-head',employeeId:run.employeeId,runId:'prior-review-run',verdict:'approved',rationale:'Historical review',checks:[]});expect(outcome().passed).toBe(false);
    store.put('reviews',{artifactId:'assigned-artifact',artifactIdentity:'exact-head',employeeId:run.employeeId,runId:run.id,verdict:'changes_requested',rationale:'Actual inspected issue',checks:[]});expect(outcome().passed).toBe(true);
  });
  it('keeps a persisted initial vote complete through a subsequent transport failure and gates peer follow-up dispatch',()=>{
    const elders=store.list('employees').filter(e=>store.level(e.id)==='elder'),parent=store.command(owner,{type:'decision.create',kind:'executive.review',subject:'Review actual outcome',rationale:'Actual delivery',payload:{employeeId:run.employeeId}});
    store.update('assignments',assignment.id,{employeeId:elders[0].id,kind:'governance',status:'running',payload:{decisionId:parent.id}});store.update('runs',run.id,{employeeId:elders[0].id});const elderActor:Actor={kind:'employee',employeeId:elders[0].id,runId:run.id,policyRevision:store.policy.revision};
    store.command(elderActor,{type:'decision.vote',decisionId:parent.id,approve:true,rationale:'Independent initial judgment'});
    const child=store.command(elderActor,{type:'decision.create',kind:'executive.appoint',subject:'Follow-up appointment opinion',rationale:'Proposal after independent vote',payload:{}});
    const scheduler=new Scheduler(store,{} as LocalRuntime,new CorporateBroker(store,root),'http://localhost');(scheduler as any).reconcileOrganization();
    expect(store.list('assignments').filter(a=>a.payload?.decisionId===child.id).map(a=>a.employeeId)).toEqual([elders[0].id]);
    store.finishRun(run.id,{status:'failed',transient:true,error:'Response transport failed after durable vote'});expect(store.need('assignments',assignment.id).status).toBe('completed');expect(store.list('votes').filter(v=>v.decisionId===parent.id)).toHaveLength(1);
  });
  it('retains management retry history and requires a concrete reason before resetting attempts',()=>{
    store.update('assignments',assignment.id,{status:'blocked',attempts:3});expect(()=>store.command(owner,{type:'assignment.update',assignmentId:assignment.id,status:'queued'})).toThrow(/record/);
    store.command(owner,{type:'assignment.update',assignmentId:assignment.id,status:'queued',rationale:'Installed and verified the transport timeout correction'});const first=store.need('assignments',assignment.id);expect(first.attempts).toBe(0);expect(first.retryDecisions[0]).toMatchObject({priorAttempts:3,actorId:'owner',rationale:'Installed and verified the transport timeout correction'});
    store.update('assignments',assignment.id,{status:'blocked',attempts:2});store.command(owner,{type:'assignment.update',assignmentId:assignment.id,status:'queued',rationale:'Changed the concrete dependency environment after diagnosis'});expect(store.need('assignments',assignment.id).retryDecisions.map((r:any)=>r.priorAttempts)).toEqual([3,2]);
  });
  it('routes exhausted independent-review corrections to the responsible supervisor once',()=>{
    store.update('assignments',assignment.id,{status:'blocked',corrections:store.policy.maxCorrections,reviewFeedback:'Actual repeated missing edge-case validation'});const scheduler=new Scheduler(store,{} as LocalRuntime,new CorporateBroker(store,root),'http://localhost');(scheduler as any).reconcileOrganization();(scheduler as any).reconcileOrganization();const tasks=store.list('assignments').filter(a=>a.schedulerKey?.startsWith(`correction-limit:${assignment.id}:`));expect(tasks).toHaveLength(1);expect(tasks[0].employeeId).toBe(assignment.supervisorId);
  });
  it('does not count read-only tool calls or automatically recorded prose/experience as management work',()=>{
    store.update('runs',run.id,{corporateCalls:12});expect(outcome().passed).toBe(false);
    store.command(actor,{type:'message.send',content:'All strategy work is completed.'});store.command(actor,{type:'experience.record',summary:'Read company state',source:`run:${run.id}`,learned:'Need an actual useful decision'});
    expect(outcome().passed).toBe(false);
    const product=store.list('products')[0];store.command(actor,{type:'product.assess',productId:product.id,assessment:'A live parser issue remains open; previous release completed.',rationale:'Current upstream issue and release evidence'});
    expect(outcome().passed).toBe(true);
  });
  it('requires all portfolio assessments, concrete goals and a real executive proposal for formation',()=>{
    store.update('assignments',assignment.id,{schedulerKey:'founding-mandate'});expect(outcome().passed).toBe(false);
    for(const product of store.list('products'))store.command(actor,{type:'product.assess',productId:product.id,assessment:`Inspected current ${product.name} source and commitments.`,rationale:'Live repository evidence'});
    expect(outcome().passed).toBe(false);
    for(const product of store.list('products'))store.command(actor,{type:'product.goal',productId:product.id,goals:[{outcome:'Resolve current user friction',measure:'Canonical verifier passes for delivered fix'}],rationale:'Prioritized live user-visible issue'});
    expect(outcome().passed).toBe(false);
    const executive=store.command(actor,{type:'position.create',title:'Technology executive',level:'executive',responsibilities:'Deliver verified portfolio improvements'});
    store.command(actor,{type:'decision.create',kind:'executive.appoint',subject:'Appoint delivery executive',rationale:'Concrete work needs accountable technical leadership',payload:{positionId:executive.id,name:'Delivery executive',modelId:model}});
    expect(outcome().passed).toBe(true);
  });
  it('matches governance completion to the assigned decision and the exact Elder run',()=>{
    const elder=store.list('employees').find(e=>store.level(e.id)==='elder')!;
    store.update('assignments',assignment.id,{kind:'governance',employeeId:elder.id,payload:{decisionId:'assigned-decision'}});store.update('runs',run.id,{employeeId:elder.id,corporateCalls:4,corporateCommands:[{type:'decision.vote'}]});
    store.put('votes',{decisionId:'different-decision',employeeId:elder.id,runId:run.id,approve:true,rationale:'Unrelated vote',phase:'initial'});expect(outcome().passed).toBe(false);
    store.put('votes',{decisionId:'assigned-decision',employeeId:elder.id,runId:'previous-run',approve:true,rationale:'Historical vote',phase:'initial'});expect(outcome().passed).toBe(false);
    const vote=store.list('votes').find(v=>v.decisionId==='assigned-decision')!;store.update('votes',vote.id,{runId:run.id});expect(outcome().passed).toBe(true);
  });
  it('requires two distinct staffed projects and stops counting dismissed workers as staffing',()=>{
    store.update('assignments',assignment.id,{schedulerKey:`executive-start:${run.employeeId}`});
    store.command(owner,{type:'department.create',name:'Engineering',managerId:run.employeeId,responsibilities:'Deliver compiler/application work'});
    const position=store.command(owner,{type:'position.create',title:'Implementation specialist',level:'worker',responsibilities:'Implement scoped product changes'}),employee=store.command(owner,{type:'employee.hire',name:'Implementation specialist',positionId:position.id,homeManagerId:run.employeeId,modelId:model});
    const projects=store.list('products').slice(0,2).map(product=>store.command(owner,{type:'project.create',name:`Useful ${product.name} improvement`,productId:product.id,outcome:'Correct observed user friction',acceptance:['Real repository checks pass'],supervisorId:run.employeeId,rationale:'Live product assessment'}));
    const work=projects.map(project=>store.command(owner,{type:'assignment.create',employeeId:employee.id,supervisorId:run.employeeId,projectId:project.id,title:'Implement accepted outcome',instructions:'Inspect and correct the actual issue',acceptance:['Independent review passes'],kind:'implementation'}));
    expect(outcome().passed).toBe(true);
    for(const status of ['parked','blocked','completed','cancelled']){store.update('projects',projects[0].id,{status});expect(outcome().passed).toBe(false);}
    store.update('projects',projects[0].id,{status:'active',productId:null});expect(outcome().passed).toBe(false);store.update('projects',projects[0].id,{productId:projects[0].productId});expect(outcome().passed).toBe(true);
    store.update('projects',projects[0].id,{status:'completed'});store.update('assignments',work[0].id,{status:'completed'});expect(outcome().passed).toBe(false);
    const artifact=store.put('artifacts',{assignmentId:work[0].id,projectId:projects[0].id,employeeId:employee.id,runId:'fixture-author-run',uri:'fixture-reviewed-commit',identity:'fixture-exact-head',kind:'commit',summary:'Fixture independently reviewed outcome',checks:[],verification:{passed:true,identity:'fixture-exact-head',receiptId:'fixture-receipt'}});
    store.put('reviews',{artifactId:artifact.id,artifactIdentity:artifact.identity,employeeId:run.employeeId,runId:'fixture-review-run',verdict:'approved',rationale:'Fixture inspected exact artifact',checks:[]});expect(outcome().passed).toBe(true);
    store.command(owner,{type:'employee.dismiss',employeeId:employee.id,rationale:'Fixture exercises loss of staffing after initial formation'});
    expect(outcome().passed).toBe(false);
  });
});

describe('bounded failure diagnosis',()=>{
  const alternative='qwen3.5:4b';
  function blockedDiagnosis(level:'ceo'|'elder'='ceo',kind='management',decisionId?:string){
    const employee=store.list('employees').find(e=>store.level(e.id)===level)!;
    store.update('assignments',assignment.id,{employeeId:employee.id,supervisorId:employee.id,kind,status:'running',attempts:1,payload:decisionId?{decisionId}:{}});
    store.update('runs',run.id,{employeeId:employee.id,modelId:employee.modelId});
    store.finishRun(run.id,{status:'failed',error:'Local response allowance exhausted before the required checkpoint'});
    const broker=new CorporateBroker(store,root),scheduler=new Scheduler(store,{} as LocalRuntime,broker,'http://localhost');
    (scheduler as any).diagnoseFailure(store.need('runs',run.id));
    const task=store.list('assignments').find(a=>a.schedulerKey===`fault:${run.id}`)!;
    const diagnosticRun=store.claimNext({assignmentId:task.id,workspace:root})!;store.bindSession(diagnosticRun.id,randomUUID(),root);
    const diagnosticActor:Actor={kind:'employee',employeeId:employee.id,runId:diagnosticRun.id,policyRevision:store.policy.revision};
    const outcome=()=>managementOutcome(store,store.need('assignments',task.id),store.need('runs',diagnosticRun.id));
    return {employee,task,diagnosticRun,diagnosticActor,outcome,broker,scheduler};
  }
  it.each(['supervisor','blocked-assignee'])('preserves an Owner %s change during the deferred final response without a model failure diagnosis',async change=>{
    const {task,diagnosticRun,diagnosticActor,broker,scheduler}=blockedDiagnosis();
    await broker.call(diagnosticActor,'record_blocked_diagnosis',{blockedReason:'Exact unavailable prerequisite',rationale:'Scoped diagnosis is recorded',remainingPrerequisite:'Separate authorized prerequisite work'});
    const original=store.need('assignments',assignment.id),commands=store.need('runs',diagnosticRun.id).corporateCommands;
    const position=store.command(owner,{type:'position.create',title:'Alternate supervisor',level:'lead',responsibilities:'Retain Owner reassigned work'});
    const replacement=store.command(owner,{type:'employee.hire',name:'Alternate supervisor',positionId:position.id,homeManagerId:diagnosticRun.employeeId,modelId:model});
    let finish!:(value:RuntimeResult)=>void,entered=false;
    scheduler.runtime={execute:async(request:any)=>{expect(request.finalResponseCheckpoint()).toBe(true);entered=true;return new Promise<RuntimeResult>(resolve=>{finish=resolve;});}} as unknown as LocalRuntime;
    const executing=(scheduler as any).execute(store.need('runs',diagnosticRun.id));while(!entered)await new Promise(resolve=>setImmediate(resolve));
    store.command(owner,{type:'assignment.update',assignmentId:task.id,supervisorId:replacement.id,...(change==='blocked-assignee'?{employeeId:replacement.id,status:'blocked',blockedReason:'Owner retained a new prerequisite'}:{}),rationale:'Owner changed this task while the real final response was pending'});
    const ownerState=store.need('assignments',task.id);
    const result:RuntimeResult={sessionId:store.need('runs',diagnosticRun.id).sessionId!,text:'Actual local final response retained for audit.',modelId:'qwen-main',artifactIdentity:'fixture-local-model',usage:{inputTokens:20,outputTokens:12,requests:4,durationMs:100},messagesPath:join(root,'messages.json'),diagnosticsPath:join(root,'result.json'),completion:{finishReason:'stop',continuations:0,outputLimit:4096,exhausted:false,finalResponse:{state:'observed',sessionId:diagnosticRun.sessionId!,previousMessageId:'previous-native',messageId:'actual-final-user',instructionSha256:'fixture-hash',disabledToolCount:2,requestedAt:new Date().toISOString(),path:join(root,'final-response.json')}}};
    finish(result);await executing;
    expect(store.need('runs',diagnosticRun.id)).toMatchObject({status:'interrupted',text:result.text,runtimeCompletion:result.completion,corporateCommands:commands});
    const retained=store.need('assignments',task.id);expect(retained).toMatchObject({employeeId:ownerState.employeeId,supervisorId:replacement.id,instructions:ownerState.instructions,acceptance:ownerState.acceptance});
    if(change==='blocked-assignee')expect(retained).toEqual(ownerState);else{expect(retained.status).toBe('queued');expect(store.need('runs',diagnosticRun.id).runtimeFailureCode).toBe('checkpoint_superseded');}
    expect(store.need('assignments',assignment.id)).toEqual(original);expect(store.list('assignments').filter(item=>item.schedulerKey?.startsWith('fault:'))).toHaveLength(1);
    expect(store.list('messages').filter(item=>item.runId===diagnosticRun.id)).toEqual([]);
  });
  it('recomputes the full trusted diagnosis checkpoint rather than treating a successful tool as completion',async()=>{
    const {task,diagnosticRun,diagnosticActor,broker}=blockedDiagnosis();const dispatched=store.need('assignments',task.id);
    expect(checkpointFinalResponseReady(store,dispatched,diagnosticRun.id)).toBe(false);
    await broker.call(diagnosticActor,'record_blocked_diagnosis',{blockedReason:'Observed independent prerequisite unavailable',rationale:'Actual fixture investigation is complete',remainingPrerequisite:'A separately assigned prerequisite must finish'});
    expect(checkpointFinalResponseReady(store,dispatched,diagnosticRun.id)).toBe(true);
    const evidence=store.need('runs',diagnosticRun.id).corporateCommands;expect(store.need('assignments',assignment.id).status).toBe('blocked');
    store.update('assignments',assignment.id,{blockedReason:task.payload.baselineBlockedReason});
    expect(checkpointFinalResponseReady(store,dispatched,diagnosticRun.id)).toBe(false);expect(store.need('runs',diagnosticRun.id).corporateCommands).toEqual(evidence);
    store.update('assignments',task.id,{employeeId:'different-employee'});expect(checkpointFinalResponseReady(store,dispatched,diagnosticRun.id)).toBe(false);
  });
  it.each(['ceo','elder'] as const)('schedules one durable diagnosis for a blocked self-supervised %s failure',async level=>{
    const employee=store.list('employees').find(e=>store.level(e.id)===level)!;
    store.update('assignments',assignment.id,{employeeId:employee.id,supervisorId:employee.id,status:'running',attempts:1,priority:12});store.update('runs',run.id,{employeeId:employee.id});
    const scheduler=new Scheduler(store,{execute:async()=>{throw new RuntimeExecutionError('output_limit_exhausted','Local response allowance exhausted');}} as unknown as LocalRuntime,new CorporateBroker(store,root),'http://localhost');
    await (scheduler as any).execute(store.need('runs',run.id));(scheduler as any).reconcileOrganization();(scheduler as any).reconcileOrganization();
    const diagnoses=store.list('assignments').filter(a=>a.schedulerKey===`fault:${run.id}`);expect(diagnoses).toHaveLength(1);expect(diagnoses[0]).toMatchObject({employeeId:employee.id,kind:'management',priority:14,payload:{failedRunId:run.id,failedAssignmentId:assignment.id,baselineModelId:model}});expect(store.need('assignments',assignment.id).status).toBe('blocked');
    expect(diagnoses[0].instructions).not.toContain('Local response allowance exhausted');expect(diagnoses[0].instructions).toContain(run.id);expect(store.need('runs',run.id).error).toContain('Local response allowance exhausted');
    expect(diagnoses[0].instructions).toContain('use create_assignment with direct');expect(diagnoses[0].instructions).toContain('prefer record_blocked_diagnosis with direct');
  });
  it('reconciles the latest blocked failure after a restart gap and does not diagnose a transient retry',()=>{
    store.update('assignments',assignment.id,{status:'running',attempts:1});store.finishRun(run.id,{status:'failed',transient:true,error:'fetch failed'});
    const scheduler=new Scheduler(store,{} as LocalRuntime,new CorporateBroker(store,root),'http://localhost');(scheduler as any).reconcileOrganization();expect(store.list('assignments').some(a=>a.schedulerKey?.startsWith('fault:'))).toBe(false);
    const latest=store.put('runs',{...run,id:undefined,sessionId:randomUUID(),status:'running',attempt:2});store.update('assignments',assignment.id,{status:'running',attempts:2});store.finishRun(latest.id,{status:'failed',error:'Proven nontransient fault'});
    (scheduler as any).reconcileOrganization();expect(store.list('assignments').filter(a=>a.schedulerKey?.startsWith('fault:')).map(a=>a.schedulerKey)).toEqual([`fault:${latest.id}`]);
  });
  it.each(['ceo','elder'] as const)('restricts %s self-model changes to the exact trusted diagnosis, preserving local policy',level=>{
    const employee=store.list('employees').find(e=>store.level(e.id)===level)!;store.update('runs',run.id,{employeeId:employee.id});store.update('assignments',assignment.id,{employeeId:employee.id,supervisorId:employee.id});
    const normal:Actor={kind:'employee',employeeId:employee.id,runId:run.id,policyRevision:store.policy.revision};store.put('models',{name:alternative,local:true,available:true,artifactIdentity:'fixture-local-small'});
    expect(()=>store.command(normal,{type:'employee.model',employeeId:employee.id,modelId:alternative,rationale:'Claimed self authority'})).toThrow(/home management/);
    // Public assignment creation ignores a caller-supplied schedulerKey.
    const forged=store.command(normal,{type:'assignment.create',employeeId:employee.id,title:'Claimed diagnosis',instructions:'Attempt to self-authorize',acceptance:['Fixture'],kind:'management',schedulerKey:`fault:${run.id}`,payload:{failedRunId:run.id,failedAssignmentId:assignment.id}});expect(forged.schedulerKey).toBeUndefined();
    const {diagnosticActor,outcome}=blockedDiagnosis(level),peer=store.list('employees').find(e=>store.level(e.id)==='elder'&&e.id!==employee.id)!;
    expect(()=>store.command(diagnosticActor,{type:'employee.model',employeeId:peer.id,modelId:alternative,rationale:'Unrelated identity'})).toThrow(/home management/);
    expect(()=>store.command(diagnosticActor,{type:'employee.model',employeeId:employee.id,modelId:'openai/cloud',rationale:'Hosted fallback'})).toThrow(/installed permitted local/);
    store.command(diagnosticActor,{type:'employee.model',employeeId:employee.id,modelId:alternative,rationale:'Retained failed run exhausted output; test a smaller installed local model'});expect(outcome().passed).toBe(false);expect(store.canManage(diagnosticActor,employee.id)).toBe(false);
    store.command(diagnosticActor,{type:'assignment.update',assignmentId:assignment.id,employeeId:employee.id,status:'queued',rationale:'Retry exact preserved task with the changed local model'});expect(store.need('assignments',assignment.id).accepted).toBe(true);expect(outcome().passed).toBe(true);
    expect(()=>store.command(diagnosticActor,{type:'employee.model',employeeId:employee.id,modelId:model,rationale:'No longer blocked'})).toThrow(/home management/);
  });
  it('rejects unchanged retries before requeue, and accepts actual instruction correction with current-run evidence',()=>{
    const {diagnosticActor,outcome}=blockedDiagnosis();
    store.command(diagnosticActor,{type:'message.send',content:'Diagnosed and fixed.'});store.command(diagnosticActor,{type:'product.assess',productId:store.list('products')[0].id,assessment:'Unrelated assessment',rationale:'Fixture'});expect(outcome().passed).toBe(false);
    expect(()=>store.command(diagnosticActor,{type:'assignment.update',assignmentId:assignment.id,status:'queued',rationale:'Retry unchanged'})).toThrow(/unchanged retry/);
    expect(()=>store.command(diagnosticActor,{type:'assignment.update',assignmentId:assignment.id,instructions:' ',status:'queued',rationale:'Erase task'})).toThrow(/Revised instructions/);expect(store.need('assignments',assignment.id).status).toBe('blocked');
    store.command(diagnosticActor,{type:'assignment.update',assignmentId:assignment.id,instructions:'Read the one retained assessment, then persist one concrete goal; preserve all acceptance criteria.',rationale:'Narrow the next execution step using retained failed-run output evidence'});expect(outcome().passed).toBe(false);
    store.command(diagnosticActor,{type:'assignment.update',assignmentId:assignment.id,status:'queued',rationale:'Retry exact task using the narrowed first step'});expect(outcome().passed).toBe(true);
  });
  it('requires a changed exact blocked reason and a current-run linked decision for an unresolved diagnosis',()=>{
    const {diagnosticActor,outcome,diagnosticRun}=blockedDiagnosis();
    const input={type:'decision.create',kind:'strategy',subject:'Retain blocked task',rationale:'Observed runtime artifact is unavailable until the retained native receipt can be reconciled',payload:{failedRunId:run.id,failedAssignmentId:assignment.id,disposition:'blocked'}};
    store.command(owner,input);expect(outcome().passed).toBe(false);
    store.command(diagnosticActor,{type:'assignment.update',assignmentId:assignment.id,blockedReason:'Native receipt abc has unresolved ownership; no safe retry until reconciliation.',rationale:'Exact retained native receipt identifies an unresolved process'});expect(outcome().passed).toBe(false);
    store.command(diagnosticActor,{...input,payload:{...input.payload,failedRunId:'unrelated-run'}});expect(outcome().passed).toBe(false);
    const decision=store.command(diagnosticActor,input);expect(decision.runId).toBe(diagnosticRun.id);expect(outcome().passed).toBe(true);expect(store.need('assignments',assignment.id).status).toBe('blocked');
  });
  it('rejects stale diagnosis authority when a newer failed attempt exists',()=>{
    const {diagnosticActor,outcome}=blockedDiagnosis();store.put('models',{name:alternative,local:true,available:true,artifactIdentity:'fixture-local-small'});store.put('runs',{...run,id:undefined,sessionId:randomUUID(),status:'failed',attempt:2});
    expect(()=>store.command(diagnosticActor,{type:'employee.model',employeeId:run.employeeId,modelId:alternative,rationale:'Stale failure context'})).toThrow(/home management/);expect(outcome().passed).toBe(false);
    expect(()=>store.command(diagnosticActor,{type:'assignment.update',assignmentId:assignment.id,status:'queued',rationale:'Stale failure retry'})).toThrow(/latest failed attempt/);expect(store.need('assignments',assignment.id).status).toBe('blocked');
  });
  it('does not recursively diagnose a failed diagnosis task',async()=>{
    const {task,diagnosticRun,scheduler}=blockedDiagnosis();scheduler.runtime={execute:async()=>{throw new RuntimeExecutionError('runtime_failed','Diagnosis runtime failed');}} as unknown as LocalRuntime;
    await (scheduler as any).execute(store.need('runs',diagnosticRun.id));(scheduler as any).reconcileOrganization();
    expect(store.need('assignments',task.id).status).toBe('blocked');expect(store.list('assignments').filter(a=>a.schedulerKey?.startsWith('fault:'))).toHaveLength(1);
  });
  it.each(['completed','cancelled'] as const)('denies broker correction writes after original work becomes %s, preserving history',async status=>{
    const {diagnosticActor,diagnosticRun,broker,outcome}=blockedDiagnosis();
    if(status==='cancelled')store.command(owner,{type:'assignment.update',assignmentId:assignment.id,status:'cancelled',rationale:'Owner cancelled preserved work'});
    else store.update('assignments',assignment.id,{status:'completed',completionEvidence:{source:'fixture trusted completed outcome'}});
    const target=store.need('assignments',assignment.id),failed=store.need('runs',run.id);
    await expect(broker.call(diagnosticActor,'company_command',{command:{type:'assignment.update',assignmentId:assignment.id,instructions:'Overwrite the terminal task',rationale:'Old diagnosis still trying to correct'}})).rejects.toMatchObject({code:'stale_diagnosis'});
    expect(store.need('assignments',assignment.id)).toEqual(target);expect(store.need('runs',run.id)).toEqual(failed);expect(store.need('runs',diagnosticRun.id).corporateCommands??[]).toEqual([]);expect(store.faultContext(diagnosticRun.id)).toBeUndefined();expect(outcome().passed).toBe(false);
  });
  it('defers governance proposed from a fault diagnosis until each peer records its original independent vote',async()=>{
    const decision=store.command(owner,{type:'decision.create',kind:'executive.review',subject:'Original governance review',rationale:'Actual outcome',payload:{employeeId:run.employeeId}}),{diagnosticActor,broker,scheduler}=blockedDiagnosis('elder','governance',decision.id);
    const secret=await broker.call(diagnosticActor,'company_command',{command:{type:'decision.create',kind:'executive.review',subject:'PRIVATE_FAULT_JUDGMENT',rationale:'Tentative judgment from failed initial review',payload:{employeeId:run.employeeId}}});
    const peer=store.list('employees').find(e=>store.level(e.id)==='elder'&&e.id!==diagnosticActor.employeeId)!,peerAssignment=store.command(owner,{type:'assignment.create',employeeId:peer.id,supervisorId:peer.id,kind:'governance',title:'Original independent vote',instructions:'Judge original independently',acceptance:['Actual vote'],payload:{decisionId:decision.id}}),peerRun=store.put('runs',{...run,id:undefined,sessionId:randomUUID(),employeeId:peer.id,assignmentId:peerAssignment.id,status:'running'}),peerActor:Actor={kind:'employee',employeeId:peer.id,runId:peerRun.id,policyRevision:store.policy.revision};
    (scheduler as any).reconcileOrganization();expect(store.list('assignments').filter(a=>a.payload?.decisionId===secret.id)).toEqual([]);
    expect(JSON.stringify(await broker.call(peerActor,'company_read',{collection:'assignments',limit:30}))).not.toContain('PRIVATE_FAULT_JUDGMENT');expect(JSON.stringify(broker.promptContext(peerActor))).not.toContain('PRIVATE_FAULT_JUDGMENT');
    await expect(broker.call(peerActor,'company_detail',{collection:'decisions',id:secret.id})).rejects.toThrow(/authorized scope/);
    await broker.call(peerActor,'company_command',{command:{type:'decision.vote',decisionId:decision.id,approve:false,rationale:'My independently formed original judgment'}});(scheduler as any).reconcileOrganization();
    const children=store.list('assignments').filter(a=>a.payload?.decisionId===secret.id);expect(children.map(a=>a.employeeId)).toEqual([peer.id]);expect(children[0].title).toContain('PRIVATE_FAULT_JUDGMENT');expect((await broker.call(peerActor,'company_detail',{collection:'decisions',id:secret.id})).content).toContain('PRIVATE_FAULT_JUDGMENT');
    const third=store.list('employees').find(e=>store.level(e.id)==='elder'&&e.id!==diagnosticActor.employeeId&&e.id!==peer.id)!,thirdAssignment=store.list('assignments').find(a=>a.payload?.decisionId===decision.id&&a.employeeId===third.id)!,thirdRun=store.put('runs',{...run,id:undefined,sessionId:randomUUID(),employeeId:third.id,assignmentId:thirdAssignment.id,status:'running'}),thirdActor:Actor={kind:'employee',employeeId:third.id,runId:thirdRun.id,policyRevision:store.policy.revision};
    expect(JSON.stringify(await broker.call(thirdActor,'company_read',{collection:'assignments',limit:30}))).not.toContain('PRIVATE_FAULT_JUDGMENT');expect(JSON.stringify(broker.promptContext(thirdActor))).not.toContain('PRIVATE_FAULT_JUDGMENT');await expect(broker.call(thirdActor,'company_detail',{collection:'assignments',id:children[0].id})).rejects.toThrow(/authorized scope/);
    // A child-task vote and subsequent proposal must retain the same hidden origin.
    const childRun=store.put('runs',{...peerRun,id:undefined,sessionId:randomUUID(),assignmentId:children[0].id}),childActor:Actor={...peerActor,runId:childRun.id};
    await broker.call(childActor,'company_command',{command:{type:'decision.vote',decisionId:secret.id,approve:false,rationale:'PRIVATE_FAULT_JUDGMENT'}});
    const descendant=await broker.call(childActor,'company_command',{command:{type:'decision.create',kind:'strategy',subject:'PRIVATE_FAULT_JUDGMENT descendant',rationale:'Retain the origin judgment',payload:{}}});
    expect(store.snapshot(thirdActor).decisions.some(d=>d.id===descendant.id)).toBe(false);expect(JSON.stringify(await broker.call(thirdActor,'company_read',{collection:'runs',limit:30}))).not.toContain(childRun.id);await expect(broker.call(thirdActor,'company_detail',{collection:'decisions',id:descendant.id})).rejects.toThrow(/authorized scope/);
    await broker.call(thirdActor,'company_command',{command:{type:'decision.vote',decisionId:decision.id,approve:true,rationale:'Third independently formed judgment'}});expect(store.snapshot(thirdActor).decisions.some(d=>d.id===secret.id)).toBe(true);expect(store.snapshot(thirdActor).decisions.some(d=>d.id===descendant.id)).toBe(false);
    (scheduler as any).reconcileOrganization();const thirdChild=store.list('assignments').find(a=>a.payload?.decisionId===secret.id&&a.employeeId===third.id)!,thirdChildRun=store.put('runs',{...thirdRun,id:undefined,sessionId:randomUUID(),assignmentId:thirdChild.id}),thirdChildActor:Actor={...thirdActor,runId:thirdChildRun.id};
    await broker.call(thirdChildActor,'company_command',{command:{type:'decision.vote',decisionId:secret.id,approve:true,rationale:'Third independently formed child judgment'}});expect((await broker.call(thirdChildActor,'company_detail',{collection:'assignments',id:children[0].id})).content).toContain('PRIVATE_FAULT_JUDGMENT');expect(store.snapshot(thirdChildActor).decisions.some(d=>d.id===descendant.id)).toBe(true);
  });
  it('does not diagnose a persisted vote even when its runtime subsequently fails',async()=>{
    const elder=store.list('employees').find(e=>store.level(e.id)==='elder')!,decision=store.command(owner,{type:'decision.create',kind:'executive.review',subject:'Review',rationale:'Actual work evidence',payload:{employeeId:run.employeeId}});
    store.update('assignments',assignment.id,{employeeId:elder.id,supervisorId:elder.id,kind:'governance',payload:{decisionId:decision.id},status:'running'});store.update('runs',run.id,{employeeId:elder.id});
    const elderActor:Actor={kind:'employee',employeeId:elder.id,runId:run.id,policyRevision:store.policy.revision};
    const scheduler=new Scheduler(store,{execute:async()=>{store.command(elderActor,{type:'decision.vote',decisionId:decision.id,approve:false,rationale:'Independent dissent retained before response failure'});throw new RuntimeExecutionError('output_limit_exhausted','Response exhausted after durable vote');}} as unknown as LocalRuntime,new CorporateBroker(store,root),'http://localhost');
    await (scheduler as any).execute(store.need('runs',run.id));(scheduler as any).reconcileOrganization();expect(store.need('assignments',assignment.id).status).toBe('completed');expect(store.list('assignments').some(a=>a.schedulerKey===`fault:${run.id}`)).toBe(false);expect(store.list('votes').find(v=>v.decisionId===decision.id)?.approve).toBe(false);
  });
  it('keeps peer governance diagnosis evidence blind before an initial vote',()=>{
    const decision=store.command(owner,{type:'decision.create',kind:'executive.review',subject:'Review',rationale:'Actual work evidence',payload:{employeeId:run.employeeId}}),{diagnosticActor,diagnosticRun,task,broker}=blockedDiagnosis('elder','governance',decision.id);
    const secret=store.command(diagnosticActor,{type:'decision.create',kind:'strategy',subject:'Private failed-judgment diagnosis',rationale:'Contains a tentative initial judgment',payload:{failedRunId:run.id,failedAssignmentId:assignment.id,disposition:'blocked'}});
    store.put('models',{name:alternative,local:true,available:true,artifactIdentity:'fixture-local-small'});store.command(diagnosticActor,{type:'employee.model',employeeId:diagnosticActor.employeeId,modelId:alternative,rationale:'Private failure analysis with tentative judgment'});
    const peer=store.list('employees').find(e=>store.level(e.id)==='elder'&&e.id!==diagnosticActor.employeeId)!;
    const peerAssignment=store.command(owner,{type:'assignment.create',employeeId:peer.id,supervisorId:peer.id,kind:'governance',title:'Independent initial vote',instructions:'Judge independently',acceptance:['Actual vote'],payload:{decisionId:decision.id}}),peerRun=store.put('runs',{...run,id:undefined,sessionId:randomUUID(),employeeId:peer.id,assignmentId:peerAssignment.id,status:'running'}),peerActor:Actor={kind:'employee',employeeId:peer.id,runId:peerRun.id,policyRevision:store.policy.revision};
    expect(store.snapshot(peerActor).decisions.some(d=>d.id===secret.id)).toBe(false);expect(store.snapshot(peerActor).employees.find(e=>e.id===diagnosticActor.employeeId)?.modelRationale).toBeUndefined();expect(JSON.stringify(broker.companyRead(peerActor,{collection:'runs',limit:30}))).not.toContain(diagnosticRun.id);expect(JSON.stringify(broker.companyRead(peerActor,{collection:'assignments',limit:30}))).not.toContain(task.id);
    store.command(peerActor,{type:'decision.vote',decisionId:decision.id,approve:false,rationale:'Own independent judgment'});expect(store.snapshot(peerActor).decisions.some(d=>d.id===secret.id)).toBe(true);
  });
  it('persists actual early runtime failure evidence without inventing message or session paths',async()=>{
    store.update('assignments',assignment.id,{status:'running'});store.update('runs',run.id,{sessionId:null});
    const evidence={runId:run.id,modelId:'qwen-main',artifactIdentity:'actual-local-digest',usage:{inputTokens:0,outputTokens:0,requests:0,durationMs:80},diagnosticsPath:join(root,'failure.json'),messagesSource:'unavailable' as const,databasePath:join(root,'runtime.sqlite'),continuations:0,code:'runtime_failed' as const,error:'Early provider rejection',capturedAt:new Date().toISOString()};
    const scheduler=new Scheduler(store,{execute:async()=>{throw new RuntimeExecutionError('runtime_failed',evidence.error,undefined,{evidence});}} as unknown as LocalRuntime,new CorporateBroker(store,root),'http://localhost');await (scheduler as any).execute(store.need('runs',run.id));
    const retained=store.need('runs',run.id);expect(retained).toMatchObject({modelIdentity:evidence.artifactIdentity,usage:evidence.usage,runtimeDiagnosticsPath:evidence.diagnosticsPath,runtimeFailureEvidence:evidence});expect(retained.messagesPath).toBeUndefined();expect(retained.sessionId).toBeNull();
  });
});

describe('artifact-specific delivery scheduling',()=>{
 function milestone(){
  const project=store.command(owner,{type:'project.create',name:'Finite multi-step outcome',productId:store.list('products')[0].id,outcome:'Two actual milestones',acceptance:['Both behaviors delivered'],supervisorId:run.employeeId,rationale:'Real scoped project'});
  const original=store.command(owner,{type:'assignment.create',projectId:project.id,employeeId:run.employeeId,title:'Narrow milestone',instructions:'Specific source change',acceptance:['Narrow behavior works'],kind:'implementation'});
  const artifact=store.put('artifacts',{projectId:project.id,assignmentId:original.id,employeeId:'independent-author',runId:'independent-author-run',identity:'next-head',uri:'actual-fixture-commit',kind:'commit',summary:'Second useful behavior',checks:[]});store.put('reviews',{artifactId:artifact.id,artifactIdentity:artifact.identity,employeeId:run.employeeId,runId:run.id,verdict:'approved',rationale:'Independent actual fixture review',checks:[]});
  const old={artifactId:'earlier-artifact',identity:'earlier-head',state:'merged',prNumber:3,prUrl:'https://github.com/fixture/product/pull/3',mergeCommit:'earlier-merge',defaultBranchHead:'earlier-merge',workspaceAdvance:{state:'completed'}};store.update('projects',project.id,{delivery:old});
  return {project,artifact,old};
 }
 it('schedules a new reviewed artifact after an earlier merge and does not accept the old PR as its checkpoint',()=>{
  const {project,artifact}=milestone(),scheduler=new Scheduler(store,{} as LocalRuntime,new CorporateBroker(store,root),'http://localhost');(scheduler as any).reconcileOrganization();
  const task=store.list('assignments').find(item=>item.schedulerKey===`deliver:${artifact.id}`)!;expect(task).toBeDefined();expect(task.payload.artifactId).toBe(artifact.id);expect(task.instructions).toContain('remainingGate');
  expect(managementOutcome(store,task,run).passed).toBe(false);const receipt={artifactId:artifact.id,identity:artifact.identity,state:'awaiting_checks',prUrl:'https://github.com/fixture/product/pull/4',prNumber:4};store.update('projects',project.id,{deliveryHistory:[receipt]});expect(managementOutcome(store,task,run).passed).toBe(true);
  store.update('assignments',task.id,{payload:{artifactId:artifact.id,mergeReady:true}});expect(managementOutcome(store,store.need('assignments',task.id),run).passed).toBe(false);store.update('projects',project.id,{deliveryHistory:[{...receipt,state:'merged'}]});expect(managementOutcome(store,store.need('assignments',task.id),run).passed).toBe(true);
 });
 it.each([undefined,{state:'prepared'}])('holds new publication while a new-style merged workspace advancement is %s',advance=>{
  const {project,artifact,old}=milestone();store.update('projects',project.id,{delivery:{...old,publicationActionId:'actual-publication',workspaceAdvance:advance}});const scheduler=new Scheduler(store,{} as LocalRuntime,new CorporateBroker(store,root),'http://localhost');(scheduler as any).reconcileOrganization();expect(store.list('assignments').some(item=>item.schedulerKey===`deliver:${artifact.id}`)).toBe(false);
 });
 it('does not schedule GitHub publication for reviewed internal tools',()=>{
  const {project,artifact}=milestone();store.update('products',project.productId,{kind:'internal-tool'});
  const scheduler=new Scheduler(store,{} as LocalRuntime,new CorporateBroker(store,root),'http://localhost');(scheduler as any).reconcileOrganization();
  expect(store.list('assignments').some(item=>item.schedulerKey===`deliver:${artifact.id}`)).toBe(false);
  expect(store.hasApprovedArtifact(artifact.assignmentId,artifact.identity)).toBe(true);
  expect(store.need('products',project.productId).adoption).toBeUndefined();
 });
});


describe('trusted broker-first advancement continuation',()=>{
 function continuation(){
  const project=store.command(owner,{type:'project.create',name:'Pending merge advancement',productId:store.list('products')[0].id,outcome:'Continue preserved source safely',acceptance:['Observed advancement'],supervisorId:run.employeeId,rationale:'Actual fixture merge'});
  const receipt={artifactId:'pending-artifact',identity:'reviewed-head',state:'merged',prNumber:4,prUrl:'https://github.com/fixture/product/pull/4',publicationActionId:'actual-publication',mergeCommit:'observed-merge',workspaceAdvance:{state:'prepared',from:'reviewed-head',to:'observed-merge'}};store.update('projects',project.id,{delivery:receipt});
  store.update('assignments',assignment.id,{projectId:project.id,kind:'management',schedulerKey:'merge-ready:pending-artifact:reviewed-head',payload:{artifactId:'pending-artifact',mergeReady:true},status:'running'});return {project,receipt};
 }
 it('reuses the retained interrupted exact continuation instead of creating another assignment',()=>{
  const {project}=continuation();store.finishRun(run.id,{status:'interrupted',error:'Observed pause while advancing'});const scheduler=new Scheduler(store,{} as LocalRuntime,new CorporateBroker(store,root),'http://localhost');(scheduler as any).reconcileOrganization();
  expect(store.need('assignments',assignment.id).status).toBe('queued');expect(store.list('assignments').filter(item=>item.projectId===project.id&&item.payload?.mergeReady)).toHaveLength(1);
 });
 it('creates one observed-merge continuation if none remains, without an external dispatch',()=>{
  const {project}=continuation();store.update('assignments',assignment.id,{status:'completed'});const scheduler=new Scheduler(store,{} as LocalRuntime,new CorporateBroker(store,root),'http://localhost');(scheduler as any).reconcileOrganization();(scheduler as any).reconcileOrganization();
  const tasks=store.list('assignments').filter(item=>item.schedulerKey==='workspace-advance:pending-artifact:observed-merge');expect(tasks).toHaveLength(1);expect(tasks[0]).toMatchObject({projectId:project.id,kind:'management',status:'queued',payload:{artifactId:'pending-artifact',mergeReady:true}});expect(store.list('actions')).toHaveLength(0);
 });
 it.each(['confirmed','still-pending','pause'] as const)('admits inference only after active exact broker advancement is %s',outcome=>{
  return (async()=>{
   const {project,receipt}=continuation(),broker=new CorporateBroker(store,root),calls:string[]=[];let release!:()=>void,reached!:()=>void;const started=new Promise<void>(resolve=>{reached=resolve;}),wait=new Promise<void>(resolve=>{release=resolve;});
   vi.spyOn(broker.github,'merge').mockImplementation(async()=>{calls.push('broker');reached();await wait;if(outcome!=='still-pending')store.update('projects',project.id,{delivery:{...receipt,workspaceAdvance:{...receipt.workspaceAdvance,state:'completed'}}});return {state:'merged',url:receipt.prUrl,prUrl:receipt.prUrl,prNumber:4,mergeCommit:receipt.mergeCommit,defaultBranchHead:receipt.mergeCommit};});
   const execute=vi.fn(async()=>{calls.push('inference');throw new Error('End bounded inference admission fixture');}),scheduler=new Scheduler(store,{execute} as unknown as LocalRuntime,broker,'http://localhost');
   const pending=(scheduler as any).execute(store.need('runs',run.id));await started;expect(execute).not.toHaveBeenCalled();if(outcome==='pause')store.command(owner,{type:'control',action:'pause'});release();await pending;
   expect(calls).toEqual(outcome==='confirmed'?['broker','inference']:['broker']);if(outcome==='still-pending')expect(store.need('runs',run.id).error).toContain('native runtime remains held');
  })();
 });
});

describe('company-workspace diagnosis of held product advancement',()=>{
 function failedAdvancement(){
  const project=store.command(owner,{type:'project.create',name:'Preserve failed advancement',productId:store.list('products')[0].id,outcome:'Reconcile the exact retained merge',acceptance:['Safe workspace advancement'],supervisorId:run.employeeId,rationale:'Concrete fixture merge'});
  store.update('projects',project.id,{delivery:{artifactId:'held-artifact',identity:'held-head',state:'merged',prNumber:5,prUrl:'https://github.com/fixture/product/pull/5',mergeCommit:'held-merge',publicationActionId:'observed-publication',workspaceAdvance:{state:'prepared',from:'held-head',to:'held-merge'}}});
  store.update('assignments',assignment.id,{projectId:project.id,kind:'management',schedulerKey:'workspace-advance:held-artifact:held-merge',payload:{artifactId:'held-artifact',mergeReady:true},status:'running'});
  const failed=store.finishRun(run.id,{status:'failed',error:'Owned workspace changed during merge observation; preserve it for reconciliation.'});
  return {project,failed,scheduler:new Scheduler(store,{} as LocalRuntime,new CorporateBroker(store,root),'http://localhost')};
 }
 it('dispatches exact failure diagnosis in a company workspace while product effects remain denied',async()=>{
  const {project,failed,scheduler}=failedAdvancement();(scheduler as any).reconcileOrganization();
  const task=store.list('assignments').find(item=>item.schedulerKey===`fault:${failed.id}`)!;expect(task).toMatchObject({projectId:null,status:'queued',employeeId:run.employeeId,payload:{sourceProjectId:project.id,advancementArtifactId:'held-artifact',failedRunId:failed.id,failedAssignmentId:assignment.id}});expect(task.instructions).toContain('Product native writes');
  const diagnosticRun=store.claimNext({assignmentId:task.id,workspace:join(root,'company-diagnosis')})!;expect(diagnosticRun).toBeDefined();store.bindSession(diagnosticRun.id,randomUUID());const diagnosticActor={kind:'employee',employeeId:diagnosticRun.employeeId,runId:diagnosticRun.id,policyRevision:diagnosticRun.policyRevision} as const,broker=new CorporateBroker(store,root);
  expect(JSON.parse((await broker.call(diagnosticActor,'company_detail',{collection:'projects',id:project.id})).content).delivery.workspaceAdvance.state).toBe('prepared');expect(JSON.parse((await broker.call(diagnosticActor,'company_detail',{collection:'runs',id:failed.id})).content).error).toContain('Owned workspace changed');
  await expect(broker.call(diagnosticActor,'deliver_product',{artifactId:'held-artifact'})).rejects.toMatchObject({code:'product_project_required'});await expect(broker.call(diagnosticActor,'company_command',{command:{type:'assignment.update',assignmentId:assignment.id,status:'queued',rationale:'Retry unchanged'}})).rejects.toMatchObject({code:'unchanged_retry'});
  await broker.call(diagnosticActor,'company_command',{command:{type:'assignment.update',assignmentId:assignment.id,blockedReason:'Preserved files require source reconciliation before any reset',rationale:'Observed exact failure and retained advancement intent'}});await broker.call(diagnosticActor,'company_command',{command:{type:'decision.create',kind:'strategy',subject:'Retain blocked advancement',rationale:'Actual preserved-file prerequisite remains',payload:{failedRunId:failed.id,failedAssignmentId:assignment.id,disposition:'blocked'}}});
  expect(managementOutcome(store,task,store.need('runs',diagnosticRun.id)).passed).toBe(true);expect(store.need('assignments',assignment.id).status).toBe('blocked');expect(store.list('actions')).toHaveLength(0);expect(store.need('projects',project.id).delivery.workspaceAdvance.state).toBe('prepared');
 });
 it('relocates one existing queued project-bound diagnosis without duplicating or retrying the failed continuation',()=>{
  const {project,failed,scheduler}=failedAdvancement();(scheduler as any).reconcileOrganization();const task=store.list('assignments').find(item=>item.schedulerKey===`fault:${failed.id}`)!;store.update('assignments',task.id,{projectId:project.id});
  (scheduler as any).reconcileOrganization();(scheduler as any).reconcileOrganization();expect(store.list('assignments').filter(item=>item.schedulerKey===task.schedulerKey)).toHaveLength(1);expect(store.need('assignments',task.id).projectId).toBeNull();expect(store.need('assignments',assignment.id).status).toBe('blocked');expect(store.list('actions')).toHaveLength(0);expect(store.list('assignments').filter(item=>item.projectId===project.id&&item.payload?.mergeReady)).toHaveLength(1);
 });
});

describe('blocked governance application follow-through',()=>{
 it.each(['corrected proposal','withdrawal'])('queues one accountable correction and requires linked %s evidence',correctionKind=>{
  const executive=store.need('employees',run.employeeId),payload={positionId:executive.positionId,name:'Additional CEO',modelId:model};
  const decision=store.command(actor,{type:'decision.create',kind:'executive.appoint',subject:'Actual occupied office proposal',rationale:'Actual independently judged proposal',payload});
  for(const elder of store.list('employees').filter(e=>store.level(e.id)==='elder')){
   const task=store.command(owner,{type:'assignment.create',employeeId:elder.id,title:'Independent vote',instructions:'Judge proposal independently',acceptance:['Actual vote'],kind:'governance',payload:{decisionId:decision.id}});
   const voteRun=store.put('runs',{...run,id:undefined,employeeId:elder.id,assignmentId:task.id,sessionId:randomUUID()});
   store.command({kind:'employee',employeeId:elder.id,runId:voteRun.id,policyRevision:store.policy.revision},{type:'decision.vote',decisionId:decision.id,approve:true,rationale:'Independent majority judgment'});
  }
  const retained=store.need('decisions',decision.id),votes=store.list('votes'),scheduler=new Scheduler(store,{} as LocalRuntime,new CorporateBroker(store,root),'http://localhost');
  expect(retained).toMatchObject({status:'approved',application:{status:'blocked',code:'occupied_position'}});
  const apply=vi.spyOn(store as any,'applyGovernance');(scheduler as any).reconcileOrganization();(scheduler as any).reconcileOrganization();
  const tasks=store.list('assignments').filter(a=>a.schedulerKey===`governance-application:${decision.id}`);expect(tasks).toHaveLength(1);expect(apply).not.toHaveBeenCalled();
  const task=tasks[0],correctionRun=store.put('runs',{...run,id:undefined,assignmentId:task.id,sessionId:randomUUID()}),correctionActor:Actor={kind:'employee',employeeId:run.employeeId,runId:correctionRun.id,policyRevision:store.policy.revision},check=()=>managementOutcome(store,task,store.need('runs',correctionRun.id));
  expect(check().passed).toBe(false);
  const voteIds=votes.filter(v=>v.decisionId===decision.id).map(v=>v.id);
  const propose=(kind:string,extra:Record<string,unknown>)=>store.command(correctionActor,{type:'decision.create',kind,subject:'Correct the unapplied operation',rationale:'Preserve incumbent and existing governance; actual correction judgment',payload:extra});
  propose('strategy',{disposition:'withdrawn'});expect(check().passed).toBe(false);
  propose('executive.appoint',{...payload,sourceDecisionId:decision.id,reviewedVoteIds:voteIds});expect(check().passed).toBe(false);
  if(correctionKind==='withdrawal')propose('strategy',{disposition:'withdrawn',sourceDecisionId:decision.id,reviewedVoteIds:voteIds});
  else propose('executive.replace',{...payload,sourceDecisionId:decision.id,reviewedVoteIds:voteIds});
  expect(check().passed).toBe(true);store.update('assignments',task.id,{status:'completed'});
  const restarted=new Scheduler(store,{} as LocalRuntime,new CorporateBroker(store,root),'http://localhost');(restarted as any).reconcileOrganization();
  expect(store.list('assignments').filter(a=>a.schedulerKey===task.schedulerKey)).toHaveLength(1);expect(apply).not.toHaveBeenCalled();expect(store.need('decisions',decision.id)).toEqual(retained);expect(store.list('votes')).toEqual(votes);
 });
});


it('does not dispatch an application correction to an unvoted Elder after an Owner override',()=>{
 const executive=store.need('employees',run.employeeId),decision=store.command(actor,{type:'decision.create',kind:'executive.appoint',subject:'Occupied office',rationale:'Actual proposed operation',payload:{positionId:executive.positionId,name:'Additional CEO',modelId:model}});
 store.command(owner,{type:'decision.override',decisionId:decision.id,approve:true,rationale:'Explicit Owner judgment'});
 const scheduler=new Scheduler(store,{} as LocalRuntime,new CorporateBroker(store,root),'http://localhost');(scheduler as any).reconcileOrganization();
 const correction=store.list('assignments').find(a=>a.schedulerKey===`governance-application:${decision.id}`)!,elder=store.list('employees').find(e=>store.level(e.id)==='elder')!;
 expect(governanceDispatchAllowed(store,correction)).toBe(true);expect(governanceDispatchAllowed(store,{...correction,employeeId:elder.id})).toBe(false);
});

describe('formation receipt-based ending instructions',()=>{
 it.each([true,false])('explains ending while the actual bootstrap checkpoint enforces retained hire=%s',async hasHire=>{
   store.update('company',store.company.id,{direction:undefined});store.command(owner,{type:'company.expand',mandate:'Resume real recruitment formation'});
   const department=store.command(owner,{type:'department.create',name:'Recruitment & Workforce Planning',managerId:run.employeeId,responsibilities:'Scoped recruitment'});
   const position=store.command(owner,{type:'position.create',title:'Recruitment Officer',level:'worker',departmentId:department.id,responsibilities:'Adapt narrow source competencies'});
   if(hasHire)store.command(owner,{type:'employee.hire',name:'Retained recruiter',positionId:position.id,homeManagerId:run.employeeId,modelId:model,role:'Source and adapt competencies under managerial authority'});
   assignment=store.update('assignments',assignment.id,{status:'running',schedulerKey:'formation:recruiter-bootstrap',instructions:'Bootstrap the Recruitment Officer using actual source adaptations and company tools.'});
   const employeeCount=store.list('employees').length;
   const result:RuntimeResult={sessionId:'session',text:`Recruitment Officer position ${position.id}: ${hasHire?'the existing hire is retained':'no hire is recorded'}.`,modelId:model,artifactIdentity:'fixture-local-model',usage:{inputTokens:20,outputTokens:10,requests:1,durationMs:10},messagesPath:join(root,'fixture-messages.json'),diagnosticsPath:join(root,'fixture-diagnostics.json'),completion:{finishReason:'stop',continuations:0,outputLimit:4096,exhausted:false}};
   const execute=vi.fn(async(_request:any)=>result),scheduler=new Scheduler(store,{execute} as unknown as LocalRuntime,new CorporateBroker(store,root),'http://localhost');
   expect(managementOutcome(store,assignment,run).passed).toBe(hasHire);expect(checkpointFinalResponseEligible(assignment)).toBe(false);
   await (scheduler as any).execute(run);
   const request=execute.mock.calls[0][0];expect(request.system).toContain('It may already be retained from an earlier interrupted run');expect(request.system).toContain('briefly summarize its actual record IDs and result, then end');expect(request.system).toContain('a summary alone never substitutes for a missing required action');
   expect(request.system).not.toContain('Final prose is not a deliverable');expect(request.system).not.toContain('Product implementations require commit_work');expect(request.prompt).not.toContain('inspect preserved files before continuing');expect(request.finalResponseCheckpoint).toBeUndefined();
   expect(store.list('employees')).toHaveLength(employeeCount);expect(store.list('artifacts')).toHaveLength(0);expect(store.need('runs',run.id).status).toBe(hasHire?'succeeded':'failed');expect(store.need('assignments',assignment.id).status==='completed').toBe(hasHire);
 });
 it('keeps commit, canonical verification and independent review instructions for implementation runs',async()=>{
  assignment=store.update('assignments',assignment.id,{kind:'implementation',status:'running'});
  const execute=vi.fn(async(_request:any)=>{throw new Error('Fixture ends at runtime dispatch');}),scheduler=new Scheduler(store,{execute} as unknown as LocalRuntime,new CorporateBroker(store,root),'http://localhost');
  await (scheduler as any).execute(run);
  expect(execute.mock.calls[0][0].system).toContain('Product implementations require commit_work, actual verify_product receipts, and independent review_work before delivery.');expect(execute.mock.calls[0][0].system).not.toContain('This is company formation work');
 });
});

it('retains external pull-request import guidance on a review runtime dispatch',async()=>{
 const project=store.command(owner,{type:'project.create',name:'Review external contribution',outcome:'Assess actual imported source',acceptance:['Independent review'],rationale:'External contribution review',supervisorId:run.employeeId});
 const original=store.put('assignments',{employeeId:'external-author',supervisorId:run.employeeId,projectId:project.id,kind:'implementation',status:'awaiting_review'});
 const artifact=store.put('artifacts',{assignmentId:original.id,projectId:project.id,employeeId:'external-author',runId:'external-author-run',kind:'commit',identity:'fixture-head',uri:'fixture://external-pr'});
 assignment=store.update('assignments',assignment.id,{kind:'review',projectId:project.id,status:'running',payload:{artifactId:artifact.id,pullRequest:{number:7}}});
 const execute=vi.fn(async(_request:any)=>{throw new Error('Fixture ends at runtime dispatch');}),broker=new CorporateBroker(store,root);
 vi.spyOn(broker.workspaces,'preparePullRequest').mockResolvedValue(undefined as any);
 const scheduler=new Scheduler(store,{execute} as unknown as LocalRuntime,broker,'http://localhost');await (scheduler as any).execute(run);
 expect(execute).toHaveBeenCalledOnce();const system=execute.mock.calls[0][0].system;
 expect(system).toContain('This assignment imports externally authored code: use import_pull_request, actual verify_product receipts, and independent review_work before binding delivery.');expect(system).toContain('Never use commit_work or record_artifact to relabel this candidate.');expect(system).not.toContain('Product implementations require commit_work');expect(system).toContain('This is an independent review assignment.');
});

it.each(['nemotron-no-thinking-v1', 'qwen-main-48k'])('registers selectable %s alongside its default and permits one employee selection', async profileId => {
  const sourceAlias = 'wlkr-management-nemotron-3.5-lightning-30b-a3b-q4-0:latest';
  const baseline = { id: 'nemotron', name: sourceAlias, sourceAlias, alias: 'opencorp-nemotron-16384:latest', artifactIdentity: 'default', size: 18e9, local: true, available: true, capabilities: ['tools'] };
  const variant = { ...baseline, id: profileId, name: profileId === 'qwen-main-48k' ? 'Qwen (48K context)' : 'Nemotron (no thinking)', artifactIdentity: 'variant' };
  const runtime = { installModels: vi.fn().mockResolvedValue([baseline, variant]) } as unknown as LocalRuntime;
  const scheduler = new Scheduler(store, runtime, new CorporateBroker(store, root), 'http://127.0.0.1:1');
  await scheduler.initialize();
  expect(store.need('models', sourceAlias).artifactIdentity).toBe('default');
  expect(store.need('models', variant.id).artifactIdentity).toBe('variant');
  expect(store.need('models', variant.id).sizeClass).toBe('large');
  const employees = store.list('employees'), target = employees[0]!;
  const others = employees.filter(e => e.id !== target.id).map(e => [e.id, e.modelId]);
  store.command(owner, { type: 'employee.model', employeeId: target.id, modelId: variant.id, rationale: 'Bounded qualified profile trial' });
  expect(store.need('employees', target.id).modelId).toBe(variant.id);
  store.command(owner, { type: 'employee.model', employeeId: target.id, modelId: variant.name, rationale: 'Select the verified profile by its display name' });
  expect(selectLocalModel([variant, baseline] as LocalModel[], store.need('employees', target.id).modelId)).toBe(variant);
  expect(others.every(([id, modelId]) => store.need('employees', id).modelId === modelId)).toBe(true);
});

 it.each(['approved','hired'])('aged provisioning waits for current approval, then permits %s retained state',async finalStatus=>{
 store.update('runs',run.id,{status:'succeeded'});store.update('assignments',assignment.id,{status:'completed'});
 const department=store.put('departments',{name:'Current staffing',managerId:run.employeeId,status:'active'}),position=store.put('positions',{title:'Worker',level:'worker',departmentId:department.id,status:'active'});
 const req=store.put('experiences',{kind:'requisition',status:'open',departmentId:department.id,positionId:position.id,departmentManagerId:run.employeeId,homeManagerId:run.employeeId,recruiterId:run.employeeId});
 const candidate=store.put('experiences',{kind:'candidate',status:'proposed',version:3,requisitionId:req.id});
 const provision=store.command(owner,{type:'assignment.create',employeeId:run.employeeId,title:'Retained provision',instructions:'Provision approved candidate',acceptance:['Actual hire'],kind:'management',priority:88});
 store.update('assignments',provision.id,{schedulerKey:`formation:provision:${candidate.id}`,payload:{formation:true},createdAt:new Date(Date.now()-10*3600000).toISOString()});
 const review=store.command(owner,{type:'assignment.create',employeeId:run.employeeId,title:'Current review',instructions:'Judge version three',acceptance:['Actual judgment'],kind:'management',priority:89});
 store.update('assignments',review.id,{schedulerKey:`formation:approve:${candidate.id}:3`,payload:{formation:true}});
 const scheduler=new Scheduler(store,{} as LocalRuntime,new CorporateBroker(store,root),'http://localhost');(scheduler as any).recoveryComplete=true;
 vi.spyOn(scheduler,'initialize').mockResolvedValue();vi.spyOn(scheduler as any,'reconcileOrganization').mockImplementation(()=>{});vi.spyOn(scheduler as any,'deliveryEvents').mockResolvedValue(undefined);
 const execute=vi.spyOn(scheduler as any,'execute').mockResolvedValue(undefined);
 await scheduler.tick();expect(execute).toHaveBeenCalledOnce();expect(execute.mock.calls[0][0]).toMatchObject({assignmentId:review.id});expect(store.need('assignments',provision.id)).toMatchObject({status:'queued',priority:88});
 const reviewRun=store.list('runs').find(r=>r.assignmentId===review.id)!;store.update('runs',reviewRun.id,{status:'succeeded'});store.update('assignments',review.id,{status:'completed'});
 store.update('experiences',candidate.id,{status:'changes_requested'});await scheduler.tick();expect(execute).toHaveBeenCalledOnce();
 store.update('experiences',candidate.id,{status:finalStatus});await scheduler.tick();expect(execute).toHaveBeenCalledTimes(2);expect(execute.mock.calls[1][0]).toMatchObject({assignmentId:provision.id});expect(store.need('experiences',candidate.id).status).toBe(finalStatus);
 });

 it('candidate batch final steering waits for all exact receipts and retains dispatched membership',()=>{
 assignment=store.update('assignments',assignment.id,{status:'running',schedulerKey:'formation:candidate:first:0',payload:{formation:true,candidateRequisitionIds:['first','second']}});
 store.put('experiences',{kind:'candidate',requisitionId:'first',status:'proposed',authorship:{runId:run.id}});
 expect(checkpointFinalResponseReady(store,assignment,run.id)).toBe(false);
 store.put('experiences',{kind:'candidate',requisitionId:'second',status:'proposed',authorship:{runId:run.id}});
 expect(checkpointFinalResponseReady(store,assignment,run.id)).toBe(true);
 store.put('experiences',{kind:'candidate',requisitionId:'third',status:'proposed',authorship:{runId:run.id}});
 store.update('assignments',assignment.id,{payload:{formation:true,candidateRequisitionIds:['first','third']}});
 expect(checkpointFinalResponseReady(store,assignment,run.id)).toBe(false);
 });

it.each(['matching','default','different-profile','same-employee','same-project'])('two productive dispatch preserves %s boundary',async scenario=>{
 const identity='a'.repeat(64);
 store.update('policy',store.policy.id,{maxInference:2,maxProductiveTurns:scenario==='default'?1:2,productiveConcurrencyQualification:{passed:true,artifactIdentity:identity,evidence:'Actual fixture policy boundary'}});
 const currentModel=store.list('models').find(m=>m.name===model)!;store.update('models',currentModel.id,{artifactIdentity:identity});
 const position=store.command(owner,{type:'position.create',title:'Independent specialist',level:'worker',responsibilities:'Independent work'});
 const employee=store.command(owner,{type:'employee.hire',name:'Independent specialist',positionId:position.id,homeManagerId:run.employeeId,modelId:model});
 const target=store.command(owner,{type:'assignment.create',employeeId:scenario==='same-employee'?run.employeeId:employee.id,supervisorId:run.employeeId,title:'Independent task',instructions:'Inspect actual assigned evidence',acceptance:['Retained result'],kind:'management'});
 if(scenario==='different-profile'){store.put('models',{id:'different',name:'different',artifactIdentity:'b'.repeat(64),local:true,available:true});store.update('employees',employee.id,{modelId:'different'});}
 if(scenario==='same-project'){const project=store.put('projects',{name:'Shared project',status:'active'});store.update('assignments',assignment.id,{projectId:project.id});store.update('assignments',target.id,{projectId:project.id});}
 const runtime={status:()=>({inferenceSlots:2,resources:{maxProductiveTurns:scenario==='default'?1:2,productiveArtifactIdentity:identity}})} as unknown as LocalRuntime;
 const scheduler=new Scheduler(store,runtime,new CorporateBroker(store,root),'http://localhost');
 (scheduler as any).recoveryComplete=true;(scheduler as any).initialized=true;
 vi.spyOn(scheduler as any,'reconcileOrganization').mockImplementation(()=>{});
 vi.spyOn(scheduler as any,'deliveryEvents').mockResolvedValue(undefined);
 const execute=vi.spyOn(scheduler as any,'execute').mockResolvedValue(undefined);
 await scheduler.tick();
 expect(execute).toHaveBeenCalledTimes(['matching','different-profile'].includes(scenario)?1:0);
 if(['matching','different-profile'].includes(scenario))expect(execute.mock.calls[0][0]).toMatchObject({assignmentId:target.id,employeeId:employee.id});
 if(scenario==='same-project'||scenario==='same-employee')expect(store.claimNext({assignmentId:target.id})).toBeUndefined();
});

it.each([false,true])('passes only the current Owner free-model exception to runtime (%s)',async enabled=>{
 const ids=enabled?['vendor/verified-model:free']:[];
 if(enabled){store.command(owner,{type:'policy.update',openRouterFreeModels:ids});store.update('runs',run.id,{policyRevision:store.policy.revision});}
 const execute=vi.fn(async(_request:any)=>{throw new Error('Fixture stops at runtime dispatch');});
 const scheduler=new Scheduler(store,{execute} as unknown as LocalRuntime,new CorporateBroker(store,root),'http://localhost');
 await (scheduler as any).execute(store.need('runs',run.id));
 const request=execute.mock.calls[0][0];expect(request.openRouterFreeModels).toEqual(ids);
 expect(request.system.includes('Only local models.')).toBe(!enabled);
 expect(request.system.includes('verified free-provider')).toBe(enabled);
 expect(request.system).toContain('Zero unapproved spending.');
});

describe('exact candidate-review final response',()=>{
 it.each(['approved','changes_requested','hired'])('accepts only the retained exact-version own %s review',status=>{
  const candidate=store.put('experiences',{kind:'candidate',version:2,status:'proposed'});
  assignment=store.update('assignments',assignment.id,{status:'running',schedulerKey:`formation:approve:${candidate.id}:2`,payload:{formation:true}});
  expect(checkpointFinalResponseEligible(assignment)).toBe(true);
  expect(checkpointFinalResponseReady(store,assignment,run.id)).toBe(false);
  const field=status==='changes_requested'?'feedback':'approval',type=status==='changes_requested'?'recruitment.reject':'recruitment.approve';
  const receipt={authorId:run.employeeId,runId:run.id,rationale:'Independent evidence-based fixture judgment'};
  store.update('experiences',candidate.id,{status,[field]:receipt});
  expect(checkpointFinalResponseReady(store,assignment,run.id)).toBe(false);
  store.update('runs',run.id,{corporateCommands:[{type,id:candidate.id}]});
  expect(checkpointFinalResponseReady(store,assignment,run.id)).toBe(true);
  store.update('experiences',candidate.id,{[field]:{...receipt,authorId:'another-manager'}});
  expect(checkpointFinalResponseReady(store,assignment,run.id)).toBe(false);
  const other=store.put('runs',{...run,id:undefined,sessionId:randomUUID(),assignmentId:'unrelated',corporateCommands:[{type,id:candidate.id}]});
  store.update('experiences',candidate.id,{[field]:{...receipt,runId:other.id}});
  expect(checkpointFinalResponseReady(store,assignment,run.id)).toBe(false);
  store.update('experiences',candidate.id,{[field]:receipt,version:3,history:[{...candidate,version:2,status,[field]:receipt}]});
  expect(checkpointFinalResponseReady(store,assignment,run.id)).toBe(false);
  store.update('experiences',candidate.id,{version:2,status:'proposed'});
  expect(checkpointFinalResponseReady(store,assignment,run.id)).toBe(false);
  store.update('experiences',candidate.id,{status});
  store.command(owner,{type:'control',action:'pause'});
  expect(()=>checkpointFinalResponseReady(store,assignment,run.id)).toThrow();
 });
});

it('labels inline knowledge paths as vault provenance and supplies scoped content paging',async()=>{
 const broker=new CorporateBroker(store,root);
 const notes=broker.knowledgeContext(actor,[run.employeeId]);
 expect(notes.length).toBeGreaterThan(0);
 const execute=vi.fn(async(_request:any)=>{throw new Error('Fixture stops at runtime dispatch');});
 const scheduler=new Scheduler(store,{execute} as unknown as LocalRuntime,broker,'http://localhost');
 const captured=vi.spyOn(broker,'knowledgeContext');
 await (scheduler as any).execute(store.need('runs',run.id));
 const prompt=execute.mock.calls[0][0].prompt;
 expect(prompt).toContain('path values are vault-relative provenance, not native workspace files');
 expect(prompt).toContain('Reuse complete inline contents without rereading');
 expect(prompt).toContain('company_detail {collection:"knowledge",id:"the supplied note ID",view:"content",offset:nextOffset}');
 expect(prompt).toContain('follow returned nextOffset until null');
 const supplied=captured.mock.results[0].value;
 expect(prompt).toContain(JSON.stringify(supplied));
 for(const note of supplied)expect(prompt).not.toContain(join(run.workspace!,note.path));
 // The advertised route is the existing scoped knowledge reader, not a file read.
 const currentRun=store.put('runs',{...run,id:undefined,status:'running',sessionId:randomUUID()});
 const reader={...actor,runId:currentRun.id} as Actor;
 const page=await broker.call(reader,'company_detail',{collection:'knowledge',id:notes[0]!.id,view:'content',offset:1});
 expect(page.content).toBe(store.readKnowledge(notes[0]!.id).content.slice(1));
});

it('passes exact mixed pins through drain and runtime resource reconfiguration',async()=>{
 const qualification={mode:'local-remote',passed:true,artifactIdentity:'a'.repeat(64),remoteModelId:'gemini:fixture',remoteArtifactIdentity:'b'.repeat(64),evidence:'Synthetic retained pair'};
 store.update('policy',store.policy.id,{maxInference:2,maxProductiveTurns:2,productiveConcurrencyQualification:qualification});
 const configureResources=vi.fn(async()=>{}),runtime={configureResources} as unknown as LocalRuntime;
 const scheduler=new Scheduler(store,runtime,new CorporateBroker(store,root),'http://localhost');
 const shutdown=vi.spyOn(scheduler,'shutdown').mockResolvedValue();vi.spyOn(scheduler,'start').mockImplementation(()=>{});
 await scheduler.configureResources();
 expect(shutdown).toHaveBeenCalledOnce();expect(configureResources).toHaveBeenCalledWith(expect.objectContaining({maxProductiveTurns:2,productiveArtifactIdentity:qualification.artifactIdentity,productiveRemoteModelId:qualification.remoteModelId,productiveRemoteArtifactIdentity:qualification.remoteArtifactIdentity}));
 expect(shutdown.mock.invocationCallOrder[0]).toBeLessThan(configureResources.mock.invocationCallOrder[0]);
});
it('dispatches the canonical provision-only packet without unrelated company context or guide duplication',async()=>{
 const broker=new CorporateBroker(store,root),req=store.put('experiences',{kind:'requisition',recruiterId:run.employeeId,homeManagerId:run.employeeId,firstWork:'Inspect assigned staffing records'}),candidate=store.put('experiences',{kind:'candidate',status:'approved',version:2,name:'Actual approved fixture',requisitionId:req.id,onboarding:'Read actual responsibilities',sourceIds:[]});
 store.update('assignments',assignment.id,{schedulerKey:`formation:provision:${candidate.id}`,payload:{formation:true},projectId:null});
 store.command(owner,{type:'knowledge.write',scope:'company',content:'UNRELATED_COMPANY_INLINE_NOTE',source:'Independent fixture company note'});
 const execute=vi.fn(async(_request:any)=>{throw new Error('Fixture ends at dispatch');}),scheduler=new Scheduler(store,{execute} as unknown as LocalRuntime,broker,'http://localhost');
 const expected=broker.provisionPrompt(actor)!;await (scheduler as any).execute(store.need('runs',run.id));
 const request=execute.mock.calls[0][0];expect(request.system.endsWith(expected.system)).toBe(true);expect(request.system).toContain(store.need('employees',run.employeeId).role);expect(request.prompt).toBe(expected.prompt);expect(request.corporateOnly).toBe(true);expect(request.provisionOnly).toBe(true);expect(request.prompt).not.toContain('UNRELATED_COMPANY_INLINE_NOTE');expect(request.system).not.toContain('Product implementations require');expect(request.prompt).toContain(candidate.id);expect(request.prompt).toContain(req.id);
});

import {ProviderCooldownError,ResourceAdmissionError} from '../src/runtime/resource-budget.js';
it('holds queued provider work before claiming while dispatching eligible local work',async()=>{
 store.update('runs',run.id,{status:'succeeded'});store.update('assignments',assignment.id,{status:'completed'});const employee=store.need('employees',run.employeeId);store.update('employees',employee.id,{modelId:'gemini:fixture'});
 const target=store.command(owner,{type:'assignment.create',employeeId:employee.id,title:'Wait for provider',instructions:'Actual pending work',acceptance:['Retain work'],kind:'management'}),retryAt=new Date(Date.now()+60000).toISOString();
 const runtime={providerCooldown:(id:string)=>id==='gemini:fixture'?{provider:'gemini',retryAt}:undefined,status:()=>({inferenceSlots:2})} as unknown as LocalRuntime,scheduler=new Scheduler(store,runtime,new CorporateBroker(store,root),'http://localhost');(scheduler as any).recoveryComplete=true;(scheduler as any).initialized=true;vi.spyOn(scheduler as any,'reconcileOrganization').mockImplementation(()=>{});vi.spyOn(scheduler as any,'deliveryEvents').mockResolvedValue(undefined);vi.spyOn(scheduler as any,'idle').mockImplementation(()=>{});const localEmployee=store.list('employees').find(e=>e.id!==employee.id)!;store.update('employees',localEmployee.id,{modelId:model});const local=store.command(owner,{type:'assignment.create',employeeId:localEmployee.id,title:'Independent local work',instructions:'Continue local work',acceptance:['Actual progress'],kind:'management'});const execute=vi.spyOn(scheduler as any,'execute').mockResolvedValue(undefined);const before=store.list('runs').length;await scheduler.tick();expect(execute).toHaveBeenCalledOnce();expect((execute.mock.calls[0][0] as EmployeeRun).assignmentId).toBe(local.id);expect(store.list('runs')).toHaveLength(before+1);expect(store.need('assignments',target.id)).toMatchObject({status:'queued',attempts:0,availableAt:retryAt,resourceWait:{provider:'gemini',retryAt}});
});
it.each(['none','session','corporate','pullRequest'])('requeues only an untouched cooldown admission, prior effect=%s',async effect=>{
 const started=effect!=='none';
 store.update('runs',run.id,{sessionId:effect==='session'?'actual-native-session':null,...(effect==='corporate'?{corporateCalls:1}:{})});store.update('assignments',assignment.id,{status:'running',attempts:1,...(effect==='pullRequest'?{pullRequestCandidate:{id:'retained'}}:{})});const retryAt=new Date(Date.now()+60000).toISOString(),before=store.need('assignments',assignment.id).attempts;
 const broker=new CorporateBroker(store,root),scheduler=new Scheduler(store,{execute:async()=>{throw new ProviderCooldownError('gemini',retryAt);}} as unknown as LocalRuntime,broker,'http://localhost');vi.spyOn(scheduler as any,'diagnoseFailure').mockImplementation(()=>{});await (scheduler as any).execute(store.need('runs',run.id));
 expect(store.need('assignments',assignment.id).status).toBe(started?'blocked':'queued');expect(store.need('runs',run.id).status).toBe(started?'failed':'interrupted');expect(store.need('assignments',assignment.id).attempts).toBe(started?before:before-1);if(!started)expect(store.need('assignments',assignment.id).availableAt).toBe(retryAt);
});

import {ProviderAvailabilityError} from '../src/runtime/resource-budget.js';
it.each(['daily reservation budget','fresh Owner audit required','free-pool'])('holds %s before claim and dispatches local work',async reason=>{
 const selected=reason==='free-pool'?'free-pool':'gemini:fixture';
 store.update('runs',run.id,{status:'succeeded'});store.update('assignments',assignment.id,{status:'completed'});const employee=store.need('employees',run.employeeId);store.update('employees',employee.id,{modelId:selected});
 const target=store.command(owner,{type:'assignment.create',employeeId:employee.id,title:'Wait for provider',instructions:'Actual pending work',acceptance:['Retain work'],kind:'management'}),retryAt=new Date(Date.now()+60000).toISOString();
 const runtime={providerAvailability:async(id:string)=>id===selected?new ProviderAvailabilityError(selected,retryAt,reason):undefined,status:()=>({inferenceSlots:2})} as unknown as LocalRuntime,scheduler=new Scheduler(store,runtime,new CorporateBroker(store,root),'http://localhost');(scheduler as any).recoveryComplete=true;(scheduler as any).initialized=true;vi.spyOn(scheduler as any,'reconcileOrganization').mockImplementation(()=>{});vi.spyOn(scheduler as any,'deliveryEvents').mockResolvedValue(undefined);vi.spyOn(scheduler as any,'idle').mockImplementation(()=>{});const localEmployee=store.list('employees').find(e=>e.id!==employee.id)!;store.update('employees',localEmployee.id,{modelId:model});const local=store.command(owner,{type:'assignment.create',employeeId:localEmployee.id,title:'Independent local work',instructions:'Continue local work',acceptance:['Actual progress'],kind:'management'});const execute=vi.spyOn(scheduler as any,'execute').mockResolvedValue(undefined);const before=store.list('runs').length;await scheduler.tick();expect(execute).toHaveBeenCalledOnce();expect((execute.mock.calls[0][0] as EmployeeRun).assignmentId).toBe(local.id);expect(store.list('runs')).toHaveLength(before+1);expect(store.need('assignments',target.id)).toMatchObject({status:'queued',attempts:0,availableAt:retryAt,resourceWait:{provider:selected,retryAt}});
});

it('holds expired registered provider evidence while keeping local work eligible',async()=>{
 store.update('runs',run.id,{status:'succeeded'});store.update('assignments',assignment.id,{status:'completed'});const employee=store.need('employees',run.employeeId);store.update('employees',employee.id,{modelId:'gemini:fixture'});
 const target=store.command(owner,{type:'assignment.create',employeeId:employee.id,title:'Wait for provider',instructions:'Actual pending work',acceptance:['Retain work'],kind:'management'});
 const runtime={providerAvailability:async()=>undefined,status:()=>({inferenceSlots:2})} as unknown as LocalRuntime,scheduler=new Scheduler(store,runtime,new CorporateBroker(store,root),'http://localhost');(scheduler as any).recoveryComplete=true;(scheduler as any).initialized=true;vi.spyOn(scheduler as any,'reconcileOrganization').mockImplementation(()=>{});vi.spyOn(scheduler as any,'deliveryEvents').mockResolvedValue(undefined);vi.spyOn(scheduler as any,'idle').mockImplementation(()=>{});const localEmployee=store.list('employees').find(e=>e.id!==employee.id)!;store.update('employees',localEmployee.id,{modelId:model});const local=store.command(owner,{type:'assignment.create',employeeId:localEmployee.id,title:'Independent local work',instructions:'Continue local work',acceptance:['Actual progress'],kind:'management'});const execute=vi.spyOn(scheduler as any,'execute').mockResolvedValue(undefined);const before=store.list('runs').length;await scheduler.tick();expect(execute).toHaveBeenCalledOnce();expect((execute.mock.calls[0][0] as EmployeeRun).assignmentId).toBe(local.id);expect(store.list('runs')).toHaveLength(before+1);expect(store.need('assignments',target.id)).toMatchObject({status:'queued',attempts:0,resourceWait:{provider:'gemini',reason:expect.stringContaining('refresh inventory')}});
});

it('does not apply an obsolete provider wait after actual model selection changes during preflight',async()=>{
 store.update('runs',run.id,{status:'succeeded'});store.update('assignments',assignment.id,{status:'completed'});const employee=store.need('employees',run.employeeId);store.update('employees',employee.id,{modelId:'gemini:fixture'});
 const target=store.command(owner,{type:'assignment.create',employeeId:employee.id,title:'Wait for provider',instructions:'Actual pending work',acceptance:['Retain work'],kind:'management'});
 const runtime={providerAvailability:async(id:string)=>{if(id==='gemini:fixture'){store.update('employees',employee.id,{modelId:model});return new ProviderAvailabilityError('gemini',new Date(Date.now()+86400000).toISOString(),'Old provider exhausted');}return undefined;},status:()=>({inferenceSlots:2})} as unknown as LocalRuntime,scheduler=new Scheduler(store,runtime,new CorporateBroker(store,root),'http://localhost');(scheduler as any).recoveryComplete=true;(scheduler as any).initialized=true;vi.spyOn(scheduler as any,'reconcileOrganization').mockImplementation(()=>{});vi.spyOn(scheduler as any,'deliveryEvents').mockResolvedValue(undefined);vi.spyOn(scheduler as any,'idle').mockImplementation(()=>{});const localEmployee=store.list('employees').find(e=>e.id!==employee.id)!;store.update('employees',localEmployee.id,{modelId:model});const local=store.command(owner,{type:'assignment.create',employeeId:localEmployee.id,title:'Independent local work',instructions:'Continue local work',acceptance:['Actual progress'],kind:'management'});const execute=vi.spyOn(scheduler as any,'execute').mockResolvedValue(undefined);const before=store.list('runs').length;await scheduler.tick();expect(execute).toHaveBeenCalledOnce();expect((execute.mock.calls[0][0] as EmployeeRun).assignmentId).toBe(local.id);expect(store.list('runs')).toHaveLength(before+1);expect(store.need('assignments',target.id).resourceWait).toBeUndefined();expect(store.need('assignments',target.id)).toMatchObject({status:'queued',attempts:0,availableAt:target.availableAt});
});

it('reuses one ordered latest-run map for a synchronous blocked reconciliation and refreshes on the next pass',()=>{
 store.update('runs',run.id,{status:'failed'});store.update('assignments',assignment.id,{status:'blocked'});
 const other=store.command(owner,{type:'assignment.create',employeeId:run.employeeId,title:'Other blocked work',instructions:'Retain other work',acceptance:['Actual outcome'],kind:'management'});store.update('assignments',other.id,{status:'blocked'});
 const otherRun=store.put('runs',{...run,id:'other-failed',sessionId:null,assignmentId:other.id,status:'failed'}),newest=store.put('runs',{...run,id:'latest-failed',sessionId:null,status:'failed'});
 const scheduler=new Scheduler(store,{} as LocalRuntime,{} as CorporateBroker,'http://localhost'),diagnose=vi.spyOn(scheduler as any,'diagnoseFailure').mockImplementation(()=>{});
 (scheduler as any).reconcileOrganization();const calls=diagnose.mock.calls.filter(([r])=>[assignment.id,other.id].includes((r as EmployeeRun).assignmentId));expect(calls).toHaveLength(2);expect(calls.map(([r])=>(r as EmployeeRun).id).sort()).toEqual([newest.id,otherRun.id].sort());expect(calls[0][1]).toBe(calls[1][1]);
 const later=store.put('runs',{...run,id:'later-failed',sessionId:null,status:'failed'});diagnose.mockClear();(scheduler as any).reconcileOrganization();expect(diagnose.mock.calls.find(([r])=>(r as EmployeeRun).assignmentId===assignment.id)?.[0]).toMatchObject({id:later.id});
});
it('keeps current assignment state and newest-run checks outside the synchronous map',()=>{
 store.update('runs',run.id,{status:'failed'});store.update('assignments',assignment.id,{status:'blocked'});const scheduler=new Scheduler(store,{} as LocalRuntime,{} as CorporateBroker,'http://localhost'),enqueue=vi.spyOn(scheduler as any,'enqueue').mockImplementation(()=>{});
 store.put('runs',{...run,id:'newer-run',sessionId:null,status:'failed'});(scheduler as any).diagnoseFailure(store.need('runs',run.id));expect(enqueue).not.toHaveBeenCalled();
 store.update('assignments',assignment.id,{status:'queued'});(scheduler as any).diagnoseFailure(store.need('runs',run.id),new Map([[assignment.id,store.need('runs',run.id)]]));expect(enqueue).not.toHaveBeenCalled();
});

it('queries exact scheduler keys with original first-match ordering and current mutations',()=>{
 const key="key:literal'quoted",createdAt='2026-01-01T00:00:00.000Z';const first=store.put('assignments',{...assignment,id:'key-first',schedulerKey:key,createdAt}),second=store.put('assignments',{...assignment,id:'key-second',schedulerKey:key,createdAt});
 expect(store.assignmentBySchedulerKey(key)?.id).toBe(first.id);expect(store.assignmentBySchedulerKey('missing')).toBeUndefined();
 store.update('assignments',first.id,{status:'cancelled'});expect(store.assignmentBySchedulerKey(key)?.status).toBe('cancelled');store.update('assignments',first.id,{schedulerKey:'changed'});expect(store.assignmentBySchedulerKey(key)?.id).toBe(second.id);
 const plan=store.db.prepare("EXPLAIN QUERY PLAN SELECT data FROM assignments WHERE json_extract(data,'$.schedulerKey')=? ORDER BY created_at,rowid LIMIT 1").all(key);expect(JSON.stringify(plan)).toContain('assignments_scheduler_key');
});

it('adds the scheduler-key index to existing version-one records without rewriting them',()=>{
 store.update('assignments',assignment.id,{schedulerKey:'existing:key'});const before=store.need('assignments',assignment.id);store.db.exec('DROP INDEX assignments_scheduler_key; DELETE FROM migrations WHERE version=2');migrate(store.db);migrate(store.db);expect(store.assignmentBySchedulerKey('existing:key')).toEqual(before);expect(store.db.prepare('SELECT max(version) version FROM migrations').get()).toMatchObject({version:2});const reopened=new CompanyStore(root);try{expect(reopened.assignmentBySchedulerKey('existing:key')).toEqual(before);}finally{reopened.close();}
});

it('reads dispatch-blocking runs freshly through the status index, preserving all three active states',()=>{
 const states=['running','cancelling','uncertain','queued','succeeded','failed','interrupted'] as const;for(const status of states)store.put('runs',{...run,id:`status-${status}`,sessionId:null,status});
 expect(store.activeRuns().map(r=>r.id)).toEqual(store.list('runs').filter(r=>['running','cancelling','uncertain'].includes(r.status)).map(r=>r.id));
 store.update('runs','status-running',{status:'succeeded'});store.update('runs','status-queued',{status:'running'});expect(store.activeRuns().some(r=>r.id==='status-running')).toBe(false);expect(store.activeRuns().some(r=>r.id==='status-queued')).toBe(true);
 const plan=store.db.prepare("EXPLAIN QUERY PLAN SELECT data FROM runs WHERE status IN ('running','cancelling','uncertain') ORDER BY created_at,rowid").all();expect(JSON.stringify(plan)).toContain('runs_status');
});
it('rechecks active employee occupancy after awaited provider admission before claiming',async()=>{
 store.update('runs',run.id,{status:'succeeded'});const runtime={providerAvailability:async()=>{store.update('runs',run.id,{status:'running'});},status:()=>({inferenceSlots:2})} as unknown as LocalRuntime,scheduler=new Scheduler(store,runtime,new CorporateBroker(store,root),'http://localhost');
 (scheduler as any).recoveryComplete=true;(scheduler as any).initialized=true;vi.spyOn(scheduler as any,'reconcileOrganization').mockImplementation(()=>{});vi.spyOn(scheduler as any,'deliveryEvents').mockResolvedValue(undefined);vi.spyOn(scheduler as any,'idle').mockImplementation(()=>{});const execute=vi.spyOn(scheduler as any,'execute').mockResolvedValue(undefined),before=store.list('runs').length;
 await scheduler.tick();expect(execute).not.toHaveBeenCalled();expect(store.list('runs')).toHaveLength(before);expect(store.need('assignments',assignment.id).status).toBe('queued');
});


it.each(['internal implementation','external implementation','internal management'])('scopes empty-repository lifecycle guidance to %s without changing acceptance',async scenario=>{
 const product=scenario.startsWith('internal')?store.command(owner,{type:'product.register_internal',name:'Fixture executable',managerId:run.employeeId,verificationCommand:'node --test',rationale:'Real fixture utility'}):store.list('products')[0];
 const project=store.command(owner,{type:'project.create',name:'Assigned utility',productId:product.id,outcome:'Manager-defined useful behavior',acceptance:['Actual implementation'],supervisorId:run.employeeId,rationale:'Existing scoped work'});
 assignment=store.update('assignments',assignment.id,{projectId:project.id,kind:scenario.endsWith('management')?'management':'implementation',status:'running'});const acceptance=assignment.acceptance;
 if(!scenario.startsWith('internal'))store.update('products',product.id,{kind:'external'});
 const execute=vi.fn(async(_request:any)=>{throw new Error('Fixture ends at runtime dispatch');}),broker=new CorporateBroker(store,root);
 const scheduler=new Scheduler(store,{execute} as unknown as LocalRuntime,broker,'http://localhost');
 if(scenario==='external implementation'){const dependencies=await import('../src/tools/dependencies.js');vi.spyOn(dependencies,'prepareProductDependencies').mockResolvedValue({installed:true,lockDigest:'fixture',receiptPath:'fixture',downloaded:0,reused:0,incrementalCost:0,environment:{}} as any);}
 await (scheduler as any).execute(run);
 expect(execute).toHaveBeenCalledOnce();const request=execute.mock.calls[0][0];expect(request.system.includes('This company-owned internal-tool repository may start empty.')).toBe(scenario==='internal implementation');
 if(scenario==='internal implementation'){expect(request.system).toContain('Preserve and reuse any existing files');expect(request.system).toContain('manager-defined implementation');expect(request.system).toContain('bare repository is Git storage');expect(request.system).toContain('Product implementations require commit_work');}
 expect(store.need('assignments',assignment.id).acceptance).toEqual(acceptance);vi.restoreAllMocks();
});

it.each(['none','corporate','dependency','delivery','pullRequest','cleanup','revoked'])('defers a proved empty native capacity refusal without discarding evidence, effect=%s',async effect=>{
 store.update('assignments',assignment.id,{status:'running',attempts:1,...(effect==='pullRequest'?{pullRequestCandidate:{id:'retained'}}:{})});
 const retryAt=new Date(Date.now()+600000).toISOString(),evidence={runId:run.id,sessionId:'session',modelId:'free-pool',artifactIdentity:'synthetic-pool',usage:{inputTokens:0,outputTokens:0,requests:1,durationMs:10},diagnosticsPath:'synthetic-failure.json',messagesPath:'synthetic-messages.json',messagesSource:'database',databasePath:'synthetic.db',continuations:0,code:'provider_capacity_wait',error:'Synthetic capacity refusal',capturedAt:new Date().toISOString(),providerWait:{provider:'free-pool',retryAt}} as const;
 store.update('runs',run.id,{...(effect==='dependency'?{dependencyPreparation:{status:'retained'}}:{}),...(effect==='delivery'?{deliveryOutcome:{status:'retained'}}:{})});
 const runtime={execute:async(request:any)=>{expect(request.deferInitialPoolWait).toBe(!['dependency','delivery','pullRequest'].includes(effect));store.update('runs',run.id,{...(effect==='corporate'?{corporateCalls:1}:{}),...(effect==='revoked'?{tokenRevoked:true}:{})});throw new RuntimeExecutionError(effect==='cleanup'?'runtime_failed':'provider_capacity_wait','Synthetic capacity refusal',undefined,{evidence});}} as unknown as LocalRuntime;
 const scheduler=new Scheduler(store,runtime,new CorporateBroker(store,root),'http://localhost'),diagnose=vi.spyOn(scheduler as any,'diagnoseFailure').mockImplementation(()=>{});
 await (scheduler as any).execute(store.need('runs',run.id));
 const actual=store.need('assignments',assignment.id),ended=store.need('runs',run.id);
 expect(ended.runtimeFailureEvidence).toEqual(evidence);expect(ended.sessionId).toBe('session');expect(actual.attempts).toBe(1);
 if(effect==='none'){expect(ended.status).toBe('interrupted');expect(actual).toMatchObject({status:'queued',availableAt:retryAt,resourceWait:{provider:'free-pool',retryAt}});expect(diagnose).not.toHaveBeenCalled();}
 else expect(actual.resourceWait).toBeUndefined();
});


it('keeps an interrupted assignment quarantined when native process cleanup is unconfirmed',async()=>{
 store.update('assignments',assignment.id,{status:'running'});
 const runtime={cancel:vi.fn(async()=>{}),execute:vi.fn(async()=>{
  store.command(owner,{type:'assignment.update',assignmentId:assignment.id,paused:true,rationale:'Inspect stalled work'});
  throw new RuntimeExecutionError('runtime_cleanup_uncertain','Owned process absence unconfirmed');
 })} as unknown as LocalRuntime;
 const scheduler=new Scheduler(store,runtime,new CorporateBroker(store,root),'http://broker.invalid');
 await (scheduler as any).execute(run);
 expect(store.need('runs',run.id).status).toBe('uncertain');
 expect(()=>store.command(owner,{type:'assignment.update',assignmentId:assignment.id,paused:false,rationale:'Attempt early resume'})).toThrow(/reconcil|runtime/);
 store.command(owner,{type:'assignment.update',assignmentId:assignment.id,status:'queued',rationale:'A rationale alone cannot confirm process absence'});
 expect(store.claimNext({assignmentId:assignment.id})).toBeUndefined();
 store.recoverRuns(()=> 'absent');
 store.command(owner,{type:'assignment.update',assignmentId:assignment.id,paused:false,rationale:'Native ownership positively reconciled'});
 const next=store.claimNext({assignmentId:assignment.id});expect(next?.employeeId).toBe(run.employeeId);expect(next?.workspace).toBe(run.workspace);expect(store.need('assignments',assignment.id).resumeRunId).toBe(run.id);
});

it('continues the same assignment on a selected local alternate while its provider is cooling down',async()=>{
 store.update('runs',run.id,{status:'succeeded'});store.update('assignments',assignment.id,{status:'completed'});
 const employee=store.need('employees',run.employeeId),preferred='free-pool';
 store.update('policy',store.policy.id,{freeInferencePool:true});
 store.put('models',{id:preferred,name:preferred,provider:'pool',local:false,freeOnly:true,available:true,artifactIdentity:'a'.repeat(64),endpoint:'opencorp:free-pool'});
 store.command(owner,{type:'employee.model',employeeId:employee.id,modelId:preferred,fallbackModelIds:[model],rationale:'Same bounded work fits local engine'});
 const target=store.command(owner,{type:'assignment.create',employeeId:employee.id,title:'Continue retained work',instructions:'Read preserved progress',acceptance:['Retain work'],kind:'management'}),retryAt=new Date(Date.now()+60000).toISOString();
 const runtime={providerAvailability:async(id:string)=>id===preferred?new ProviderCooldownError(preferred,retryAt):undefined,status:()=>({inferenceSlots:1})} as unknown as LocalRuntime;
 const scheduler=new Scheduler(store,runtime,new CorporateBroker(store,root),'http://localhost');Object.assign(scheduler,{recoveryComplete:true,initialized:true});
 vi.spyOn(scheduler as any,'reconcileOrganization').mockImplementation(()=>{});vi.spyOn(scheduler as any,'deliveryEvents').mockResolvedValue(undefined);
 const execute=vi.spyOn(scheduler as any,'execute').mockResolvedValue(undefined);
 await scheduler.tick();expect(execute).toHaveBeenCalledOnce();
 expect(execute.mock.calls[0][0]).toMatchObject({employeeId:employee.id,assignmentId:target.id,modelId:model});
 expect(store.need('employees',employee.id).modelId).toBe(preferred);
 const claimed=execute.mock.calls[0][0] as EmployeeRun;store.finishRun(claimed.id,{status:'interrupted'});
 store.update('models',store.list('models').find(m=>m.name===model)!.id,{available:false});
 await scheduler.tick();expect(execute).toHaveBeenCalledOnce();expect(store.need('assignments',target.id)).toMatchObject({status:'queued',attempts:1,resumeRunId:claimed.id});
 await scheduler.tick();expect(execute).toHaveBeenCalledOnce();
});

it('retains both local admission waits instead of alternating failed claims',async()=>{
 store.update('runs',run.id,{status:'succeeded'});store.update('assignments',assignment.id,{status:'completed'});
 store.put('models',{id:'alternate',name:'alternate',local:true,available:true,artifactIdentity:'alternate',capabilities:['tools']});
 store.command(owner,{type:'employee.model',employeeId:run.employeeId,modelId:model,fallbackModelIds:['alternate'],rationale:'Suitable bounded work'});
 const target=store.command(owner,{type:'assignment.create',employeeId:run.employeeId,title:'Capacity hold',instructions:'Retain work',acceptance:['Retain work'],kind:'management'});
 const runtime={status:()=>({inferenceSlots:1}),providerAvailability:vi.fn(),execute:vi.fn(async()=>{throw new ResourceAdmissionError('Local memory pressure');})} as unknown as LocalRuntime;
 const scheduler=new Scheduler(store,runtime,new CorporateBroker(store,root),'http://localhost');Object.assign(scheduler,{recoveryComplete:true,initialized:true});
 vi.spyOn(scheduler as any,'reconcileOrganization').mockImplementation(()=>{});vi.spyOn(scheduler as any,'deliveryEvents').mockResolvedValue(undefined);vi.spyOn(scheduler as any,'idle').mockImplementation(()=>{});
 const first=store.claimNext({assignmentId:target.id,workspace:root})!;await (scheduler as any).execute(first);
 const second=store.claimNext({assignmentId:target.id,workspace:root,modelId:'alternate'})!;await (scheduler as any).execute(second);
 expect(runtime.execute).toHaveBeenCalledTimes(2);
 await scheduler.tick();await scheduler.tick();
 const retained=store.need('assignments',target.id);expect(retained.status).toBe('queued');expect(Date.parse(retained.availableAt)).toBeGreaterThan(Date.now());expect(runtime.execute).toHaveBeenCalledTimes(2);expect(runtime.providerAvailability).not.toHaveBeenCalled();
});
it('services a pending Owner stop before admitting more queued work',async()=>{
 const scheduler=new Scheduler(store,{status:()=>({inferenceSlots:1})} as unknown as LocalRuntime,new CorporateBroker(store,root),'http://localhost');
 Object.assign(scheduler,{initialized:true,recoveryComplete:true});
 vi.spyOn(scheduler as any,'reconcileOrganization').mockImplementation(()=>{});vi.spyOn(scheduler as any,'deliveryEvents').mockResolvedValue(undefined);
 const before=store.list('runs').length;let stopped=false;
 const control=new Promise<void>(resolve=>setImmediate(()=>{store.command(owner,{type:'control',action:'stop'});stopped=true;resolve();}));
 try{await scheduler.tick();expect(stopped).toBe(true);expect(store.list('runs')).toHaveLength(before);}finally{await control;}
});
