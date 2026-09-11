import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyStore, instructionsHash } from '../src/storage/store.js';
import { CorporateBroker, brokerTools, corporateGuide } from '../src/tools/broker.js';
import { managementOutcome } from '../src/scheduler/scheduler.js';
import { commandFields } from '../src/tools/commands.js';
import type { Actor, Employee, Project } from '../src/core/types.js';

const owner={kind:'owner'} as const,model='wlkr-management-qwen3.8-27b-q4-k-m:latest';
let root:string,store:CompanyStore,broker:CorporateBroker,ceo:Employee;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'opencorp-broker-'));store=new CompanyStore(root);store.bootstrap();store.put('models',{name:model,artifactIdentity:'fixture-local-digest',local:true,available:true,capabilities:['tools']});store.command(owner,{type:'control',action:'start'});broker=new CorporateBroker(store,root);ceo=store.list('employees').find(e=>store.level(e.id)==='ceo')!;});
afterEach(async()=>{await broker.cancel();store.close();rmSync(root,{recursive:true,force:true});vi.restoreAllMocks();});
function hire(name:string,homeManagerId=ceo.id,level='manager'):Employee{const position=store.command(owner,{type:'position.create',title:name,level,responsibilities:'Concrete product responsibility'});return store.command(owner,{type:'employee.hire',name,positionId:position.id,homeManagerId,modelId:model});}
function actorFor(employee:Employee,project?:Project):Extract<Actor,{kind:'employee'}>{
 const assignment=store.command(owner,{type:'assignment.create',employeeId:employee.id,projectId:project?.id,title:'Inspect retained evidence',instructions:'Diagnose actual work',acceptance:['Source-linked judgment'],kind:project?'implementation':'management'});
 const run=store.put('runs',{employeeId:employee.id,assignmentId:assignment.id,modelId:model,workspace:project?.workspace??root,sessionId:randomUUID(),policyRevision:store.policy.revision,status:'running',attempt:1,heartbeatAt:new Date().toISOString(),leaseUntil:new Date(Date.now()+60000).toISOString(),tokenRevoked:false,tokenHash:'PRIVATE_TOKEN_HASH'});
 return {kind:'employee',employeeId:employee.id,runId:run.id,policyRevision:store.policy.revision};
}

describe('typed management tools',()=>{
 function diagnosis(){
  const manager=hire('Product supervisor'),worker=hire('Assigned implementer',manager.id,'worker');
  const project=store.command(owner,{type:'project.create',name:'Retained broad commitment',productId:store.list('products')[0].id,outcome:'Actual reviewed delivery',acceptance:['Document CI','External contribution merged'],supervisorId:manager.id,rationale:'Leadership-selected scope'});
  let original=store.command(owner,{type:'assignment.create',projectId:project.id,employeeId:worker.id,title:'Broad original work',instructions:'Document CI and obtain the external contribution.',acceptance:project.acceptance,kind:'implementation'});
  original=store.update('assignments',original.id,{status:'blocked',blockedReason:'Missing implementation checkpoint',attempts:3});
  const failed=store.put('runs',{employeeId:worker.id,assignmentId:original.id,modelId:model,status:'failed',attempt:3,error:original.blockedReason});
  const actor=actorFor(manager,project),task=store.update('assignments',store.need('runs',actor.runId).assignmentId,{kind:'management',status:'running',schedulerKey:`fault:${failed.id}`,payload:{failedRunId:failed.id,failedAssignmentId:original.id,baselineModelId:model,baselineInstructionsHash:instructionsHash(original.instructions),baselineBlockedReason:original.blockedReason}});
  const outcome=()=>managementOutcome(store,store.need('assignments',task.id),store.need('runs',actor.runId));
  return {manager,worker,project,original,failed,actor,task,outcome};
 }
 const disposition={blockedReason:'The original acceptance requires an external contributor and cannot be completed by this implementation alone.',rationale:'The retained assignment includes an external contribution, while the failed run contains no authored artifact.',remainingPrerequisite:'An independently reviewed external contribution must actually merge before the original acceptance can be complete.'};
 it('advertises direct arguments with no caller-selected diagnosis identity',()=>{
  const create=brokerTools.find(tool=>tool.name==='create_assignment')!.inputSchema,blocked=brokerTools.find(tool=>tool.name==='record_blocked_diagnosis')!.inputSchema;
  expect(create.required).toEqual(['employeeId','title','instructions','acceptance']);expect(create.additionalProperties).toBe(false);
  expect(blocked.required).toEqual(['blockedReason','rationale','remainingPrerequisite']);expect(Object.keys(blocked.properties)).toEqual(blocked.required);expect(blocked.additionalProperties).toBe(false);
  expect(corporateGuide).toContain('Prefer create_assignment');expect(corporateGuide).toContain('prefer record_blocked_diagnosis');
 });
 it('creates only explicitly scoped subset work with unchanged supervision, staffing and original acceptance rules',async()=>{
  const {actor,worker,project,original,outcome}=diagnosis(),other=hire('Other home manager'),shared=hire('Shared specialist',other.id,'worker');
  const input={employeeId:worker.id,projectId:project.id,title:'Document existing CI',instructions:'Write accurate CI documentation and verify the source.',acceptance:['CI documentation committed and verified'],kind:'implementation',priority:7,payload:{sourceAssignmentId:original.id}};
  const created=await broker.call(actor,'create_assignment',input);
  expect(store.need('assignments',created.id)).toMatchObject({...input,supervisorId:actor.employeeId,status:'queued',accepted:true});
  const sharedTask=await broker.call(actor,'create_assignment',{...input,employeeId:shared.id});expect(store.need('assignments',sharedTask.id).accepted).toBe(false);
  expect(store.need('assignments',original.id)).toEqual(original);expect(outcome().passed).toBe(false);
  const outsider=actorFor(other),before=store.list('assignments');await expect(broker.call(outsider,'create_assignment',input)).rejects.toThrow(/project supervisor/);expect(store.list('assignments')).toEqual(before);
 });
 it.each([{command:{employeeId:'wrapped'}},{employeeId:'employee',title:'Missing acceptance',instructions:'Actual work'},{employeeId:'employee',title:'Empty acceptance',instructions:'Actual work',acceptance:[]}])('rejects malformed typed assignment arguments without creating work',async input=>{
  const {actor}=diagnosis(),before=store.list('assignments');await expect(broker.call(actor,'create_assignment',input)).rejects.toThrow(/direct employeeId.*nonempty acceptance/);expect(store.list('assignments')).toEqual(before);expect(store.need('runs',actor.runId).corporateCommands??[]).toEqual([]);
 });
 it('atomically retains a precise blocked disposition and actual current-run receipts, without completing original work',async()=>{
  const {actor,original,failed,task,outcome}=diagnosis(),observations:boolean[]=[];
  store.events.on('event',event=>{if(['assignment.update','decision.create'].includes(event.type))observations.push(store.need('assignments',original.id).blockedReason===disposition.blockedReason&&store.list('decisions').some(d=>d.runId===actor.runId&&d.payload.failedRunId===failed.id)&&(store.need('runs',actor.runId).corporateCommands??[]).length===2);});
  const result=await broker.call(actor,'record_blocked_diagnosis',{...disposition,failedAssignmentId:'untrusted-other-assignment',actor:{kind:'owner'}});
  expect(result.currentDiagnosis).toMatchObject({assignmentId:task.id,blockedAssignmentId:original.id});expect(result.currentDiagnosis.assignmentId).not.toBe(result.assignment.id);
  expect(result.assignment.id).toBe(original.id);expect(result.decision._receipt.fullRecord).toEqual({collection:'decisions',id:result.decision.id});
  expect(store.need('assignments',original.id)).toMatchObject({status:'blocked',instructions:original.instructions,acceptance:original.acceptance,blockedReason:disposition.blockedReason});
  expect(store.need('decisions',result.decision.id)).toMatchObject({authorId:actor.employeeId,runId:actor.runId,kind:'strategy',status:'recorded',rationale:disposition.rationale,payload:{failedRunId:failed.id,failedAssignmentId:original.id,disposition:'blocked',remainingPrerequisite:disposition.remainingPrerequisite}});
  expect(store.need('runs',actor.runId).corporateCommands?.map((command:any)=>command.type)).toEqual(['assignment.update','decision.create']);expect(observations).toEqual([true,true]);expect(outcome().passed).toBe(true);expect(store.need('assignments',task.id).status).toBe('running');
  const decisions=store.list('decisions');await expect(broker.call(actor,'record_blocked_diagnosis',disposition)).rejects.toThrow(/existing or initial/);expect(store.list('decisions')).toEqual(decisions);
 });
 it.each(['wrong actor','stale run','queued original','completed original','cancelled original','inactive diagnosis'] as const)('denies a blocked disposition for %s',async scenario=>{
  const fixture=diagnosis();let actor=fixture.actor;
  if(scenario==='wrong actor')actor=actorFor(hire('Unrelated supervisor'));
  if(scenario==='stale run')store.put('runs',{...fixture.failed,id:undefined,attempt:4});
  if(scenario.endsWith(' original'))store.update('assignments',fixture.original.id,{status:scenario==='queued original'?'queued':scenario==='completed original'?'completed':'cancelled'});
  if(scenario==='inactive diagnosis')store.update('assignments',fixture.task.id,{status:'blocked'});
  const before=store.need('assignments',fixture.original.id),decisions=store.list('decisions');await expect(broker.call(actor,'record_blocked_diagnosis',disposition)).rejects.toThrow(/active trusted diagnosis/);expect(store.need('assignments',fixture.original.id)).toEqual(before);expect(store.list('decisions')).toEqual(decisions);expect(store.need('runs',actor.runId).corporateCommands??[]).toEqual([]);
 });
 it.each([{blockedReason:' ',rationale:'Actual cause',remainingPrerequisite:'Actual prerequisite'},{blockedReason:'New reason',rationale:' ',remainingPrerequisite:'Actual prerequisite'},{blockedReason:'New reason',rationale:'Actual cause'},{blockedReason:'Missing implementation checkpoint',rationale:'Actual cause',remainingPrerequisite:'Actual prerequisite'}])('rejects malformed or unchanged blocked diagnoses before any business mutation',async input=>{
  const {actor,original}=diagnosis(),decisions=store.list('decisions');await expect(broker.call(actor,'record_blocked_diagnosis',input)).rejects.toThrow(/nonempty text|existing or initial/);expect(store.need('assignments',original.id)).toEqual(original);expect(store.list('decisions')).toEqual(decisions);expect(store.need('runs',actor.runId).corporateCommands??[]).toEqual([]);
 });
 it('rolls back both original correction and receipts and emits no committed notifications when decision storage fails',async()=>{
  const {actor,original}=diagnosis(),decisions=store.list('decisions'),notified:string[]=[];
  store.events.on('event',event=>{if(['assignment.update','decision.create'].includes(event.type))notified.push(event.type);});
  store.db.exec("CREATE TRIGGER reject_diagnosis BEFORE INSERT ON decisions BEGIN SELECT RAISE(ABORT,'fixture decision storage failed'); END;");
  await expect(broker.call(actor,'record_blocked_diagnosis',disposition)).rejects.toThrow(/fixture decision storage failed/);
  expect(store.need('assignments',original.id)).toEqual(original);expect(store.list('decisions')).toEqual(decisions);expect(store.need('runs',actor.runId).corporateCommands??[]).toEqual([]);expect(notified).toEqual([]);
 });
});

