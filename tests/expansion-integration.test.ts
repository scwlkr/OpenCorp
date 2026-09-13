import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CompanyStore } from '../src/storage/store.js';
import { CorporateBroker } from '../src/tools/broker.js';
import { InternalToolManager } from '../src/tools/internal-tools.js';
import { managementOutcome } from '../src/scheduler/scheduler.js';
import { reconcileResponsibilities } from '../src/core/responsibility.js';
import type { Actor } from '../src/core/types.js';
let root:string,store:CompanyStore,broker:CorporateBroker,actor:Actor,ceoId:string;
const owner:Actor={kind:'owner'};
beforeEach(()=>{
 root=mkdtempSync(join(tmpdir(),'opencorp-expansion-integration-'));store=new CompanyStore(root);store.bootstrap();store.command(owner,{type:'control',action:'start'});broker=new CorporateBroker(store,root);
 ceoId=store.list('employees').find(e=>store.level(e.id)==='ceo')!.id;
 store.put('models',{id:'local-fixture',name:'local-fixture',local:true,available:true,artifactIdentity:'fixture'});
 const position=store.command(owner,{type:'position.create',title:'Recruiter',level:'worker',responsibilities:'Recruit candidates'});
 const employee=store.command(owner,{type:'employee.hire',name:'Recruiter',positionId:position.id,homeManagerId:ceoId,modelId:'local-fixture',role:'Recruit actual candidates'});
 const assignment=store.command(owner,{type:'assignment.create',employeeId:employee.id,title:'Source staffing',instructions:'Inspect sources',acceptance:['Actual candidate'],kind:'management'});
 const run=store.put('runs',{employeeId:employee.id,assignmentId:assignment.id,status:'running',tokenRevoked:false,policyRevision:store.policy.revision,workspace:root});actor={kind:'employee',employeeId:employee.id,runId:run.id,policyRevision:store.policy.revision};
});
afterEach(async()=>{await broker.cancel();store.close();rmSync(root,{recursive:true,force:true});vi.restoreAllMocks();});
test('recruitment workers can read permitted source and requisition records without employeeId',async()=>{
 store.put('experiences',{kind:'skill-catalog',repository:'msitarzewski/agency-agents',paths:['recruitment.md']});
 const req=store.put('experiences',{kind:'requisition',recruiterId:(actor as any).employeeId,homeManagerId:ceoId});
 await expect(broker.call(actor,'company_detail',{collection:'experiences',id:req.id})).resolves.toBeDefined();
});
test('native internal-tool calls serialize and keep their cancellation controller',async()=>{
 let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});let signal:AbortSignal|undefined;
 vi.spyOn(InternalToolManager.prototype,'execute').mockImplementation(async(_actor,_input,options)=>{signal=options?.signal;await wait;return {id:'fixture-result'} as any;});
 const first=broker.call(actor,'use_internal_tool',{productId:'fixture'});let second:Promise<unknown>|undefined;
 try{second=broker.call(actor,'use_internal_tool',{productId:'fixture'});await expect(Promise.race([second,Promise.resolve('unexpected pending call')])).rejects.toThrow(/native.*slot|slot.*active/i);await broker.cancel();expect(signal?.aborted).toBe(true);}finally{release();await Promise.allSettled([first,...(second?[second]:[])]);}
});
test('a queued fault assigned to a dismissed supervisor cannot orphan blocked work forever',()=>{
 const position=store.command(owner,{type:'position.create',title:'Prior manager',level:'manager',responsibilities:'Manage work'}),manager=store.command(owner,{type:'employee.hire',name:'Prior manager',positionId:position.id,homeManagerId:ceoId,modelId:'local-fixture'});
 const original=store.put('assignments',{employeeId:(actor as any).employeeId,supervisorId:manager.id,projectId:null,status:'blocked',kind:'management',title:'Unfinished commitment',blockedReason:'Runtime fault'});
 store.put('assignments',{employeeId:manager.id,supervisorId:ceoId,status:'queued',kind:'management',schedulerKey:'fault:fixture',payload:{failedAssignmentId:original.id}});
 store.update('employees',manager.id,{status:'dismissed'});reconcileResponsibilities(store);
 expect(store.need('assignments',original.id).continuation?.ownerId).toBe(ceoId);
});

test('live original runs hold recovery even when assignment already reports blocked',()=>{
 const original=store.need('assignments',store.need('runs',(actor as any).runId).assignmentId);store.update('assignments',original.id,{status:'blocked',blockedReason:'Native tool still stopping'});
 reconcileResponsibilities(store);expect(store.need('assignments',original.id).continuation).toBeUndefined();expect(store.list('assignments').filter(a=>a.schedulerKey?.startsWith(`responsibility:${original.id}:`))).toHaveLength(0);
});

