import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Actor, Artifact, Assignment, Employee, PositionLevel, Project } from '../src/core/types.js';
import type { LocalRuntime } from '../src/runtime/index.js';
import { CompanyStore } from '../src/storage/store.js';
import { CorporateBroker } from '../src/tools/broker.js';
import { managementOutcome, Scheduler } from '../src/scheduler/scheduler.js';

const owner={kind:'owner'} as const,model='wlkr-management-qwen3.8-27b-q4-k-m:latest';
let root:string,store:CompanyStore,broker:CorporateBroker,scheduler:Scheduler,ceo:Employee,director:Employee,author:Employee,reviewer:Employee,project:Project,original:Assignment,artifact:Artifact;
function hire(name:string,homeManagerId:string,level:PositionLevel='worker'):Employee {
 const position=store.command(owner,{type:'position.create',title:name,level,responsibilities:'Use actual scoped evidence'});
 return store.command(owner,{type:'employee.hire',name,positionId:position.id,homeManagerId,modelId:model});
}
function review():Assignment{return store.command(owner,{type:'assignment.create',projectId:project.id,employeeId:reviewer.id,supervisorId:author.id,kind:'review',title:'Retained legacy review',instructions:'Inspect the exact artifact and record a verdict',acceptance:['Independent source-based verdict'],payload:{artifactId:artifact.id},priority:500});}
function legacy():Assignment {const task=review();return store.update('assignments',task.id,{projectId:null,attempts:2,blockedReason:'Earlier reason',reviewFeedback:'Preserved earlier feedback'});}
function reconcile(){(scheduler as any).reconcileOrganization();}
function corrections(target:Assignment){return store.list('assignments').filter(item=>item.schedulerKey===`review-scope:${target.id}`);}
function active(task:Assignment):Extract<Actor,{kind:'employee'}> {
 const run=store.put('runs',{employeeId:task.employeeId,assignmentId:task.id,modelId:model,status:'running',sessionId:randomUUID(),workspace:root,policyRevision:store.policy.revision,tokenRevoked:false,attempt:1,heartbeatAt:new Date().toISOString(),leaseUntil:new Date(Date.now()+60000).toISOString()});store.update('assignments',task.id,{status:'running'});
 return {kind:'employee',employeeId:task.employeeId,runId:run.id,policyRevision:store.policy.revision};
}
function outcome(task:Assignment,actor:Extract<Actor,{kind:'employee'}>){return managementOutcome(store,task,store.need('runs',actor.runId));}
beforeEach(()=>{
 root=mkdtempSync(join(tmpdir(),'opencorp-review-dispatch-'));store=new CompanyStore(root);store.bootstrap();store.put('models',{name:model,artifactIdentity:'isolated-fixture-identity',local:true,available:true});store.command(owner,{type:'control',action:'start'});
 ceo=store.list('employees').find(employee=>store.level(employee.id)==='ceo')!;store.update('employees',ceo.id,{modelId:model});director=hire('Product director',ceo.id,'lead');author=hire('Author lead',director.id,'manager');reviewer=director;
 project=store.command(owner,{type:'project.create',name:'Finite product fixture',productId:store.list('products')[0].id,outcome:'Actual inspected outcome',acceptance:['Observed independent result'],supervisorId:director.id,rationale:'Isolated review dispatch proof'});
 original=store.command(owner,{type:'assignment.create',projectId:project.id,employeeId:author.id,title:'Original source work',instructions:'Produce retained evidence',acceptance:['Actual source output']});store.update('assignments',original.id,{status:'blocked'});
 const run=store.put('runs',{assignmentId:original.id,employeeId:author.id,status:'succeeded',modelId:model});artifact=store.put('artifacts',{projectId:project.id,assignmentId:original.id,employeeId:author.id,runId:run.id,kind:'analysis',identity:'retained-content',uri:'evidence.md',summary:'Original retained evidence',checks:[]});
 for(const task of store.list('assignments').filter(item=>item.status==='queued'))store.update('assignments',task.id,{status:'cancelled'});
 broker=new CorporateBroker(store,root);scheduler=new Scheduler(store,{} as LocalRuntime,broker,'http://localhost');
});
afterEach(async()=>{vi.restoreAllMocks();await broker?.cancel();store.close();rmSync(root,{recursive:true,force:true});});

