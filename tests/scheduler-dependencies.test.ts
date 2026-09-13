import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CompanyStore } from '../src/storage/store.js';
import { Scheduler, managementOutcome, governanceDispatchAllowed } from '../src/scheduler/scheduler.js';
import { CorporateBroker } from '../src/tools/broker.js';
import type { LocalRuntime } from '../src/runtime/index.js';
import type { Actor, Assignment, Employee } from '../src/core/types.js';

let root:string,store:CompanyStore,scheduler:Scheduler,ceo:Employee;
const owner={kind:'owner'} as const;
const recoveryTasks=()=>store.list('assignments').filter(item=>item.schedulerKey?.startsWith('dependency-wait:'));
const reconcile=()=>{(scheduler as any).reconcileOrganization();};
const createWork=(dependencies:string[]=[],extra:Record<string,unknown>={})=>store.command(owner,{type:'assignment.create',employeeId:ceo.id,supervisorId:ceo.id,title:'Finite fixture work',instructions:'Perform the assigned finite work',acceptance:['Actual finite result'],dependencies,...extra}) as Assignment;
const setup=(status:Assignment['status']='blocked')=>{
 const project=store.command(owner,{type:'project.create',name:'Fixture project',outcome:'Actual finite outcome',acceptance:['Verified outcome'],rationale:'Dependency recovery fixture',supervisorId:ceo.id});
 const prerequisite=createWork([],{projectId:project.id});store.update('assignments',prerequisite.id,{status});
 const waiting=createWork([prerequisite.id],{projectId:project.id,payload:{sourceAssignmentId:prerequisite.id}});
 return {project,prerequisite,waiting};
};
const startDiagnosis=(waiting:Assignment)=>{
 reconcile();const task=recoveryTasks().find(item=>item.payload.blockedAssignmentId===waiting.id)!;
 const run=store.claimNext({assignmentId:task.id,workspace:join(root,'workspaces',`company-${ceo.id}`)})!;expect(run).toBeDefined();
 store.bindSession(run.id,randomUUID());
 const actor:Actor={kind:'employee',employeeId:ceo.id,runId:run.id,policyRevision:run.policyRevision};
 return {task,run,actor,outcome:()=>managementOutcome(store,task,store.need('runs',run.id))};
};

beforeEach(()=>{
 root=mkdtempSync(join(tmpdir(),'opencorp-dependency-scheduler-'));store=new CompanyStore(root);store.bootstrap();
 ceo=store.list('employees').find(item=>store.level(item.id)==='ceo')!;store.put('models',{name:ceo.modelId,artifactIdentity:'fixture-installed-local-model',local:true,available:true,capabilities:['tools']});
 store.command(owner,{type:'control',action:'start'});scheduler=new Scheduler(store,{} as LocalRuntime,new CorporateBroker(store,root),'http://localhost');
});
afterEach(()=>{store.close();rmSync(root,{recursive:true,force:true});});