test('dismissed recovery owner is cancelled explicitly before surviving management resumes',()=>{
 const position=store.command(owner,{type:'position.create',title:'Prior manager',level:'manager',responsibilities:'Manage work'}),manager=store.command(owner,{type:'employee.hire',name:'Prior manager',positionId:position.id,homeManagerId:ceoId,modelId:'local-fixture'});
 const original=store.put('assignments',{employeeId:(actor as any).employeeId,supervisorId:manager.id,projectId:null,status:'blocked',kind:'management',title:'Unfinished obligation'});
 const followup=store.put('assignments',{employeeId:manager.id,supervisorId:ceoId,status:'queued',kind:'management',schedulerKey:`responsibility:${original.id}:${manager.id}`});
 store.update('assignments',original.id,{continuation:{ownerId:ceoId,followupAssignmentId:followup.id,nextCheckAt:new Date(Date.now()+3600000).toISOString()}});store.update('employees',manager.id,{status:'dismissed'});
 reconcileResponsibilities(store);expect(store.need('assignments',followup.id).status).toBe('cancelled');expect(store.need('assignments',followup.id).responsibilityDisposition.priorStatus).toBe('queued');expect(store.need('assignments',original.id).continuation.ownerId).toBe(ceoId);expect(store.need('assignments',original.id).status).toBe('blocked');
});

test('actual successful adopted tool use satisfies a management work checkpoint without an unrelated mutation',()=>{
 const run=store.need('runs',(actor as any).runId),assignment=store.need('assignments',run.assignmentId);
 const receipt=store.put('experiences',{kind:'internal-tool-use',runId:run.id,employeeId:run.employeeId,productId:'fixture-tool',identity:'exact-fixture-version',status:'failed'});
 expect(managementOutcome(store,assignment,run).passed).toBe(false);store.update('experiences',receipt.id,{status:'succeeded',exitCode:0});expect(managementOutcome(store,assignment,run).passed).toBe(true);
});

test('concurrency requalification cannot leave an active limit above its measured level',()=>{
 store.command(owner,{type:'policy.update',maxInference:11,concurrencyQualification:{passed:true,stableMaxInference:11,largePlusSmall:true,evidence:'Fixture eleven-way measurement'}});
 try{store.command(owner,{type:'policy.update',concurrencyQualification:{passed:true,stableMaxInference:2,largePlusSmall:true,evidence:'Fixture lower measured stable level'}});}catch{/* Rejecting the inconsistent change or capping it atomically both preserve safety. */}
 expect(store.policy.maxInference).toBeLessThanOrEqual(store.policy.concurrencyQualification.stableMaxInference);
});

test('resolved Owner input resumes accountable management once instead of repeating the same request',()=>{
 const original=store.put('assignments',{employeeId:(actor as any).employeeId,supervisorId:ceoId,projectId:null,status:'blocked',kind:'management',title:'Original outcome',acceptance:['Preserved outcome']});
 store.put('assignments',{employeeId:ceoId,supervisorId:ceoId,status:'completed',kind:'management',schedulerKey:`responsibility:${original.id}:${ceoId}`});
 const request=store.put('attention',{kind:'owner_decision',status:'open',ownerId:ceoId,assignmentId:original.id,responsibilityKey:original.id,requiredAction:'Provide missing prerequisite'});
 const before={kind:'owner_decision',ownerId:ceoId,attentionId:request.id,nextCheckAt:new Date(Date.now()+3600000).toISOString()};store.update('assignments',original.id,{continuation:before});
 store.command(owner,{type:'attention.resolve',attentionId:request.id,resolution:'The actual prerequisite is now available. Continue the original outcome.'});
 reconcileResponsibilities(store);reconcileResponsibilities(store);
 const followups=store.list('assignments').filter(a=>a.payload?.ownerAttentionId===request.id);expect(followups).toHaveLength(1);expect(followups[0].employeeId).toBe(ceoId);expect(followups[0].instructions).toContain('actual prerequisite is now available');expect(followups[0].payload.sourceAssignmentId).toBe(original.id);
 const retained=store.need('assignments',original.id);expect(retained.continuation.followupAssignmentId).toBe(followups[0].id);expect(retained.continuationHistory).toContainEqual(before);expect(retained.acceptance).toEqual(original.acceptance);expect(store.list('attention').filter(a=>a.assignmentId===original.id&&a.status==='open')).toHaveLength(0);
});