describe('review scope before native dispatch',()=>{
 it.each(['company','other-project','missing-project','missing-artifact-id','invalid-artifact-id','missing-artifact','missing-source','wrong-source-project','missing-product','author'] as const)('direct claim blocks %s without creating a run or rewriting retained scope',fault=>{
  let task=review();
  if(fault==='company')task=store.update('assignments',task.id,{projectId:null});
  if(fault==='other-project')task=store.update('assignments',task.id,{projectId:store.command(owner,{type:'project.create',name:'Other',outcome:'Other evidence',acceptance:['Other scope'],supervisorId:director.id,rationale:'Fixture'}).id});
  if(fault==='missing-project')task=store.update('assignments',task.id,{projectId:randomUUID()});
  if(fault==='missing-artifact-id')task=store.update('assignments',task.id,{payload:{}});
  if(fault==='invalid-artifact-id')task=store.update('assignments',task.id,{payload:{artifactId:{invalid:true}}});
  if(fault==='missing-artifact')task=store.update('assignments',task.id,{payload:{artifactId:randomUUID()}});
  if(fault==='missing-source')store.update('artifacts',artifact.id,{assignmentId:randomUUID()});
  if(fault==='wrong-source-project')store.update('assignments',original.id,{projectId:null});
  if(fault==='missing-product')store.update('projects',project.id,{productId:randomUUID()});
  if(fault==='author')task=store.update('assignments',task.id,{employeeId:author.id});
  const runs=store.list('runs'),before={...task};expect(store.claimNext({assignmentId:task.id})).toBeUndefined();
  const retained=store.need('assignments',task.id);expect(retained).toMatchObject({status:'blocked',projectId:before.projectId,payload:before.payload,acceptance:before.acceptance,employeeId:before.employeeId,supervisorId:before.supervisorId,instructions:before.instructions,attempts:before.attempts,reviewScopeHistory:[{priorStatus:'queued'}]});expect(retained.blockedReason).toContain(retained.reviewScopeIssue.reason);expect(store.list('runs')).toEqual(runs);
  const blocked={...retained};store.claimNext({assignmentId:task.id});expect(store.need('assignments',task.id)).toEqual(blocked);
  expect(()=>reconcile()).not.toThrow();expect(store.need('assignments',task.id).status).toBe('blocked');
 });
 it('keeps valid product and company-maintenance review scope unchanged when claimed',()=>{
  store.update('projects',project.id,{productId:null});const task=review(),run=store.claimNext({assignmentId:task.id,workspace:root});expect(run?.assignmentId).toBe(task.id);expect(store.need('assignments',task.id)).toMatchObject({projectId:task.projectId,payload:task.payload,acceptance:task.acceptance,status:'running'});expect(store.need('assignments',task.id).reviewScopeIssue).toBeUndefined();
 });
 it('does not prepare the invalid review workspace or dispatch it to inference during a real scheduler tick',async()=>{
  const task=legacy(),ensure=vi.spyOn(broker.workspaces,'ensure'),execute=vi.spyOn(scheduler as any,'execute').mockResolvedValue(undefined);
  (scheduler as any).recoveryComplete=true;vi.spyOn(scheduler,'initialize').mockResolvedValue();vi.spyOn(scheduler as any,'deliveryEvents').mockResolvedValue(undefined);
  await scheduler.tick();expect(ensure).not.toHaveBeenCalled();expect(store.list('runs').some(run=>run.assignmentId===task.id)).toBe(false);expect(store.need('assignments',task.id).status).toBe('blocked');expect(execute.mock.calls.every(([run]:any[])=>run.assignmentId!==task.id)).toBe(true);
 });
 it.each(['running','queued','blocked'] as const)('preserves an active native review even if its task status is %s, then routes the actual terminal failure',status=>{
  const task=legacy(),actor=active(task);store.update('assignments',task.id,{status});const before=store.need('assignments',task.id),run=store.need('runs',actor.runId);
  reconcile();expect(store.need('assignments',task.id)).toEqual(before);expect(store.need('runs',actor.runId)).toEqual(run);expect(corrections(task)).toHaveLength(0);
  store.update('assignments',task.id,{status:'running'});store.finishRun(actor.runId,{status:'failed',error:'DomainError: wrong_project'});const ended=store.need('runs',actor.runId);
  (scheduler as any).diagnoseFailure(ended);expect(corrections(task)).toHaveLength(1);expect(corrections(task)[0].employeeId).toBe(director.id);expect(store.list('assignments').filter(item=>item.schedulerKey===`fault:${ended.id}`)).toHaveLength(0);expect(store.need('runs',actor.runId)).toEqual(ended);expect(store.need('assignments',task.id).reviewScopeHistory[0].priorBlockedReason).toContain('wrong_project');
 });
});