describe('scoped retained evidence',()=>{
 it('prioritizes recent scoped corrections over oversized old profiles without admitting another employee private notes',()=>{
  const worker=hire('Current specialist',ceo.id,'worker'),other=hire('Unrelated specialist',ceo.id,'worker'),actor=actorFor(worker);
  const clock=vi.spyOn(Date.prototype,'toISOString').mockReturnValue('2030-01-01T00:00:00.000Z');
  const mirror=store.vault.write({scope:'employees',scopeId:worker.id,title:'Old generated profile',content:'OLD_PROFILE '.repeat(500),generated:true});
  const old=store.command(owner,{type:'knowledge.write',scope:'company',title:'Older source context',content:'OLD_CONTEXT '.repeat(500),source:'run:older-evidence'});
  clock.mockReturnValue('2030-01-02T00:00:00.000Z');
  const earlier=store.command(owner,{type:'knowledge.write',scope:'employees',scopeId:worker.id,title:'Earlier observed correction',content:'EARLIER_CORRECTION: read the retained verifier receipt.',source:'run:earlier-evidence'});
  clock.mockReturnValue('2030-01-03T00:00:00.000Z');
  const latest=store.command(owner,{type:'knowledge.write',scope:'employees',scopeId:worker.id,title:'Latest observed correction',content:'LATEST_CORRECTION: employee instructions now persist after native compaction.',source:'run:latest-evidence'});
  clock.mockReturnValue('2030-01-04T00:00:00.000Z');
  const privateNote=store.command(owner,{type:'knowledge.write',scope:'employees',scopeId:other.id,title:'Private unrelated record',content:'PRIVATE_UNRELATED_NOTE',source:'run:private-evidence'});
  const legacy=store.command(owner,{type:'knowledge.write',scope:'company',title:'Legacy structured provenance',content:'LEGACY_CONTEXT',source:{runId:'older-structured-source'}});
  // A recently refreshed mirror must still follow source-linked correction notes.
  store.update('knowledge',mirror.id,{title:'Refreshed generated profile'});
  const context=broker.knowledgeContext(actor,[worker.id,other.id]);
  expect(context.slice(0,3).map(note=>note.id)).toEqual([latest.id,earlier.id,old.id]);
  expect(context[0].content).toBe(store.readKnowledge(latest.id).content);expect(context[0].truncated).toBe(false);
  expect(context.reduce((sum,note)=>sum+note.content.length,0)).toBe(4500);expect(context.at(-1)?.nextOffset).not.toBeNull();
  expect(context.some(note=>note.id===mirror.id||note.id===privateNote.id)).toBe(false);expect(JSON.stringify(context)).not.toContain('PRIVATE_UNRELATED_NOTE');
  expect(context.some(note=>note.id===legacy.id)).toBe(false);
  expect(store.readKnowledge(mirror.id).content.length).toBeGreaterThan(4500);
 });
 it('keeps a fresh public correction while excluding a newer peer initial judgment from prioritized knowledge',()=>{
  const elders=store.list('employees').filter(e=>store.level(e.id)==='elder'),peer=actorFor(elders[0]),reader=actorFor(elders[1]);
  const decision=store.command(owner,{type:'decision.create',kind:'executive.review',subject:'Independent review',rationale:'Judge current evidence',payload:{employeeId:ceo.id}});
  store.update('assignments',store.need('runs',peer.runId).assignmentId,{kind:'governance',payload:{decisionId:decision.id}});
  const clock=vi.spyOn(Date.prototype,'toISOString').mockReturnValue('2030-02-01T00:00:00.000Z');
  store.vault.write({scope:'company',title:'Oversized operational mirror',content:'OLD_COMPANY_PROFILE '.repeat(500),generated:true});
  clock.mockReturnValue('2030-02-02T00:00:00.000Z');
  const correction=store.command(owner,{type:'knowledge.write',scope:'company',title:'Installed runtime correction',content:'PUBLIC_CORRECTION: inspect the actual preserved run evidence.',source:'acceptance/runtime-repair.json'});
  clock.mockReturnValue('2030-02-03T00:00:00.000Z');
  store.command(peer,{type:'decision.vote',decisionId:decision.id,approve:false,rationale:'HIDDEN_INITIAL_JUDGMENT'});
  const hidden=store.command(peer,{type:'knowledge.write',scope:'company',title:'Initial judgment',content:'HIDDEN_INITIAL_JUDGMENT',source:`decision:${decision.id}`});
  const context=broker.knowledgeContext(reader,[elders[1].id],100);
  expect(context[0].id).toBe(correction.id);expect(context[0].content).toBe(store.readKnowledge(correction.id).content);
  expect(context.reduce((sum,note)=>sum+note.content.length,0)).toBe(100);expect(JSON.stringify(context)).not.toContain('HIDDEN_INITIAL_JUDGMENT');
  expect(context.some(note=>note.id===hidden.id)).toBe(false);
  store.command(reader,{type:'decision.vote',decisionId:decision.id,approve:true,rationale:'My independently recorded assessment'});
  expect(broker.knowledgeContext(reader,[elders[1].id],100)[0].id).toBe(hidden.id);
 });
 it('provides actual learning, role versions and narrative bodies to responsible management while denying another team',async()=>{
  const manager=hire('Responsible manager'),other=hire('Other manager'),worker=hire('Specialist',manager.id,'worker'),workerActor=actorFor(worker),managerActor=actorFor(manager),otherActor=actorFor(other);
  const experience=store.command(workerActor,{type:'experience.record',summary:'Canonical verifier failed',source:'run:actual-failed-check',learned:'Use the pinned Ruby environment before retrying'});
  const note=store.command(workerActor,{type:'knowledge.write',scope:'employees',scopeId:worker.id,title:'Ruby setup finding',content:'# Actual finding\nUse pinned Ruby.\n',source:experience.id});
  const role=store.list('roleVersions').find(r=>r.employeeId===worker.id)!;
  expect((await broker.call(managerActor,'company_detail',{collection:'experiences',id:experience.id})).content).toContain('pinned Ruby environment');
  expect((await broker.call(managerActor,'company_detail',{collection:'roleVersions',id:role.id})).content).toContain('Concrete product responsibility');
  expect((await broker.call(managerActor,'company_detail',{collection:'knowledge',id:note.id})).content).toBe('# Actual finding\nUse pinned Ruby.\n');
  const search=await broker.call(managerActor,'knowledge_search',{query:'Ruby'});expect(search.items.some((r:any)=>r.id===note.id)).toBe(true);
  await expect(broker.call(otherActor,'company_detail',{collection:'knowledge',id:note.id})).rejects.toThrow(/authorized scope/);
  expect((await broker.call(otherActor,'knowledge_search',{query:'Ruby'})).items).toEqual([]);
  const runs=await broker.call(managerActor,'company_read',{collection:'runs'});expect(runs.items.some((r:any)=>r.id===workerActor.runId)).toBe(true);expect(JSON.stringify(runs)).not.toContain('PRIVATE_TOKEN_HASH');
  const detail=await broker.call(managerActor,'company_detail',{collection:'runs',id:workerActor.runId});expect(detail.content).not.toContain('PRIVATE_TOKEN_HASH');
 });
 it('does not expose initial Elder judgments through run text, roles, messages, experience or notes',async()=>{
  const elders=store.list('employees').filter(e=>store.level(e.id)==='elder'),peer=actorFor(elders[0]),reader=actorFor(elders[1]);
  const decision=store.command(owner,{type:'decision.create',kind:'executive.review',subject:'Actual leadership outcome',rationale:'Assess evidence',payload:{employeeId:ceo.id}});
  const peerRun=store.need('runs',peer.runId);store.update('assignments',peerRun.assignmentId,{kind:'governance',payload:{decisionId:decision.id}});
  store.command(peer,{type:'decision.vote',decisionId:decision.id,approve:false,rationale:'HIDDEN_INITIAL_JUDGMENT'});store.update('runs',peerRun.id,{text:'HIDDEN_INITIAL_JUDGMENT'});store.update('employees',elders[0].id,{role:'HIDDEN_INITIAL_JUDGMENT'});
  store.put('roleVersions',{employeeId:elders[0].id,version:2,content:'HIDDEN_INITIAL_JUDGMENT',source:'Initial review'});
  store.command(peer,{type:'experience.record',summary:'HIDDEN_INITIAL_JUDGMENT',source:'Independent review',learned:'HIDDEN_INITIAL_JUDGMENT'});
  store.command(peer,{type:'message.send',recipientId:ceo.id,content:'HIDDEN_INITIAL_JUDGMENT'});
  store.command(peer,{type:'knowledge.write',scope:'company',title:'Review judgment',content:'HIDDEN_INITIAL_JUDGMENT',source:'Independent review'});
  for(const collection of ['runs','experiences','roleVersions','employees','messages','knowledge','decisions'])expect(JSON.stringify(await broker.call(reader,'company_read',{collection,limit:30}))).not.toContain('HIDDEN_INITIAL_JUDGMENT');
  expect(JSON.stringify(broker.knowledgeContext(reader,[elders[0].id]))).not.toContain('HIDDEN_INITIAL_JUDGMENT');
  await expect(broker.call(reader,'company_detail',{collection:'runs',id:peerRun.id})).rejects.toThrow(/authorized scope/);
  store.command(reader,{type:'decision.vote',decisionId:decision.id,approve:true,rationale:'My independent judgment'});
  expect((await broker.call(reader,'company_detail',{collection:'runs',id:peerRun.id})).content).toContain('HIDDEN_INITIAL_JUDGMENT');
 });
 it('requires the assigned initial vote before mutations and hides subsequent peer proposals in scheduler snapshots',async()=>{
  const elders=store.list('employees').filter(e=>store.level(e.id)==='elder'),peer=actorFor(elders[0]),reader=actorFor(elders[1]);
  const decision=store.command(owner,{type:'decision.create',kind:'executive.review',subject:'Independent governance',rationale:'Judge actual delivery',payload:{employeeId:ceo.id}});
  for(const actor of [peer,reader])store.update('assignments',store.need('runs',actor.runId).assignmentId,{kind:'governance',payload:{decisionId:decision.id}});
  const proposal={type:'decision.create',kind:'strategy',subject:'PEER_FOLLOWUP_JUDGMENT',rationale:'PEER_FOLLOWUP_JUDGMENT',payload:{outcome:'Actual follow-up work'},runId:'forged-origin'};
  await expect(broker.call(peer,'company_command',{command:proposal})).rejects.toThrow(/independent initial/);
  await expect(broker.call(peer,'company_command',{command:{type:'role.update',employeeId:peer.employeeId,content:'My judgment',source:'initial',rationale:'premature'}})).rejects.toThrow(/independent initial/);
  await expect(broker.call(peer,'company_command',{command:{type:'decision.vote',decisionId:'other-decision',approve:true,rationale:'Wrong assignment'}})).rejects.toThrow(/independent initial/);
  await broker.call(peer,'company_command',{command:{type:'decision.vote',decisionId:decision.id,approve:true,rationale:'My own initial judgment'}});
  const followup=await broker.call(peer,'company_command',{command:proposal});expect(followup.runId).toBe(peer.runId);expect(store.snapshot().decisions.some(d=>d.id===followup.id)).toBe(true);
  expect(store.snapshot(reader).decisions.some(d=>d.id===followup.id)).toBe(false);expect(JSON.stringify(await broker.call(reader,'company_read',{collection:'decisions'}))).not.toContain('PEER_FOLLOWUP_JUDGMENT');
  await expect(broker.call(reader,'company_detail',{collection:'decisions',id:followup.id})).rejects.toThrow(/authorized scope/);
  store.update('decisions',followup.id,{runId:undefined});expect(store.snapshot(reader).decisions.some(d=>d.id===followup.id)).toBe(false); // Legacy run command audit still closes the leak.
  await broker.call(reader,'company_command',{command:{type:'decision.vote',decisionId:decision.id,approve:false,rationale:'My independently formed dissent'}});
  expect(store.snapshot(reader).decisions.some(d=>d.id===followup.id)).toBe(true);expect((await broker.call(reader,'company_detail',{collection:'decisions',id:followup.id})).content).toContain('PEER_FOLLOWUP_JUDGMENT');
 });
 it('keeps dependency diagnoses, mixed recovery chains and descendant decisions blind to each unvoted Elder',async()=>{
  const elders=store.list('employees').filter(employee=>store.level(employee.id)==='elder'),[peer,reader,third]=elders.map(employee=>actorFor(employee));
  const decision=store.command(owner,{type:'decision.create',kind:'executive.review',subject:'Independent leadership assessment',rationale:'Judge actual evidence',payload:{employeeId:ceo.id}});
  for(const elder of [peer,reader,third])store.update('assignments',store.need('runs',elder.runId).assignmentId,{kind:'governance',payload:{decisionId:decision.id}});
  const originalId=store.need('runs',peer.runId).assignmentId,secret='PRIVATE_DEPENDENCY_JUDGMENT';
  // Persist descendants before their parents to require closure, not insertion-order propagation.
  const last=actorFor(elders[0]),middle=actorFor(elders[0]),first=actorFor(elders[0]);
  const firstId=store.need('runs',first.runId).assignmentId,middleId=store.need('runs',middle.runId).assignmentId,lastId=store.need('runs',last.runId).assignmentId;
  store.update('assignments',firstId,{schedulerKey:`dependency-wait:${originalId}:fixture`,title:`${secret} dependency diagnosis`,payload:{blockedAssignmentId:originalId}});
  store.update('assignments',middleId,{schedulerKey:'fault:fixture-failure',title:`${secret} fault descendant`,payload:{failedAssignmentId:firstId}});
  store.update('assignments',lastId,{schedulerKey:`dependency-wait:${middleId}:fixture`,title:`${secret} dependency descendant`,payload:{blockedAssignmentId:middleId}});
  for(const origin of [first,middle,last])store.update('runs',origin.runId,{text:secret});
  const vote=await broker.call(peer,'vote_decision',{decisionId:decision.id,approve:false,rationale:'My retained independent dissent'});
  const childDecision=await broker.call(last,'company_command',{command:{type:'decision.create',kind:'executive.review',subject:`${secret} follow-up`,rationale:secret,payload:{employeeId:ceo.id}}});
  await broker.call(last,'company_command',{command:{type:'message.send',recipientId:ceo.id,content:secret}});
  const child=actorFor(elders[0]),childId=store.need('runs',child.runId).assignmentId;
  store.update('assignments',childId,{kind:'governance',title:`${secret} child judgment`,payload:{decisionId:childDecision.id}});
  await broker.call(child,'vote_decision',{decisionId:childDecision.id,approve:true,rationale:secret});
  const descendant=await broker.call(child,'company_command',{command:{type:'decision.create',kind:'strategy',subject:`${secret} descendant decision`,rationale:secret,payload:{}}});
  const retainedVote=store.need('votes',vote.id);
  for(const unvoted of [reader,third]){
   expect(store.snapshot(unvoted).decisions.some(item=>[childDecision.id,descendant.id].includes(item.id))).toBe(false);
   for(const collection of ['assignments','runs','decisions','messages'])expect(JSON.stringify(await broker.call(unvoted,'company_read',{collection,limit:30}))).not.toContain(secret);
   expect(JSON.stringify(broker.promptContext(unvoted))).not.toContain(secret);
   for(const id of [firstId,middleId,lastId,childId])await expect(broker.call(unvoted,'company_detail',{collection:'assignments',id})).rejects.toThrow(/authorized scope/);
   for(const id of [first.runId,middle.runId,last.runId,child.runId])await expect(broker.call(unvoted,'company_detail',{collection:'runs',id})).rejects.toThrow(/authorized scope/);
   await expect(broker.call(unvoted,'company_detail',{collection:'decisions',id:descendant.id})).rejects.toThrow(/authorized scope/);
  }
  await broker.call(reader,'vote_decision',{decisionId:decision.id,approve:true,rationale:'Reader independently evaluates original evidence'});
  expect((await broker.call(reader,'company_detail',{collection:'assignments',id:lastId})).content).toContain(secret);expect(store.snapshot(reader).decisions.some(item=>item.id===childDecision.id)).toBe(true);
  expect(store.snapshot(reader).decisions.some(item=>item.id===descendant.id)).toBe(false);expect(JSON.stringify(await broker.call(third,'company_read',{collection:'assignments',limit:30}))).not.toContain(secret);
  const readerChild=actorFor(elders[1]);store.update('assignments',store.need('runs',readerChild.runId).assignmentId,{kind:'governance',payload:{decisionId:childDecision.id}});
  await broker.call(readerChild,'vote_decision',{decisionId:childDecision.id,approve:false,rationale:'Reader independently evaluates the child decision'});
  expect((await broker.call(readerChild,'company_detail',{collection:'decisions',id:descendant.id})).content).toContain(secret);expect(store.need('votes',vote.id)).toEqual(retainedVote);
 });
 it('bounds large repository evidence with explicit pages and retains complete stored sources',async()=>{
  const actor=actorFor(ceo),product=store.list('products')[2],body='Observation '.repeat(7000);
  const binding={repository:'fixture/product',url:'https://github.com/fixture/product',defaultBranch:'main',public:true,baseCommit:'base',originalHead:'head',localStatus:'',refreshedAt:new Date().toISOString(),issues:Array.from({length:40},(_,i)=>({number:i+1,title:'Source-backed product issue',body,url:`https://github.com/fixture/product/issues/${i+1}`})),pulls:[],files:Object.fromEntries(Array.from({length:10},(_,i)=>[`doc-${i}.md`,body]))};
  vi.spyOn(broker.workspaces,'inspect').mockImplementation(async()=>{store.update('products',product.id,{binding});return binding as any;});
  const result=await broker.call(actor,'repo_inspect',{productId:product.id});expect(JSON.stringify(result).length).toBeLessThanOrEqual(6000);expect(result.issues.items[0].body.truncated).toBe(true);expect(result.issues.total).toBe(40);
  expect((await broker.call(actor,'repo_issue',{productId:product.id,number:1,offset:8000})).content).toBe(body.slice(8000,16000));
  vi.spyOn(broker.workspaces,'readProduct').mockResolvedValue(body);
  const page=await broker.call(actor,'repo_read',{productId:product.id,path:'README.md'});expect(page.content).toHaveLength(6000);expect(page.nextOffset).toBe(6000);expect(page.totalCharacters).toBe(body.length);
  expect((await broker.call(actor,'repo_read',{productId:product.id,path:'README.md',offset:6000,limit:50000})).content).toBe(body.slice(6000,18000));
 });
 it('labels remote-source character pages and gives an exact larger next call without changing requested content',async()=>{
  const actor=actorFor(ceo),product=store.list('products')[0],workspace=join(root,'remote-source-fixture'),mirror=join(root,'repositories','source-fixture.git');mkdirSync(join(workspace,'docs'),{recursive:true});mkdirSync(join(root,'repositories'),{recursive:true});execFileSync('/usr/bin/git',['init','--bare',mirror],{stdio:'pipe'});
  const git=(args:string[])=>execFileSync('/usr/bin/git',['--git-dir',mirror,'--work-tree',workspace,'-c','user.name=Fixture','-c','user.email=fixture@localhost','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null',...args],{cwd:workspace,env:{PATH:'/usr/bin:/bin',HOME:root,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'},encoding:'utf8'}).trim();
  const content='  # Retained source\n'+'Actual baseline line with preserved spaces.  \n'.repeat(400);writeFileSync(join(workspace,'docs/STATUS.md'),content);git(['add','docs/STATUS.md']);git(['commit','-m','Fixture remote baseline']);store.update('products',product.id,{binding:{mirror,baseCommit:git(['rev-parse','HEAD'])}});writeFileSync(join(workspace,'docs/STATUS.md'),'Different uncommitted workspace content');
  const page=await broker.call(actor,'repo_read',{productId:product.id,path:'docs/STATUS.md',offset:1,limit:100});expect(page).toMatchObject({units:'characters',offset:1,content:content.slice(1,101),totalCharacters:content.length,nextOffset:101,nextCall:{tool:'repo_read',arguments:{productId:product.id,path:'docs/STATUS.md',offset:101,limit:6000}}});expect(page.paginationGuidance).toContain('100 characters');
  const next=await broker.call(actor,page.nextCall.tool,page.nextCall.arguments);expect(next.content).toBe(content.slice(101,6101));expect(next.offset).toBe(101);expect(next.nextCall).toBeUndefined();
  const last=await broker.call(actor,'repo_read',{productId:product.id,path:'docs/STATUS.md',offset:content.length-20,limit:100});expect(last.content).toBe(content.slice(-20));expect(last.nextOffset).toBeNull();expect(last.nextCall).toBeUndefined();
  const normal=await broker.call(actor,'repo_read',{productId:product.id,path:'docs/STATUS.md'});expect(normal.content).toBe(content.slice(0,6000));expect(normal.nextCall).toBeUndefined();expect((await broker.call(actor,'repo_read',{productId:product.id,path:'docs/STATUS.md',limit:50000})).content).toBe(content.slice(0,12000));
  const schema=brokerTools.find(tool=>tool.name==='repo_read')!.inputSchema;expect(schema.properties.offset.description).toContain('Zero-based character offset');expect(schema.properties.limit.description).toContain('6000 for normal reading');expect(corporateGuide).toContain('Existing assignment acceptance stays intact');
 });
 it('keeps a grown company and large nested records inside the model budget without losing paging access',async()=>{
  const actor=actorFor(ceo),long='source-linked observation '.repeat(1000);
  for(let i=0;i<60;i++)store.put('decisions',{authorId:ceo.id,subject:`Decision ${i}`,rationale:long,kind:'strategy',status:'recorded',policyRevision:store.policy.revision,payload:{evidence:long,checks:Array(20).fill(long)},result:{explanation:long}});
  const summary=await broker.call(actor,'company_read',{collection:'summary',limit:30});expect(JSON.stringify(summary).length).toBeLessThanOrEqual(12000);expect(summary.decisions.total).toBe(60);expect(summary.decisions.items.length).toBeLessThanOrEqual(3);expect(summary.decisions.offset).toBe(57);
  const collection=await broker.call(actor,'company_read',{collection:'decisions',limit:30});expect(JSON.stringify(collection).length).toBeLessThanOrEqual(12000);expect(collection.items.length).toBeGreaterThan(0);expect(collection.items.length).toBeLessThan(30);expect(collection.nextOffset).toBe(collection.items.length);expect(collection.items[0].payload.truncated).toBe(true);
  const next=await broker.call(actor,'company_read',{collection:'decisions',limit:30,offset:collection.nextOffset});expect(next.items[0].id).not.toBe(collection.items[0].id);expect(JSON.stringify(next).length).toBeLessThanOrEqual(12000);
  const detail=await broker.call(actor,'company_detail',{collection:'decisions',id:collection.items[0].id,offset:8000});expect(detail.offset).toBe(8000);expect(detail.content).toHaveLength(8000);expect(detail.totalCharacters).toBeGreaterThan(16000);
  const run=store.need('runs',actor.runId);store.update('assignments',run.assignmentId,{instructions:long,payload:{decisionId:collection.items[0].id}});const context=broker.promptContext(actor);expect(JSON.stringify(context).length).toBeLessThanOrEqual(12000);expect(context.assignment.id).toBe(run.assignmentId);expect(context.assignment.instructions.truncated).toBe(true);expect(context.assignedDecision.id).toBe(collection.items[0].id);expect(JSON.parse(JSON.stringify(context)).assignment.payload.decisionId).toBe(collection.items[0].id);
 });
});

describe('bounded corporate mutation receipts',()=>{
 it('exposes completion prerequisites and lets only supervising management persist an exact dependency correction',async()=>{
  const manager=hire('Dependency supervisor'),worker=hire('Subset worker',manager.id,'worker'),actor=actorFor(manager);
  const base={employeeId:worker.id,supervisorId:manager.id,title:'Retained broad assignment',instructions:'Preserve actual outcomes',acceptance:['Actual independent evidence'],kind:'implementation'};
  const original=store.command(owner,{type:'assignment.create',...base});store.update('assignments',original.id,{status:'blocked',blockedReason:'The original awaits actual subset outcomes'});
  const subset=store.command(owner,{type:'assignment.create',...base,title:'Actionable subset',dependencies:[original.id],payload:{sourceAssignmentId:original.id}});
  const page=await broker.call(actor,'company_read',{collection:'assignments'});expect(page.items.find((item:any)=>item.id===subset.id).dependencies).toEqual([original.id]);expect(page.items.find((item:any)=>item.id===original.id).blockedReason).toBe('The original awaits actual subset outcomes');
  const before=store.need('runs',actor.runId).corporateCommands??[];
  await expect(broker.call(actor,'company_command',{command:{type:'assignment.update',assignmentId:subset.id,dependencies:[]}})).rejects.toThrow(/Dependency rationale/);expect(store.need('assignments',subset.id)).toEqual(subset);expect(store.need('runs',actor.runId).corporateCommands??[]).toEqual(before);
  const receipt=await broker.call(actor,'company_command',{command:{type:'assignment.update',assignmentId:subset.id,dependencies:[],rationale:'Source provenance does not require the original to complete first'}});
  const detail=JSON.parse((await broker.call(actor,'company_detail',receipt._receipt.fullRecord)).content);expect(detail.dependencies).toEqual([]);expect(detail.acceptance).toEqual(subset.acceptance);expect(detail.payload).toEqual(subset.payload);expect(detail.dependencyDecisions[0]).toMatchObject({actorId:manager.id,runId:actor.runId,priorDependencies:[original.id],dependencies:[]});
  const command=brokerTools.find(tool=>tool.name==='company_command')!.inputSchema.properties.command.anyOf.find((branch:any)=>branch.properties.type.enum[0]==='assignment.update');
  expect(command.properties.dependencies).toMatchObject({type:'array',items:{type:'string'}});expect(Object.keys(command.properties).indexOf('dependencies')).toBeLessThan(Object.keys(command.properties).indexOf('rationale'));
  expect(corporateGuide).toContain('payload.sourceAssignmentId for provenance');expect(corporateGuide).toContain('assignment.update {assignmentId,dependencies:[actual prerequisite IDs],rationale}');
 });
 it('exposes every existing generic command field and nested evidence fields through the provider-compatible object schema',()=>{
  const schema=brokerTools.find(tool=>tool.name==='company_command')!.inputSchema.properties.command;
  expect(schema.properties).toBeUndefined();expect(schema.anyOf.map((branch:any)=>branch.properties.type.enum[0])).toEqual(Object.keys(commandFields));expect(schema.anyOf).toHaveLength(20);
  for(const [type,entry] of Object.entries(commandFields)){
   const branch=schema.anyOf.find((item:any)=>item.properties.type.enum[0]===type);
   expect(branch.type).toBe('object');expect(branch.properties.type.enum).toEqual([type]);expect(branch.required).toEqual(['type',...entry.required]);
   expect(Object.keys(branch.properties)).toEqual(['type',...entry.required,...entry.optional]);
  }
  const model=schema.anyOf.find((item:any)=>item.properties.type.enum[0]==='employee.model').properties;
  expect(model.employeeId.type).toBe('string');expect(model.modelId.type).toBe('string');expect(model.rationale.type).toBe('string');
  const payload=schema.anyOf.find((item:any)=>item.properties.type.enum[0]==='decision.create').properties.payload;
  expect(payload.additionalProperties).toBe(true);
  expect(Object.keys(payload.properties)).toEqual(['positionId','employeeId','name','modelId','role','acting','source','rejectedDecisionId','reviewedVoteIds','failedRunId','failedAssignmentId','disposition','remainingPrerequisite']);
  const evidence=schema.anyOf.find((item:any)=>item.properties.type.enum[0]==='project.update').properties.completionEvidence;
  expect(evidence.items.properties.sources.items.properties).toHaveProperty('id');expect(evidence.items.required).toContain('criterion');
  expect(JSON.stringify(schema)).not.toMatch(/"(?:oneOf|const)":/);expect(corporateGuide).toContain('"type":"employee.model","employeeId"');
 });
 it('retains named goal and assignment metadata in the pinned provider wire shape without depending on additionalProperties',()=>{
  // Ollama 0.32.13 ToolProperty drops unsupported keywords before rendering tools.
  function wire(schema:any):any{return Object.fromEntries(Object.entries(schema).flatMap(([key,value]):[string,any][]=>{
   if(['type','description','enum','required'].includes(key))return [[key,value]];
   if(key==='properties')return [[key,Object.fromEntries(Object.entries(value as object).map(([name,property])=>[name,wire(property)]))]];
   if(key==='items')return [[key,wire(value)]];if(key==='anyOf')return [[key,(value as any[]).map(wire)]];return [];
  }));}
  const generic=wire(brokerTools.find(tool=>tool.name==='company_command')!.inputSchema).properties.command;
  expect(generic.properties).toBeUndefined();
  const model=generic.anyOf.find((branch:any)=>branch.properties.type.enum[0]==='employee.model'),decision=generic.anyOf.find((branch:any)=>branch.properties.type.enum[0]==='decision.create');
  expect(Object.keys(model.properties)).toEqual(['type','employeeId','modelId','rationale']);expect(model.required).toEqual(['type','employeeId','modelId','rationale']);
  expect(Object.keys(decision.properties)).toEqual(['type','kind','subject','rationale','payload']);expect(decision.required).toEqual(['type','kind','subject','rationale']);
  expect(decision.properties.payload.properties).toMatchObject({positionId:{type:'string'},employeeId:{type:'string'},name:{type:'string'},modelId:{type:'string'}});
  for(const assignmentField of ['artifactId','decisionId','sourceAssignmentId'])expect(decision.properties.payload.properties).not.toHaveProperty(assignmentField);
  for(const strategyField of ['failedRunId','failedAssignmentId','disposition','remainingPrerequisite'])expect(decision.properties.payload.properties[strategyField].type).toBe('string');
  for(const unrelated of ['content','path','environment'])expect(decision.properties).not.toHaveProperty(unrelated);
  const goals=generic.anyOf.find((branch:any)=>branch.properties.type.enum[0]==='product.goal').properties;
  expect(goals.goals.items.anyOf[0]).toEqual({type:'string'});expect(goals.goals.items.anyOf[1]).toMatchObject({type:'object',properties:{outcome:{type:'string'},measure:{type:'string'}}});
  expect(goals.goals.items.anyOf[1].required).toBeUndefined();expect(goals.roadmap.items).toEqual({type:'string'});
  const typed=wire(brokerTools.find(tool=>tool.name==='create_assignment')!.inputSchema).properties.payload;
  expect(typed).toEqual(generic.anyOf.find((branch:any)=>branch.properties.type.enum[0]==='assignment.create').properties.payload);expect(typed.additionalProperties).toBeUndefined();
  expect(Object.keys(typed.properties)).toEqual(['artifactId','decisionId','sourceAssignmentId','pullRequest']);
  expect(typed.properties.pullRequest).toMatchObject({type:'object',required:['number','headSha'],properties:{number:{type:'integer'},headSha:{type:'string'}}});
  for(const key of ['artifactId','sourceAssignmentId','decisionId'])expect(typed.properties[key].type).toBe('string');
  const browser=wire(brokerTools.find(tool=>tool.name==='browser')!.inputSchema).properties.arguments.properties;
  expect(browser.url.type).toBe('string');expect(browser.target.type).toBe('string');expect(browser.ref.type).toBe('string');expect(browser.key.enum).toContain('Tab');expect(browser.action.enum).toEqual(['list','new','close','select']);
  for(const denied of ['filename','modifiers','scale','script'])expect(browser).not.toHaveProperty(denied);
 });
 it('names missing employee.model fields before any state lookup, then preserves model authority and value validation',async()=>{
  const manager=hire('Responsible model manager'),worker=hire('Local implementation employee',manager.id,'worker'),actor=actorFor(manager),before=store.need('employees',worker.id);
  for(const command of [{type:'employee.model'},{type:'employee.model',payload:{employeeId:worker.id,modelId:model,rationale:'Nested incorrectly'}}])await expect(broker.call(actor,'company_command',{command})).rejects.toMatchObject({code:'missing_command_fields',message:expect.stringMatching(/employee.model.*employeeId, modelId, rationale.*beside type.*company_help/)});
  expect(store.need('employees',worker.id)).toEqual(before);expect(store.need('runs',actor.runId).corporateCommands??[]).toEqual([]);
  await expect(broker.call(actor,'company_command',{command:{type:'employee.model',employeeId:worker.id,modelId:'cloud-provider',rationale:'Invalid hosted value'}})).rejects.toThrow(/local|hosted/i);expect(store.need('employees',worker.id)).toEqual(before);
  const other=actorFor(hire('Unrelated model manager'));await expect(broker.call(other,'company_command',{command:{type:'employee.model',employeeId:worker.id,modelId:model,rationale:'Not my employee'}})).rejects.toThrow(/home management/);
  store.put('models',{name:'qwen3.5:4b',local:true,available:true,artifactIdentity:'fixture-small'});
  await broker.call(actor,'company_command',{command:{type:'employee.model',employeeId:worker.id,modelId:'qwen3.5:4b',rationale:'Observed bounded task fit'}});
  expect(store.need('employees',worker.id).modelId).toBe('qwen3.5:4b');expect(store.need('runs',actor.runId).corporateCommands).toHaveLength(1);
 });
 it('preserves explicit nested executive and generic assignment payload extensions while rejecting missing direct fields',async()=>{
  const actor=actorFor(ceo),position=await broker.call(actor,'company_command',{command:{type:'position.create',title:'Scoped product executive',level:'executive',responsibilities:'Own a measured product outcome'}});
  const before=store.list('decisions'),receipts=store.need('runs',actor.runId).corporateCommands;
  await expect(broker.call(actor,'company_command',{command:{type:'decision.create',kind:'executive.appoint',payload:{positionId:position.id,name:'Candidate',modelId:model}}})).rejects.toThrow(/subject, rationale/);
  await expect(broker.call(actor,'company_command',{command:{type:'decision.create',kind:'strategy',subject:'Observed failed attempt',content:'This is not the decision rationale field',path:'diagnosis.md',environment:'local'}})).rejects.toMatchObject({code:'missing_command_fields',message:expect.stringMatching(/decision.create.*rationale.*beside type/)});
  expect(store.list('decisions')).toEqual(before);expect(store.need('runs',actor.runId).corporateCommands).toEqual(receipts);
  const payload={positionId:position.id,name:'Candidate',modelId:model,role:'Own actual product work',observedEvidence:{source:'run:actual-assessment'}};
  const decision=await broker.call(actor,'company_command',{command:{type:'decision.create',kind:'executive.appoint',subject:'Appoint an accountable executive',rationale:'Observed responsibility gap',payload}});
  expect(store.need('decisions',decision.id).payload).toEqual(payload);expect(store.need('decisions',decision.id).status).toBe('pending');
  const assignment=await broker.call(actor,'company_command',{command:{type:'assignment.create',employeeId:ceo.id,title:'Read a retained management record',instructions:'Inspect and report actual evidence',acceptance:['Source-linked finding'],kind:'management',payload:{observedEvidence:{decisionId:decision.id}}}});
  expect(store.need('assignments',assignment.id).payload).toEqual({observedEvidence:{decisionId:decision.id}});
  const assignments=store.list('assignments'),commands=store.need('runs',actor.runId).corporateCommands;
  await expect(broker.call(actor,'company_command',{command:{type:'assignment.create',employeeId:ceo.id,title:'Missing instructions'}})).rejects.toThrow(/instructions, acceptance/);
  expect(store.list('assignments')).toEqual(assignments);expect(store.need('runs',actor.runId).corporateCommands).toEqual(commands);
 });
 it('retains exact strategy failure links and arbitrary metadata despite narrower advertised payloads',async()=>{
  const actor=actorFor(ceo),payload={failedRunId:'observed-failed-run',failedAssignmentId:'preserved-original',disposition:'blocked',remainingPrerequisite:'Actual independent completion evidence is still required',sourceAssignmentId:'retained-extra-trace',observedEvidence:{source:'actual-failure-log'}},command={type:'decision.create',kind:'strategy',subject:'Retain the exact failed-work diagnosis',rationale:'Observed prerequisites remain unmet',payload},unchanged=structuredClone(command);
  const receipt=await broker.call(actor,'company_command',{command});expect(command).toEqual(unchanged);expect(store.need('decisions',receipt.id).payload).toEqual(payload);
  const assignmentPayload={sourceAssignmentId:'preserved-original',observedEvidence:{decisionId:receipt.id}};
  for(const tool of ['company_command','create_assignment']){
   const input={employeeId:ceo.id,title:'Inspect retained evidence',instructions:'Read the actual source and record a scoped finding',acceptance:['Source-linked finding'],kind:'management',payload:assignmentPayload};
   const result=await broker.call(actor,tool,tool==='company_command'?{command:{type:'assignment.create',...input}}:input);expect(store.need('assignments',result.id).payload).toEqual(assignmentPayload);
  }
 });
 it('provides the derived identity effect in decision summaries, initial prompt state and full details without leaking peer votes',async()=>{
  const leader=actorFor(ceo),position=await broker.call(leader,'company_command',{command:{type:'position.create',title:'Delivery executive',level:'executive',responsibilities:'Own actual product delivery'}}),decision=await broker.call(leader,'company_command',{command:{type:'decision.create',kind:'executive.appoint',subject:'New delivery employee',rationale:'Distinct accountable staffing',payload:{positionId:position.id,name:ceo.name,modelId:model}}}),elders=store.list('employees').filter(e=>store.level(e.id)==='elder'),peer=actorFor(elders[0]),reader=actorFor(elders[1]);
  for(const actor of [peer,reader])store.update('assignments',store.need('runs',actor.runId).assignmentId,{kind:'governance',payload:{decisionId:decision.id}});
  await broker.call(peer,'company_command',{command:{type:'decision.vote',decisionId:decision.id,approve:true,rationale:'HIDDEN_PEER_RATIONALE'}});const raw=store.need('decisions',decision.id);
  const summaries=await broker.call(reader,'company_read',{collection:'decisions'}),effect=summaries.items.find((d:any)=>d.id===decision.id).appointmentEffect;expect(effect).toMatchObject({candidateKind:'new_employee',candidateEmployeeId:null,targetPositionId:position.id,derived:true});expect(effect.summary.content).toContain(ceo.id);expect(effect.summary.content).toContain('retains');expect(JSON.stringify(summaries)).not.toContain('HIDDEN_PEER_RATIONALE');
  expect(broker.promptContext(reader).assignedDecision.appointmentEffect.candidateKind).toBe('new_employee');const detail=JSON.parse((await broker.call(reader,'company_detail',{collection:'decisions',id:decision.id})).content);expect(detail.appointmentEffect.sameNameExistingEmployees[0]).toMatchObject({employeeId:ceo.id,positionId:ceo.positionId,identityAndPositionUnchanged:true});expect(store.need('decisions',decision.id)).toEqual(raw);expect(corporateGuide).toContain('names never resolve identity');
 });
 it('retains giant product evidence fully while returning bounded assessments and goals with explicit detail access',async()=>{
  const actor=actorFor(ceo),product=store.list('products')[2],body='RETAINED_REPOSITORY_SOURCE '.repeat(7000),narrative='Measured current repository finding. '.repeat(2000).trim();
  const binding={repository:'fixture/product',issues:[{number:1,body}],files:{'README.md':body}};store.update('products',product.id,{binding});
  const assessment=await broker.call(actor,'company_command',{command:{type:'product.assess',productId:product.id,assessment:narrative,rationale:narrative,priority:2}});
  const goals=[{outcome:narrative,measure:'Canonical verification and reviewed source'}],roadmap=[{title:'Observed next step',evidence:narrative}];
  const goal=await broker.call(actor,'company_command',{command:{type:'product.goal',productId:product.id,goals,roadmap,rationale:narrative}});
  for(const receipt of [assessment,goal]){expect(JSON.stringify(receipt).length).toBeLessThanOrEqual(6000);expect(receipt).toMatchObject({id:product.id,status:'active',priority:2,_receipt:{fullRecord:{collection:'products',id:product.id},omittedFields:['binding']}});expect(receipt.binding).toBeUndefined();expect(JSON.stringify(receipt)).not.toContain('RETAINED_REPOSITORY_SOURCE');expect(receipt.assessment).toMatchObject({truncated:true,totalCharacters:narrative.length});}
  expect(goal.goals).toMatchObject({format:'json',truncated:true});expect(goal.roadmap).toMatchObject({format:'json',truncated:true});
  const retained=store.need('products',product.id);expect(retained).toMatchObject({binding,assessment:narrative,goals,roadmap,rationale:narrative});
  const storedJson=JSON.stringify(retained,null,2),offset=storedJson.indexOf('RETAINED_REPOSITORY_SOURCE');const detail=await broker.call(actor,'company_detail',{...goal._receipt.fullRecord,offset});expect(detail.content).toBe(storedJson.slice(offset,offset+8000));expect(detail.content).toContain('RETAINED_REPOSITORY_SOURCE');
 });
 it('keeps returned position and decision IDs usable and vote booleans intact',async()=>{
  const actor=actorFor(ceo),position=await broker.call(actor,'company_command',{command:{type:'position.create',title:'Delivery executive',level:'executive',responsibilities:'Own the measured delivery outcome'}});
  expect(position.status).toBe('active');expect(position.level).toBe('executive');expect(position.responsibilities).toBe('Own the measured delivery outcome');
  const payload={positionId:position.id,name:'Delivery leader',modelId:model,role:'Own delivery and staffing'};
  const decision=await broker.call(actor,'company_command',{command:{type:'decision.create',kind:'executive.appoint',subject:'Appoint delivery leader',rationale:'An accountable executive is needed',payload}});
  expect(decision).toMatchObject({status:'pending',authorId:ceo.id,runId:actor.runId,payload,policyRevision:store.policy.revision});expect(decision.eligibleElders).toHaveLength(3);
  const detail=await broker.call(actor,'company_detail',decision._receipt.fullRecord);expect(JSON.parse(detail.content).payload.positionId).toBe(position.id);
  const elder=store.need('employees',decision.eligibleElders[0]),elderActor=actorFor(elder),vote=await broker.call(elderActor,'company_command',{command:{type:'decision.vote',decisionId:decision.id,approve:false,rationale:'My independent initial judgment requires narrower scope'}});
  expect(vote).toMatchObject({decisionId:decision.id,employeeId:elder.id,approve:false,phase:'initial',runId:elderActor.runId});expect(store.need('votes',vote.id).approve).toBe(false);
 });
 it('rejects missing or confused command types without guessing or persisting a decision',async()=>{
  const actor=actorFor(ceo),before=store.list('decisions').length;
  for(const command of [undefined,{kind:'executive.appoint',subject:'No type'},{type:'executive.appoint',subject:'Confused type'}])await expect(broker.call(actor,'company_command',{command})).rejects.toThrow(/requires command.type.*"type":"decision.create"/);
  expect(store.list('decisions')).toHaveLength(before);expect(store.need('runs',actor.runId).corporateCommands??[]).toEqual([]);
  const schema:any=brokerTools.find(tool=>tool.name==='company_command')!.inputSchema;for(const branch of schema.properties.command.anyOf)expect(branch.required).toContain('type');const types=schema.properties.command.anyOf.map((branch:any)=>branch.properties.type.enum[0]);expect(types).toContain('decision.create');expect(types).not.toContain('executive.appoint');
  expect(corporateGuide).toContain('"command":{"type":"position.create"');expect(corporateGuide).toContain('"command":{"type":"decision.create","kind":"executive.appoint"');expect(corporateGuide).toContain('"command":{"type":"decision.vote"');
 });
 it('rejects decision-style assignment envelopes with direct-field and acceptance guidance, then accepts the explicit flat command',async()=>{
  const manager=hire('Responsible supervisor'),worker=hire('Implementation employee',manager.id,'worker'),actor=actorFor(manager);
  const project=store.command(owner,{type:'project.create',name:'Bounded product work',productId:store.list('products')[0].id,outcome:'Actual source correction',acceptance:['Reviewed correction'],supervisorId:manager.id,rationale:'Concrete work'});
  const fields={employeeId:worker.id,projectId:project.id,title:'Finite correction',instructions:'Implement the assigned source correction and retain actual checks.',kind:'implementation'},before=store.list('assignments');
  const malformed={type:'assignment.create',payload:{...fields}},unchanged=structuredClone(malformed);
  await expect(broker.call(actor,'company_command',{command:malformed})).rejects.toMatchObject({code:'invalid_assignment_envelope',message:expect.stringMatching(/directly inside command beside type.*not inside command.payload.*acceptance.*nonempty array.*company_help assignment.create/)});
  expect(malformed).toEqual(unchanged);expect(store.list('assignments')).toEqual(before);expect(store.need('runs',actor.runId).corporateCommands??[]).toEqual([]);
  const acceptance=['Source correction committed and canonical verification retained'],created=await broker.call(actor,'company_command',{command:{type:'assignment.create',...fields,acceptance,payload:{sourceAssignmentId:'preserved-original'}}});
  expect(store.need('assignments',created.id)).toMatchObject({...fields,acceptance,supervisorId:manager.id,status:'queued',accepted:true,payload:{sourceAssignmentId:'preserved-original'}});
  expect(store.need('runs',actor.runId).corporateCommands).toEqual([expect.objectContaining({type:'assignment.create',id:created.id})]);
 });
 it('exposes retained vote details only after the reader records an independent initial judgment',async()=>{
  const elders=store.list('employees').filter(e=>store.level(e.id)==='elder'),peer=actorFor(elders[0]),reader=actorFor(elders[1]);
  const decision=store.command(owner,{type:'decision.create',kind:'executive.review',subject:'Evaluate actual leadership',rationale:'Independent evidence review',payload:{employeeId:ceo.id}});
  for(const actor of [peer,reader])store.update('assignments',store.need('runs',actor.runId).assignmentId,{kind:'governance',payload:{decisionId:decision.id}});
  const rationale='PEER_INDEPENDENT_DISSENT based on observed evidence. '.repeat(40).trim(),vote=await broker.call(peer,'company_command',{command:{type:'decision.vote',decisionId:decision.id,approve:false,rationale}});
  expect(vote._receipt.fullRecord).toEqual({collection:'votes',id:vote.id});expect(vote.rationale.truncated).toBe(true);
  expect(JSON.parse((await broker.call(peer,'company_detail',vote._receipt.fullRecord)).content)).toMatchObject({id:vote.id,decisionId:decision.id,approve:false,rationale});
  expect((await broker.call(reader,'company_read',{collection:'votes'})).items).toEqual([]);
  await expect(broker.call(reader,'company_detail',vote._receipt.fullRecord)).rejects.toThrow(/authorized scope/);
  await broker.call(reader,'company_command',{command:{type:'decision.vote',decisionId:decision.id,approve:true,rationale:'My separately formed initial judgment'}});
  const visible=await broker.call(reader,'company_read',{collection:'votes'});expect(visible.items.find((v:any)=>v.id===vote.id)).toMatchObject({decisionId:decision.id,approve:false,phase:'initial'});expect(JSON.stringify(visible).length).toBeLessThanOrEqual(12000);
  expect(JSON.parse((await broker.call(reader,'company_detail',vote._receipt.fullRecord)).content)).toMatchObject({id:vote.id,decisionId:decision.id,approve:false,rationale});
 });
 it('shows finalized vote evidence to the CEO while retaining initial blindness and denying an uninvolved worker',async()=>{
  const ceoActor=actorFor(ceo),workerActor=actorFor(hire('Uninvolved worker',ceo.id,'worker')),elders=store.list('employees').filter(e=>store.level(e.id)==='elder');
  const decision=store.command(ceoActor,{type:'decision.create',kind:'executive.review',subject:'Independent leadership review',rationale:'Evaluate actual outcomes',payload:{employeeId:ceo.id}}),votes:any[]=[];
  for(const elder of elders){
    const elderActor=actorFor(elder),vote=await broker.call(elderActor,'company_command',{command:{type:'decision.vote',decisionId:decision.id,approve:false,rationale:`Observed objection from ${elder.id}`}});votes.push(vote);
    if(votes.length<3){expect((await broker.call(ceoActor,'company_read',{collection:'votes'})).items).toEqual([]);await expect(broker.call(ceoActor,'company_detail',vote._receipt.fullRecord)).rejects.toThrow(/authorized scope/);}
  }
  expect(store.need('decisions',decision.id).status).toBe('rejected');const visible=await broker.call(ceoActor,'company_read',{collection:'votes'});expect(visible.items).toHaveLength(3);expect(visible.items.every((v:any)=>v.approve===false)).toBe(true);
  expect(JSON.parse((await broker.call(ceoActor,'company_detail',votes[0]._receipt.fullRecord)).content)).toMatchObject({id:votes[0].id,approve:false,rationale:`Observed objection from ${elders[0].id}`});
  expect((await broker.call(workerActor,'company_read',{collection:'votes'})).items).toEqual([]);await expect(broker.call(workerActor,'company_detail',votes[0]._receipt.fullRecord)).rejects.toThrow(/authorized scope/);
 });
});

describe('narrative checkpoint provenance',()=>{
 it.each(['company relative','company absolute','project relative','project absolute'])('records an owned %s path with only actual assignment custody',async scenario=>{
  const worker=hire('Narrative author',ceo.id,'worker'),project=scenario.startsWith('project')?store.command(owner,{type:'project.create',name:'Finite research',outcome:'Source-linked finding',acceptance:['Actual researched finding'],supervisorId:ceo.id,rationale:'Fixture'}):undefined;
  const workspace=join(root,'narrative-workspace');mkdirSync(workspace);if(project)project.workspace=workspace;
  const actor=actorFor(worker,project),run=store.update('runs',actor.runId,{workspace}),path=join(workspace,'finding.md'),content='# Actual newly authored finding\n';writeFileSync(path,content);
  const result=await broker.call(actor,'record_artifact',{path:scenario.endsWith('absolute')?path:'finding.md',summary:'Observed finding',projectId:'untrusted-project',assignmentId:'untrusted-assignment',employeeId:'untrusted-author',runId:'untrusted-run'});
  expect(store.need('artifacts',result.id)).toMatchObject({kind:'analysis',projectId:project?.id??null,assignmentId:run.assignmentId,employeeId:worker.id,runId:run.id,uri:realpathSync(path),identity:createHash('sha256').update(content).digest('hex'),checks:[{source:'file-observation',status:'observed',bytes:Buffer.byteLength(content)}]});
 });
 it.each(['absolute outside','relative traversal','relative symlink','absolute symlink'])('denies %s narrative paths without recording an artifact',async scenario=>{
  const actor=actorFor(ceo),workspace=join(root,'narrative-workspace'),outside=join(root,'outside.md');mkdirSync(workspace);writeFileSync(outside,'# Outside assigned workspace\n');symlinkSync(outside,join(workspace,'escape.md'));store.update('runs',actor.runId,{workspace});
  const assignment=store.need('assignments',store.need('runs',actor.runId).assignmentId),path=scenario==='absolute outside'?outside:scenario==='relative traversal'?'../outside.md':scenario==='relative symlink'?'escape.md':join(workspace,'escape.md');
  await expect(broker.call(actor,'record_artifact',{path,summary:'Forbidden file'})).rejects.toMatchObject({code:'path_denied'});
  expect(store.list('artifacts')).toEqual([]);expect(store.need('assignments',assignment.id)).toEqual(assignment);expect(store.need('runs',actor.runId).corporateCommands??[]).toEqual([]);
 });
 it('rejects unchanged tracked baseline and duplicate submissions but records newly authored findings',async()=>{
  const worker=hire('Research specialist',ceo.id,'worker');let project:Project=store.command(owner,{type:'project.create',name:'Evidence checkpoint',productId:store.list('products')[0].id,outcome:'Actual researched correction',acceptance:['Source-linked finding'],supervisorId:ceo.id,rationale:'Fixture'});
  const workspace=join(root,'workspaces',project.id),gitDir=join(root,'repositories','fixture.git');mkdirSync(workspace,{recursive:true});mkdirSync(join(root,'repositories'),{recursive:true});execFileSync('/usr/bin/git',['init','--bare',gitDir],{stdio:'pipe'});writeFileSync(join(workspace,'.git'),`gitdir: ${gitDir}\n`);
  const git=(args:string[])=>execFileSync('/usr/bin/git',['--git-dir',gitDir,'--work-tree',workspace,'-c','user.name=Fixture','-c','user.email=fixture@localhost','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null',...args],{cwd:workspace,env:{PATH:'/usr/bin:/bin',HOME:root,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'},encoding:'utf8'}).trim();
  const baseline='# Existing baseline\n\n';writeFileSync(join(workspace,'README.md'),baseline);git(['add','README.md']);git(['commit','-m','Baseline fixture']);project=store.update('projects',project.id,{workspace,gitDir,baseCommit:git(['rev-parse','HEAD'])});const actor=actorFor(worker,project);
  expect((await broker.call(actor,'company_read',{collection:'projects'})).items.find((item:any)=>item.id===project.id).productId).toBe(project.productId);
  expect(broker.promptContext(actor).projects.items.find((item:any)=>item.id===project.id).productId).toBe(project.productId);
  await expect(broker.call(actor,'record_artifact',{path:'README.md',summary:'Claim existing baseline'})).rejects.toThrow(/unchanged from the product baseline/);expect(store.list('artifacts')).toHaveLength(0);
  writeFileSync(join(workspace,'README.md'),`${baseline}Actual newly investigated finding.\n`);const artifact=await broker.call(actor,'record_artifact',{path:'README.md',summary:'Actual newly investigated finding'});
  expect(store.need('artifacts',artifact.id).baselineIdentity).toBe(createHash('sha256').update(baseline).digest('hex'));
  await expect(broker.call(actor,'record_artifact',{path:'README.md',summary:'Repeat same finding'})).rejects.toThrow(/already recorded/);
  writeFileSync(join(workspace,'findings.md'),'# Separate observed issue\nSource: current repository evidence.\n');const finding=await broker.call(actor,'record_artifact',{path:'findings.md',summary:'Separate observed issue'});expect(finding.kind).toBe('analysis');expect(store.list('artifacts')).toHaveLength(2);
 });
});

describe('typed independent vote tool',()=>{
 function governanceActor(index=0){
  const elder=store.list('employees').filter(e=>store.level(e.id)==='elder')[index],actor=actorFor(elder),decision=store.command(owner,{type:'decision.create',kind:'executive.review',subject:'Evidence-based executive review',rationale:'Inspect actual outcome',payload:{employeeId:ceo.id}});
  store.update('assignments',store.need('runs',actor.runId).assignmentId,{kind:'governance',status:'running',payload:{decisionId:decision.id}});
  return {actor,decision};
 }
 it('advertises required direct voting fields without a wrapper or default judgment',()=>{
  const schema=brokerTools.find(tool=>tool.name==='vote_decision')!.inputSchema;
  expect(schema.required).toEqual(['decisionId','approve','rationale']);expect(schema.additionalProperties).toBe(false);expect(schema.properties.approve).toEqual({type:'boolean'});expect(Object.keys(schema.properties)).toEqual(['decisionId','approve','rationale']);expect(corporateGuide).toContain('Prefer the typed vote_decision tool');
 });
 it('records explicit dissent through the same immutable domain command and keeps peers blind',async()=>{
  const {actor,decision}=governanceActor(),reader=actorFor(store.list('employees').filter(e=>store.level(e.id)==='elder')[2]);store.update('assignments',store.need('runs',reader.runId).assignmentId,{kind:'governance',status:'running',payload:{decisionId:decision.id}});
  const rationale='INDEPENDENT_TYPED_DISSENT: actual evidence requires a narrower remit. '.repeat(80).trim();
  const vote=await broker.call(actor,'vote_decision',{decisionId:decision.id,approve:false,rationale,employeeId:reader.employeeId,runId:reader.runId});
  expect(vote).toMatchObject({employeeId:actor.employeeId,runId:actor.runId,decisionId:decision.id,approve:false,phase:'initial',_receipt:{command:'decision.vote',fullRecord:{collection:'votes'}}});expect(JSON.stringify(vote).length).toBeLessThanOrEqual(6000);expect(store.need('votes',vote.id).rationale).toBe(rationale);
  expect(store.need('runs',actor.runId).corporateCommands.at(-1)).toMatchObject({type:'decision.vote',id:vote.id});expect(store.need('assignments',store.need('runs',actor.runId).assignmentId).status).toBe('completed');
  await expect(broker.call(actor,'vote_decision',{decisionId:decision.id,approve:true,rationale:'Change after initial judgment'})).rejects.toMatchObject({code:'duplicate_vote'});expect(store.need('votes',vote.id).approve).toBe(false);
  expect((await broker.call(reader,'company_read',{collection:'votes'})).items).toEqual([]);await expect(broker.call(reader,'company_detail',vote._receipt.fullRecord)).rejects.toThrow(/authorized scope/);
  // Generic command compatibility remains identical after the typed peer vote.
  await broker.call(reader,'company_command',{command:{type:'decision.vote',decisionId:decision.id,approve:true,rationale:'My independently formed supporting judgment'}});
  expect((await broker.call(reader,'company_read',{collection:'votes'})).items.find((v:any)=>v.id===vote.id)?.approve).toBe(false);expect(JSON.parse((await broker.call(reader,'company_detail',vote._receipt.fullRecord)).content).rationale).toBe(rationale);
 });
 it('permits only the exact assigned initial decision and retains actionable malformed-call guidance',async()=>{
  const {actor,decision}=governanceActor(),other=store.command(owner,{type:'decision.create',kind:'executive.review',subject:'Different review',rationale:'Separate evidence',payload:{employeeId:ceo.id}});
  await expect(broker.call(actor,'vote_decision',{decisionId:other.id,approve:true,rationale:'Wrong assigned decision'})).rejects.toMatchObject({code:'initial_vote_required'});
  await expect(broker.call(actor,'vote_decision',{payload:{decisionId:decision.id,approve:false,rationale:'Wrong wrapper'}})).rejects.toThrow(/Do not nest these fields in payload/);
  await expect(broker.call(actor,'company_command',{command:{type:'decision.vote',payload:{decisionId:decision.id,approve:false,rationale:'Wrong legacy wrapper'}}})).rejects.toThrow(/fields directly inside command/);expect(store.list('votes')).toEqual([]);
 });
 it.each([undefined,null,'true','false',0,1])('does not infer a boolean vote from %s',async approve=>{
  const {actor,decision}=governanceActor();await expect(broker.call(actor,'vote_decision',{decisionId:decision.id,approve,rationale:'Independent reason supplied'})).rejects.toMatchObject({code:'invalid_vote'});expect(store.list('votes')).toEqual([]);expect(store.need('assignments',store.need('runs',actor.runId).assignmentId).status).toBe('running');
 });
 it('requires an actual independent rationale and rejects non-Elder authority regardless of argument claims',async()=>{
  const {actor,decision}=governanceActor();await expect(broker.call(actor,'vote_decision',{decisionId:decision.id,approve:true})).rejects.toThrow(/Independent rationale/);
  const executiveActor=actorFor(ceo);await expect(broker.call(executiveActor,'vote_decision',{decisionId:decision.id,approve:true,rationale:'Unauthorized vote',actor,employeeId:actor.employeeId})).rejects.toMatchObject({code:'elder_required'});expect(store.list('votes')).toEqual([]);
 });
});


it('rejects silently ignored exact-record selectors with the correct detail tool guidance',async()=>{
 const actor=actorFor(ceo);await expect(broker.call(actor,'company_read',{collection:'decisions',id:'exact-decision',view:'content'})).rejects.toMatchObject({code:'detail_tool_required'});await expect(broker.call(actor,'company_read',{collection:'decisions',id:'exact-decision'})).rejects.toThrow(/company_detail.*exact-decision/);
});