describe('queued dependency recovery',()=>{
 it('prioritizes dependency recovery above routine reassessment while preserving higher assignment priorities',()=>{
  const {waiting}=setup();reconcile();expect(recoveryTasks()[0].priority).toBe(20);store.update('assignments',waiting.id,{dependencies:[]});reconcile();
  const urgent=setup().waiting;store.update('assignments',urgent.id,{priority:40});reconcile();expect(recoveryTasks().find(item=>item.payload.blockedAssignmentId===urgent.id)?.priority).toBe(42);
 });
 it.each(['blocked','cancelled','missing'] as const)('routes a %s prerequisite to exact supervising company-workspace diagnosis',status=>{
  const {waiting,prerequisite,project}=setup(status==='missing'?'blocked':status);
  const dependencyId=status==='missing'?'retained-missing-assignment':prerequisite.id;
  if(status==='missing')store.update('assignments',waiting.id,{dependencies:[dependencyId]});
  const before=store.need('assignments',waiting.id);reconcile();
  expect(recoveryTasks()).toHaveLength(1);const task=recoveryTasks()[0];
  expect(task).toMatchObject({projectId:null,employeeId:ceo.id,kind:'management',status:'queued',dependencies:[],payload:{sourceProjectId:project.id,blockedAssignmentId:waiting.id,baselineDependencies:[dependencyId],blockingDependencyIds:[dependencyId],blockingDependencies:[{id:dependencyId,status}]}});
  expect(task.payload.failedRunId).toBeUndefined();expect(task.instructions).toContain(dependencyId);expect(task.instructions).toContain('payload.sourceAssignmentId is provenance only');
  expect(store.need('assignments',waiting.id)).toEqual(before);expect(store.claimNext({assignmentId:waiting.id})).toBeUndefined();
  expect(store.claimNext({assignmentId:task.id,workspace:join(root,'company-diagnosis')})?.assignmentId).toBe(task.id);
 });
 it.each(['queued','running','awaiting_review','needs_changes','completed'] as const)('respects genuine %s prerequisite progress without inventing a fault',status=>{
  setup(status);reconcile();expect(recoveryTasks()).toHaveLength(0);
 });
 it('deduplicates an unchanged wait through restart while retaining a changed status signature',()=>{
  const {waiting,prerequisite}=setup();reconcile();const key=recoveryTasks()[0].schedulerKey;reconcile();expect(recoveryTasks()).toHaveLength(1);
  store.close();store=new CompanyStore(root);scheduler=new Scheduler(store,{} as LocalRuntime,new CorporateBroker(store,root),'http://localhost');reconcile();expect(recoveryTasks()).toHaveLength(1);expect(recoveryTasks()[0].schedulerKey).toBe(key);
  store.update('assignments',prerequisite.id,{status:'cancelled'});reconcile();expect(recoveryTasks()).toHaveLength(2);expect(new Set(recoveryTasks().map(item=>item.schedulerKey)).size).toBe(2);expect(recoveryTasks().filter(item=>item.status==='queued')).toHaveLength(1);expect(store.need('assignments',waiting.id).dependencies).toEqual([prerequisite.id]);
 });
 it('cancels stale queued contexts as other prerequisites progress or management resolves the graph',()=>{
  const {waiting,prerequisite}=setup(),progress=createWork([],{kind:'management'});store.command(owner,{type:'assignment.update',assignmentId:waiting.id,dependencies:[prerequisite.id,progress.id],rationale:'Both retained prerequisites initially apply'});
  reconcile();const first=recoveryTasks()[0];
  for(const status of ['running','completed'] as const){store.update('assignments',progress.id,{status});reconcile();expect(recoveryTasks().filter(item=>item.status==='queued')).toHaveLength(1);}
  expect(store.need('assignments',first.id)).toMatchObject({status:'cancelled',dependencyWaitSuperseded:true});expect(store.need('assignments',first.id).dependencyWaitSupersessions).toHaveLength(1);expect(store.claimNext({assignmentId:first.id})).toBeUndefined();
  store.command(owner,{type:'assignment.update',assignmentId:waiting.id,dependencies:[progress.id],rationale:'Observed broad original is provenance, while the actual prerequisite completed'});const target=store.need('assignments',waiting.id);reconcile();
  expect(recoveryTasks().every(item=>item.status==='cancelled')).toBe(true);expect(store.need('assignments',waiting.id)).toEqual(target);expect(store.claimNext({assignmentId:waiting.id,workspace:root})?.assignmentId).toBe(waiting.id);
 });
 it('cancels a resolved prerequisite diagnosis without requiring unnecessary management edits',()=>{
  const {waiting,prerequisite}=setup();reconcile();const task=recoveryTasks()[0];store.update('assignments',prerequisite.id,{status:'completed'});reconcile();
  expect(store.need('assignments',task.id).status).toBe('cancelled');expect(store.claimNext({assignmentId:task.id})).toBeUndefined();expect(store.need('assignments',waiting.id).dependencies).toEqual([prerequisite.id]);
 });
 it('reactivates only an auto-superseded diagnosis when the exact waiting context recurs',()=>{
  const {waiting}=setup();reconcile();const task=recoveryTasks()[0];store.command(owner,{type:'assignment.update',assignmentId:waiting.id,status:'blocked',blockedReason:'Management is checking actual prerequisites',rationale:'Preserve the waiting work'});reconcile();
  expect(store.need('assignments',task.id)).toMatchObject({status:'cancelled',dependencyWaitSuperseded:true});
  store.command(owner,{type:'assignment.update',assignmentId:waiting.id,status:'queued',rationale:'Return this same waiting work to management scheduling'});reconcile();reconcile();
  expect(recoveryTasks()).toHaveLength(1);expect(store.need('assignments',task.id)).toMatchObject({status:'queued',dependencyWaitSuperseded:false,payload:{baselineBlockedReason:'Management is checking actual prerequisites'}});expect(store.need('assignments',task.id).blockedReason).toBeUndefined();expect(store.need('assignments',task.id).dependencyWaitSupersessions).toHaveLength(1);
 });
 it.each(['completed','cancelled','blocked'] as const)('keeps an unchanged intentionally %s diagnosis deduplicated',status=>{
  setup();reconcile();const task=recoveryTasks()[0];store.update('assignments',task.id,{status,blockedReason:'Retained deliberate disposition'});reconcile();
  expect(recoveryTasks()).toHaveLength(1);expect(store.need('assignments',task.id)).toMatchObject({status,blockedReason:'Retained deliberate disposition'});
 });
 it('does not interrupt or duplicate an active diagnosis after its prerequisite context changes',()=>{
  const {waiting,prerequisite}=setup(),{task,run}=startDiagnosis(waiting);store.update('assignments',prerequisite.id,{status:'cancelled'});reconcile();
  expect(recoveryTasks()).toHaveLength(1);expect(store.need('assignments',task.id).status).toBe('running');expect(store.need('runs',run.id).status).toBe('running');
 });
 it('replaces queued diagnoses after the supervising project context changes',()=>{
  const {waiting}=setup();reconcile();const prior=recoveryTasks()[0];store.update('assignments',waiting.id,{projectId:null});reconcile();
  expect(store.need('assignments',prior.id).status).toBe('cancelled');expect(recoveryTasks().filter(item=>item.status==='queued')).toHaveLength(1);expect(recoveryTasks().find(item=>item.status==='queued')?.payload.sourceProjectId).toBeNull();expect(store.claimNext({assignmentId:prior.id})).toBeUndefined();
 });
 it('waits for the creator run to finish constructing its assignments',()=>{
  const prerequisite=createWork();store.update('assignments',prerequisite.id,{status:'blocked'});
  const creator=createWork([],{kind:'management'}),run=store.claimNext({assignmentId:creator.id,workspace:root})!;store.bindSession(run.id,randomUUID());
  const actor:Actor={kind:'employee',employeeId:ceo.id,runId:run.id,policyRevision:run.policyRevision};
  const waiting=store.command(actor,{type:'assignment.create',employeeId:ceo.id,title:'Subset created during diagnosis',instructions:'Finite work',acceptance:['Finite result'],dependencies:[prerequisite.id]});
  reconcile();expect(recoveryTasks()).toHaveLength(0);store.finishRun(run.id,{status:'succeeded',managementResult:{summary:'Actual assignment persisted'}});reconcile();expect(recoveryTasks()).toHaveLength(1);expect(recoveryTasks()[0].payload.blockedAssignmentId).toBe(waiting.id);
 });
 it('requires this run to change the exact edges and verifies the audited current state',()=>{
  const {waiting,prerequisite}=setup(),{actor,run,outcome}=startDiagnosis(waiting);
  expect(outcome().passed).toBe(false);store.command(actor,{type:'knowledge.write',scope:'company',title:'Unrelated fixture note',content:'This does not repair the prerequisite.',source:'Dependency fixture'});expect(outcome().passed).toBe(false);
  store.command(actor,{type:'assignment.update',assignmentId:waiting.id,dependencies:[prerequisite.id],rationale:'No actual edge change'});expect(outcome().passed).toBe(false);
  store.command(actor,{type:'assignment.update',assignmentId:waiting.id,dependencies:[],rationale:'The original broad task is provenance; this subset has no completion prerequisite'});
  expect(outcome().passed).toBe(true);expect(store.need('assignments',waiting.id)).toMatchObject({status:'queued',acceptance:waiting.acceptance,payload:waiting.payload,dependencies:[]});
  store.update('assignments',waiting.id,{dependencies:[prerequisite.id]});expect(outcome().passed).toBe(false);
  store.command(actor,{type:'assignment.update',assignmentId:waiting.id,dependencies:[],rationale:'Restore the evidenced finite prerequisite correction'});expect(outcome().passed).toBe(true);
  store.finishRun(run.id,{status:'succeeded',managementResult:{summary:outcome().summary}});expect(store.claimNext({assignmentId:waiting.id,workspace:root})?.assignmentId).toBe(waiting.id);
 });
 it('rejects a prior-run or wrong-target correction as completion evidence',()=>{
  const {waiting,prerequisite}=setup(),{actor,run,outcome}=startDiagnosis(waiting),other=createWork([prerequisite.id]);
  store.command(actor,{type:'assignment.update',assignmentId:other.id,dependencies:[],rationale:'Unrelated correction'});expect(outcome().passed).toBe(false);
  store.command(actor,{type:'assignment.update',assignmentId:waiting.id,dependencies:[],rationale:'Correct the actual prerequisite'});const current=store.need('assignments',waiting.id);expect(outcome().passed).toBe(true);
  store.update('assignments',waiting.id,{dependencyDecisions:current.dependencyDecisions.map((entry:any)=>({...entry,runId:'prior-run'}))});expect(outcome().passed).toBe(false);
  store.update('assignments',waiting.id,{dependencyDecisions:current.dependencyDecisions.map((entry:any)=>({...entry,actorId:'other-supervisor',runId:run.id}))});expect(outcome().passed).toBe(false);
 });
 it.each(['blocked','cancelled'])('accepts an explicit %s disposition while preserving genuine prerequisites and acceptance',status=>{
  const {waiting,prerequisite}=setup(),{actor,outcome}=startDiagnosis(waiting);
  store.command(actor,{type:'assignment.update',assignmentId:waiting.id,status,blockedReason:'The independently required upstream result remains unavailable.',rationale:'The upstream assignment supplies an actual prerequisite; removing it would misstate readiness.'});
  expect(outcome().passed).toBe(true);expect(store.need('assignments',waiting.id)).toMatchObject({status,dependencies:[prerequisite.id],acceptance:waiting.acceptance});
 });
 it('does not accept a status change without an audited rationale or a new reason',()=>{
  const {waiting}=setup();store.update('assignments',waiting.id,{blockedReason:'Previously retained explanation'});const {actor,outcome}=startDiagnosis(waiting);
  store.command(actor,{type:'assignment.update',assignmentId:waiting.id,status:'blocked',blockedReason:'Previously retained explanation',rationale:'Repeated old explanation'});expect(outcome().passed).toBe(false);
  store.command(actor,{type:'assignment.update',assignmentId:waiting.id,status:'cancelled',blockedReason:'New disposition without an evidence-based rationale'});expect(outcome().passed).toBe(false);
 });
 it.each(['dependency-wait','responsibility'])('defers %s recovery descendants and child votes without blocking an Elder\'s own original-vote recovery',lastKind=>{
  const elders=store.list('employees').filter(item=>store.level(item.id)==='elder'),[author,peer,third]=elders;
  const originalDecision=store.command(owner,{type:'decision.create',kind:'executive.review',subject:'Independent original review',rationale:'Actual fixture outcome',payload:{employeeId:ceo.id}});
  const original=store.command(owner,{type:'assignment.create',employeeId:author.id,supervisorId:author.id,kind:'governance',title:'Private original judgment',instructions:'Form an independent vote',acceptance:['Recorded original vote'],payload:{decisionId:originalDecision.id}});
  const derive=(source:Assignment,key:string)=>{
   const item=store.command(owner,{type:'assignment.create',employeeId:author.id,supervisorId:author.id,kind:'management',title:'Private derived judgment',instructions:'Inspect actual retained origin',acceptance:['Actual diagnosis']});
   return store.update('assignments',item.id,{status:'completed',schedulerKey:key,payload:key.startsWith('fault:')?{failedAssignmentId:source.id}:key.startsWith('responsibility:')?{sourceAssignmentId:source.id}:{blockedAssignmentId:source.id}});
  };
  const first=derive(original,'dependency-wait:first'),middle=derive(first,'fault:middle'),last=derive(middle,`${lastKind}:last`);
  expect(governanceDispatchAllowed(store,last)).toBe(true);expect(governanceDispatchAllowed(store,{...last,employeeId:peer.id})).toBe(false);
  const run=store.put('runs',{employeeId:author.id,assignmentId:last.id,modelId:author.modelId,policyRevision:store.policy.revision,workspace:root,sessionId:randomUUID(),status:'running',attempt:1,leaseUntil:new Date(Date.now()+60000).toISOString(),heartbeatAt:new Date().toISOString(),tokenRevoked:false});
  const actor:Actor={kind:'employee',employeeId:author.id,runId:run.id,policyRevision:store.policy.revision};
  const child=store.command(actor,{type:'decision.create',kind:'executive.review',subject:'PRIVATE mixed-chain follow-up',rationale:'Originating judgment retained',payload:{employeeId:ceo.id}});reconcile();
  expect(store.list('assignments').filter(item=>item.kind==='governance'&&item.payload?.decisionId===child.id)).toEqual([]);
  // Even a retained child task created before this fix must stay out of dispatch.
  const retained=store.command(owner,{type:'assignment.create',employeeId:peer.id,supervisorId:peer.id,kind:'governance',title:'Retained child task',instructions:'Review after original vote',acceptance:['Recorded child vote'],payload:{decisionId:child.id}});
  expect(governanceDispatchAllowed(store,retained)).toBe(false);
  const vote=(employee:Employee,approve:boolean)=>{
   const task=store.list('assignments').find(item=>item.kind==='governance'&&item.employeeId===employee.id&&item.payload?.decisionId===originalDecision.id)!;
   const voteRun=store.put('runs',{...run,id:undefined,employeeId:employee.id,assignmentId:task.id,sessionId:randomUUID()});
   store.command({kind:'employee',employeeId:employee.id,runId:voteRun.id,policyRevision:store.policy.revision},{type:'decision.vote',decisionId:originalDecision.id,approve,rationale:'My independently formed original judgment'});
  };
  vote(peer,false);reconcile();expect(governanceDispatchAllowed(store,retained)).toBe(true);expect(governanceDispatchAllowed(store,{...last,employeeId:peer.id})).toBe(true);expect(governanceDispatchAllowed(store,{...last,employeeId:third.id})).toBe(false);
  expect(store.list('assignments').filter(item=>item.schedulerKey?.startsWith(`vote:${child.id}:`)).map(item=>item.employeeId)).toEqual([peer.id]);
  vote(author,true);reconcile();expect(new Set(store.list('assignments').filter(item=>item.schedulerKey?.startsWith(`vote:${child.id}:`)).map(item=>item.employeeId))).toEqual(new Set([author.id,peer.id]));
  expect(store.list('votes').find(item=>item.decisionId===originalDecision.id&&item.employeeId===peer.id)?.approve).toBe(false);
 });
});