describe('authorized durable review scope correction',()=>{
 it('deduplicates through restart and preserves the invalid assignment, artifact, reviews and original acceptance',()=>{
  const task=legacy(),beforeArtifact=store.need('artifacts',artifact.id),priorReview=store.put('reviews',{artifactId:artifact.id,artifactIdentity:artifact.identity,employeeId:director.id,runId:'retained-review-run',verdict:'approved',rationale:'Retained actual source approval'});
  reconcile();const correction=corrections(task)[0];expect(correction).toMatchObject({kind:'management',projectId:null,employeeId:director.id,payload:{invalidReviewAssignmentId:task.id,artifactId:artifact.id,sourceProjectId:project.id}});
  store.close();store=new CompanyStore(root);broker=new CorporateBroker(store,root);scheduler=new Scheduler(store,{} as LocalRuntime,broker,'http://localhost');reconcile();reconcile();expect(corrections(task)).toEqual([correction]);expect(store.need('artifacts',artifact.id)).toEqual(beforeArtifact);expect(store.need('reviews',priorReview.id)).toEqual(priorReview);expect(store.need('assignments',task.id)).toMatchObject({projectId:null,employeeId:task.employeeId,supervisorId:task.supervisorId,acceptance:task.acceptance,payload:task.payload,attempts:2,reviewFeedback:task.reviewFeedback,reviewScopeHistory:[{priorStatus:'queued',priorBlockedReason:'Earlier reason'}]});
 });
 it('chooses existing common management that can read borrowed company-scope work and create the corrected project review',async()=>{
  const sibling=hire('Other director',ceo.id,'lead'),borrowed=hire('Borrowed reviewer',sibling.id);reviewer=borrowed;const task=legacy();reconcile();const correction=corrections(task)[0];expect(correction.employeeId).toBe(ceo.id);const actor=active(correction);
  for(const [collection,id] of [['assignments',task.id],['artifacts',artifact.id],['projects',project.id]])await expect(broker.call(actor,'company_detail',{collection,id,view:'record'})).resolves.toBeDefined();
  expect(outcome(correction,actor).passed).toBe(false);
  await broker.call(actor,'company_command',{command:{type:'assignment.update',assignmentId:task.id,status:'cancelled',blockedReason:'Company scope cannot review this product artifact; replacement retains exact artifact and project.',rationale:'Inspected source binding and existing supervisor authority.'}});
  const replacement=await broker.call(actor,'create_assignment',{projectId:project.id,employeeId:director.id,kind:'review',title:'Correctly scoped independent verdict',instructions:'Inspect actual artifact and original acceptance',acceptance:task.acceptance,payload:{artifactId:artifact.id}});
  expect(store.need('assignments',replacement.id)).toMatchObject({projectId:project.id,payload:{artifactId:artifact.id},employeeId:director.id,status:'queued'});expect(outcome(correction,actor).passed).toBe(true);expect(store.need('assignments',task.id)).toMatchObject({status:'cancelled',projectId:null,payload:task.payload,acceptance:task.acceptance});
 });
 it('requires an exact current-run explained disposition, not prose, an unrelated write or replacement creation alone',async()=>{
  const task=legacy();reconcile();const correction=corrections(task)[0],actor=active(correction);store.update('runs',actor.runId,{text:'The review is resolved.'});expect(outcome(correction,actor).passed).toBe(false);
  await broker.call(actor,'create_assignment',{projectId:project.id,employeeId:director.id,kind:'review',title:'Replacement only',instructions:'Inspect actual evidence',acceptance:task.acceptance,payload:{artifactId:artifact.id}});expect(outcome(correction,actor).passed).toBe(false);
  await expect(broker.call(actor,'company_command',{command:{type:'assignment.update',assignmentId:task.id,blockedReason:'The old review remains invalid until capacity is confirmed.'}})).rejects.toThrow(/disposition rationale/);expect(outcome(correction,actor).passed).toBe(false);
  await broker.call(actor,'company_command',{command:{type:'assignment.update',assignmentId:task.id,blockedReason:'The old review remains invalid until independent capacity is confirmed; its product scope cannot be changed.',rationale:'Existing independent reviewer has another commitment; no source or acceptance change is authorized.'}});expect(outcome(correction,actor).passed).toBe(true);
  const retained=store.need('assignments',task.id);reconcile();expect(store.need('assignments',task.id)).toEqual(retained);expect(corrections(task)).toHaveLength(1);
  store.update('assignments',task.id,{blockedReason:'Later unbound edit'});expect(outcome(correction,actor).passed).toBe(false);
 });
 it('supersedes only queued generic failures and retains completed diagnostics and all actual failed-run evidence',()=>{
  const task=legacy(),actor=active(task);store.finishRun(actor.runId,{status:'failed',error:'wrong_project'});
  const make=(status:Assignment['status'])=>store.put('assignments',{...task,id:undefined,kind:'management',status,projectId:null,schedulerKey:`fault:${randomUUID()}`,payload:{failedAssignmentId:task.id,failedRunId:actor.runId}});
  const queued=make('queued'),completed=make('completed');reconcile();expect(store.need('assignments',queued.id)).toMatchObject({status:'cancelled',blockedReason:expect.stringContaining(`review-scope:${task.id}`)});expect(store.need('assignments',completed.id)).toEqual(completed);expect(corrections(task)).toHaveLength(1);
 });
 it('does not create a competing correction while a generic diagnosis is active',()=>{
  const task=legacy(),diagnosis=store.put('assignments',{...task,id:undefined,kind:'management',status:'running',schedulerKey:'fault:prior',payload:{failedAssignmentId:task.id}}),actor=active(diagnosis);reconcile();expect(corrections(task)).toHaveLength(0);expect(store.need('assignments',diagnosis.id).status).toBe('running');store.finishRun(actor.runId,{status:'failed',error:'Scope correction needed'});reconcile();expect(corrections(task)).toHaveLength(1);
 });
 it('records the precise unavailable-authority gate without granting authority or dispatching the invalid task',()=>{
  const task=legacy();store.update('employees',director.id,{status:'dismissed'});store.update('employees',ceo.id,{status:'dismissed'});reconcile();expect(corrections(task)).toHaveLength(0);const blocked=store.need('assignments',task.id);expect(blocked).toMatchObject({status:'blocked',projectId:null,supervisorId:author.id,reviewScopeRecovery:{state:'blocked'}});expect(blocked.reviewScopeRecovery.reason).toContain(author.id);expect(blocked.reviewScopeRecovery.reason).toContain(project.id);expect(store.claimNext({assignmentId:task.id})).toBeUndefined();
  store.update('employees',ceo.id,{status:'active'});reconcile();expect(corrections(task)).toHaveLength(1);expect(corrections(task)[0].employeeId).toBe(ceo.id);expect(store.reviewScopeCorrectionAllowed(corrections(task)[0])).toBe(true);
 });
 it('holds a queued stale coordinator even on direct claim and reroutes the same task using existing authority',()=>{
  const task=legacy();reconcile();const correction=corrections(task)[0];store.update('employees',director.id,{status:'dismissed'});expect(store.claimNext({assignmentId:correction.id})).toBeUndefined();expect(store.need('assignments',correction.id)).toEqual(correction);
  reconcile();const routed=store.need('assignments',correction.id);expect(corrections(task)).toHaveLength(1);expect(routed).toMatchObject({employeeId:ceo.id,projectId:null,payload:correction.payload,acceptance:correction.acceptance,reviewScopeRoutingHistory:[{priorEmployeeId:director.id,employeeId:ceo.id}]});expect(store.reviewScopeCorrectionAllowed(routed)).toBe(true);
 });
 it('does not credit the old run after Owner reassigns the active correction, even when its former actor retains management authority',async()=>{
  const task=legacy();reconcile();const correction=corrections(task)[0],actor=active(correction);store.command(owner,{type:'assignment.update',assignmentId:correction.id,employeeId:ceo.id,rationale:'Current correction responsibility moved to CEO.'});expect(store.need('runs',actor.runId)).toMatchObject({status:'running',tokenRevoked:false});
  await broker.call(actor,'company_command',{command:{type:'assignment.update',assignmentId:task.id,status:'cancelled',blockedReason:'Invalid company-scoped review cancelled; exact artifact approval remains retained.',rationale:'Old coordinator still supervises this source assignment but no longer owns the correction.'}});
  expect(store.need('assignments',task.id).status).toBe('cancelled');expect(outcome(correction,actor).passed).toBe(false);expect(store.need('assignments',correction.id)).toMatchObject({employeeId:ceo.id,status:'running'});
 });
 it.each(['running','completed','cancelled'] as const)('does not reroute a %s correction after its coordinator changes',status=>{
  const task=legacy();reconcile();const correction=corrections(task)[0];store.update('assignments',correction.id,{status});const before=store.need('assignments',correction.id);store.update('employees',director.id,{status:'dismissed'});reconcile();expect(store.need('assignments',correction.id)).toEqual(before);expect(corrections(task)).toHaveLength(1);
 });
 it('cancels only a queued correction resolved by a separate real cancellation of the original',()=>{
  const task=legacy();reconcile();const correction=corrections(task)[0];store.command(owner,{type:'assignment.update',assignmentId:task.id,status:'cancelled',blockedReason:'No additional review needed; exact existing approval retained.',rationale:'Owner inspected retained independent approval.'});const target=store.need('assignments',task.id);expect(store.claimNext({assignmentId:correction.id})).toBeUndefined();reconcile();expect(store.need('assignments',correction.id).status).toBe('cancelled');expect(store.need('assignments',task.id)).toEqual(target);
 });
 it.each(['completed','cancelled'] as const)('never rewrites an invalid %s review',status=>{
  const task=legacy();store.update('assignments',task.id,{status,completedAt:'2026-09-10T00:00:00Z'});const before=store.need('assignments',task.id);reconcile();expect(store.need('assignments',task.id)).toEqual(before);expect(corrections(task)).toHaveLength(0);
 });
});
