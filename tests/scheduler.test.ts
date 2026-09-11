import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { CompanyStore } from '../src/storage/store.js';
import { checkpointFinalResponseEligible, checkpointFinalResponseReady, managementOutcome, Scheduler } from '../src/scheduler/scheduler.js';
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

describe('durable dispatch boundaries',()=>{
  it.each([
    ['Acknowledge this controls check only.','Acknowledged.'],
    ['Explain which artifacts support the current project result.','No artifacts have been recorded in this fixture; there is no completed product outcome to report.'],
  ])('guides and persists an internal Owner final reply for %s',async(content,text)=>{
    const message=store.command(owner,{type:'message.send',recipientId:run.employeeId,content});
    store.update('assignments',assignment.id,{kind:'conversation',status:'running',instructions:`Owner message ${message.id}: ${content}\nRespond through message.send with recipientId omitted (CEO) or in your final answer.`,payload:{messageId:message.id}});
    const result:RuntimeResult={sessionId:'session',text,modelId:'qwen-main',artifactIdentity:'fixture-local-model',usage:{inputTokens:20,outputTokens:10,requests:1,durationMs:10},messagesPath:join(root,'fixture-messages.json'),diagnosticsPath:join(root,'fixture-diagnostics.json'),completion:{finishReason:'stop',continuations:0,outputLimit:4096,exhausted:false}};
    const execute=vi.fn(async(_request:any)=>result),broker=new CorporateBroker(store,root),call=vi.spyOn(broker,'call'),scheduler=new Scheduler(store,{execute} as unknown as LocalRuntime,broker,'http://localhost');
    await (scheduler as any).execute(store.need('runs',run.id));
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
    store.command(homeActor,{type:'assignment.accept',assignmentId:work.id,accept:true,rationale:'Existing commitment completed; capacity available'});
    expect(managementOutcome(store,request,store.need('runs',homeRun.id)).passed).toBe(true);expect(store.need('assignments',work.id).accepted).toBe(true);expect(store.need('employees',worker.id).homeManagerId).toBe(homeActor.kind==='employee'?homeActor.employeeId:undefined);
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
  it.each(['revised proposal','withdrawal'])('routes a rejected appointment once and requires an evidenced current-run %s',correctionKind=>{
    const position=store.command(actor,{type:'position.create',title:'Product executive',level:'executive',responsibilities:'Own useful product delivery'}),proposal={positionId:position.id,name:'Proposed executive',modelId:model,role:'Initial delivery scope'};
    const decision=store.command(actor,{type:'decision.create',kind:'executive.appoint',subject:'Initial executive appointment',rationale:'Concrete delivery ownership',payload:proposal});
    const scheduler=new Scheduler(store,{} as LocalRuntime,new CorporateBroker(store,root),'http://localhost');
    for(const elder of store.list('employees').filter(e=>store.level(e.id)==='elder')){
      const voteAssignment=store.command(owner,{type:'assignment.create',employeeId:elder.id,title:'Independent initial vote',instructions:'Judge the actual proposal',acceptance:['Actual initial judgment'],kind:'governance',payload:{decisionId:decision.id}}),voteRun=store.put('runs',{...run,id:undefined,employeeId:elder.id,assignmentId:voteAssignment.id,sessionId:randomUUID()});
      store.command({kind:'employee',employeeId:elder.id,runId:voteRun.id,policyRevision:store.policy.revision},{type:'decision.vote',decisionId:decision.id,approve:false,rationale:`Independent objection from ${elder.id}: scope needs actual delivery evidence`});
    }
    (scheduler as any).reconcileOrganization();(scheduler as any).reconcileOrganization();
    const followups=store.list('assignments').filter(a=>a.schedulerKey===`appointment-rejected:${decision.id}`);expect(followups).toHaveLength(1);const followup=followups[0],voteIds=store.list('votes').filter(v=>v.decisionId===decision.id).map(v=>v.id);
    expect(followup).toMatchObject({employeeId:run.employeeId,projectId:null,status:'queued',payload:{rejectedDecisionId:decision.id,voteIds}});expect(followup.instructions).toContain(decision.id);for(const id of voteIds)expect(followup.instructions).toContain(id);
    const correctionRun=store.put('runs',{...run,id:undefined,assignmentId:followup.id,sessionId:randomUUID(),text:'The staffing issue is resolved.'}),correctionActor:Actor={kind:'employee',employeeId:run.employeeId,runId:correctionRun.id,policyRevision:store.policy.revision},result=()=>managementOutcome(store,followup,store.need('runs',correctionRun.id));
    expect(result().passed).toBe(false);store.command(correctionActor,{type:'product.assess',productId:store.list('products')[0].id,assessment:'Updated product evidence',rationale:'Unrelated assessment cannot complete governance correction'});expect(result().passed).toBe(false);
    const payload={...(correctionKind==='withdrawal'?{disposition:'withdrawn'}:proposal),rejectedDecisionId:decision.id},kind=correctionKind==='withdrawal'?'strategy':'executive.appoint';
    store.command(correctionActor,{type:'decision.create',kind,subject:'Unlinked response',rationale:'No finalized vote evidence linked yet',payload});expect(result().passed).toBe(false);
    store.command(correctionActor,{type:'decision.create',kind,subject:'Evidence-based staffing correction',rationale:'Address the retained scope objections with concrete product evidence',payload:{...payload,reviewedVoteIds:voteIds}});expect(result().passed).toBe(true);
    store.update('assignments',followup.id,{status:'completed'});(scheduler as any).reconcileOrganization();expect(store.list('assignments').filter(a=>a.schedulerKey===followup.schedulerKey)).toHaveLength(1);expect(store.need('decisions',decision.id).status).toBe('rejected');expect(store.list('votes').filter(v=>v.decisionId===decision.id).map(v=>v.id)).toEqual(voteIds);
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
