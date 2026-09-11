import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyStore } from '../src/storage/store.js';
import { assignmentAnchor, Scheduler } from '../src/scheduler/scheduler.js';
import { CorporateBroker } from '../src/tools/broker.js';
import { runtimeConfig, type LocalRuntime } from '../src/runtime/index.js';
import type { ExecuteRequest, LocalModel, RuntimeResult } from '../src/runtime/types.js';
import type { Actor, Assignment, EmployeeRun } from '../src/core/types.js';

const owner={kind:'owner'} as const,model='wlkr-management-qwen3.8-27b-q4-k-m:latest';
let root:string,store:CompanyStore,broker:CorporateBroker,employeeId:string;
beforeEach(()=>{
 root=mkdtempSync(join(tmpdir(),'opencorp-assignment-anchor-'));store=new CompanyStore(root);store.bootstrap();broker=new CorporateBroker(store,root);
 store.put('models',{name:model,artifactIdentity:'fixture-local-model',local:true,available:true,capabilities:['tools']});
 employeeId=store.list('employees').find(employee=>store.level(employee.id)==='ceo')!.id;store.update('employees',employeeId,{modelId:model});store.command(owner,{type:'control',action:'start'});
});
afterEach(async()=>{await broker.cancel();store.close();rmSync(root,{recursive:true,force:true});vi.restoreAllMocks();});
function task(kind:Assignment['kind'],projectId?:string,payload={}){
 const assignment=store.command(owner,{type:'assignment.create',employeeId,projectId,kind,title:'Exact retained task',instructions:'Recover this exact stored request; never select a different assignment from a summary.',acceptance:['Retain the original requested outcome'],payload});
 const run=store.claimNext({assignmentId:assignment.id,workspace:root})!;store.bindSession(run.id,'fixture-session',root);return {assignment,run};
}
const actor=(run:EmployeeRun):Actor=>({kind:'employee',employeeId:run.employeeId,runId:run.id,policyRevision:run.policyRevision});
const result=(text:string):RuntimeResult=>({sessionId:'fixture-session',text,modelId:'qwen-main',artifactIdentity:'fixture-local-model',usage:{inputTokens:20,outputTokens:10,requests:1,durationMs:10},messagesPath:join(root,'fixture-messages.json'),diagnosticsPath:join(root,'fixture-result.json'),completion:{finishReason:'stop',continuations:0,outputLimit:4096,exhausted:false}});
function compactedEmployeePrompt(request:ExecuteRequest){
 // Pinned OpenCode drops the original user prompt/system after compaction but
 // reapplies agent.prompt: session/compaction.ts489 and session/llm/request.ts52.
 // The observed failed compaction produced no summary text at all.
 const config=runtimeConfig({alias:'fixture-local-32768',capabilities:['tools'],contextTokens:32768} as LocalModel,'http://127.0.0.1:1','fixture-only',true,request);
 const continuation={role:'user',content:'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.'};
 expect(continuation.content).not.toContain(request.prompt);
 expect(config.agent?.employee?.steps).toBe(32);expect(Object.values(config.provider!['opencorp-local'].models!)[0].limit).toMatchObject({input:32768,output:4096});
 return config.agent!.employee!.prompt!;
}
describe('durable stored-assignment recovery after native compaction',()=>{
 it.each(['management','implementation','assessment','conversation'] as const)('keeps the exact %s pointer recoverable without copying task contents into the system',async kind=>{
  const project=kind==='implementation'?store.command(owner,{type:'project.create',name:'Fixture company project',supervisorId:employeeId,outcome:'Useful retained task',acceptance:['Actual evidence'],rationale:'Compaction boundary fixture'}):undefined;
  const {assignment,run}=task(kind,project?.id),before=structuredClone(assignment),message=kind==='conversation'?store.command(owner,{type:'message.send',recipientId:employeeId,content:'Acknowledge this exact fixture request only.'}):undefined;
  if(message)store.update('assignments',assignment.id,{payload:{messageId:message.id},instructions:`Owner message ${message.id}: Acknowledge this exact fixture request only.`});
  const execute=vi.fn(async(request:ExecuteRequest)=>{
   const persisted=compactedEmployeePrompt(request),anchor=assignmentAnchor(store.need('assignments',assignment.id));
   expect(persisted).toContain(anchor);expect(persisted).toContain(JSON.stringify({collection:'assignments',id:assignment.id,offset:0}));expect(persisted).toContain('follow nextOffset');expect(persisted).toContain('exact stored instructions, acceptance and progress');
   expect(persisted).not.toContain(before.instructions);expect(persisted).not.toContain(before.acceptance[0]);expect(persisted).not.toContain('This is an independent review assignment');
   const data=JSON.parse((await broker.call(actor(run),'company_detail',{collection:'assignments',id:assignment.id,offset:0})).content);expect(data.id).toBe(assignment.id);expect(data.acceptance).toEqual(before.acceptance);expect(data.instructions).toBe(store.need('assignments',assignment.id).instructions);
   if(project)expect(persisted).toContain(`"projectId":"${project.id}"`);else expect(anchor).not.toContain('projectId');
   if(message){expect(persisted).toContain('Your final response is the requested conversation deliverable');expect(persisted).not.toContain('Final prose is not a deliverable');}
   return result(message?'Acknowledged.':'Prose alone does not satisfy the retained task.');
  });
  await (new Scheduler(store,{execute} as unknown as LocalRuntime,broker,'http://localhost') as any).execute(run);expect(execute).toHaveBeenCalledOnce();
  if(message){expect(store.need('runs',run.id).status).toBe('succeeded');expect(store.list('messages').find(item=>item.runId===run.id)).toMatchObject({senderId:employeeId,content:'Acknowledged.'});}
  else{expect(store.need('runs',run.id).status).toBe('failed');expect(store.need('assignments',assignment.id).acceptance).toEqual(before.acceptance);}
 });
 it('retains the exact review artifact and original-acceptance retrieval obligation after an empty compaction summary',async()=>{
  const project=store.command(owner,{type:'project.create',name:'Independent review fixture',supervisorId:employeeId,outcome:'Verified work',acceptance:['Actual independent result'],rationale:'Retained review fixture'});
  const position=store.command(owner,{type:'position.create',title:'Independent author',level:'worker',responsibilities:'Author finite useful work'}),author=store.command(owner,{type:'employee.hire',name:'Fixture author',positionId:position.id,homeManagerId:employeeId,modelId:model});
  const original=store.command(owner,{type:'assignment.create',employeeId:author.id,projectId:project.id,kind:'implementation',title:'Original exact acceptance',instructions:'Preserve original scope',acceptance:['First community PR merged into main branch']});store.update('assignments',original.id,{status:'awaiting_review'});
  const artifact=store.put('artifacts',{employeeId:author.id,assignmentId:original.id,projectId:project.id,runId:'fixture-author-run',kind:'commit',identity:'a'.repeat(40),uri:'fixture://retained-commit',summary:'A partial repair does not imply original acceptance',checks:[]});
  const {assignment,run}=task('review',project.id,{artifactId:artifact.id});let persisted='';
  const execute=vi.fn(async(request:ExecuteRequest)=>{
   persisted=compactedEmployeePrompt(request);expect(persisted).toContain(`"artifactId":"${artifact.id}"`);expect(persisted).toContain(JSON.stringify({collection:'artifacts',id:artifact.id,view:'record',offset:0}));expect(persisted).toContain('its original assignmentId with company_detail assignments');
   expect(persisted).toContain('actual independent inspect_artifact coverage');expect(persisted).toContain('call review_work');expect(persisted).toContain('verdict approved or changes_requested');expect(persisted).toContain('based on actual evidence and original acceptance');expect(persisted).toContain('Approval itself does not mean the original assignment, future delivery or release has completed');
   const record=JSON.parse((await broker.call(actor(run),'company_detail',{collection:'artifacts',id:artifact.id,view:'record'})).content),originalRecord=JSON.parse((await broker.call(actor(run),'company_detail',{collection:'assignments',id:record.assignmentId})).content);expect(originalRecord.acceptance).toEqual(original.acceptance);
   return result('Please tell me a new direction to pursue.');
  });
  await (new Scheduler(store,{execute} as unknown as LocalRuntime,broker,'http://localhost') as any).execute(run);
  expect(execute).toHaveBeenCalledOnce();expect(persisted).not.toContain(original.acceptance[0]);expect(store.need('runs',run.id)).toMatchObject({status:'failed',error:expect.stringContaining('actual independent review_work verdict')});expect(store.list('reviews')).toHaveLength(0);expect(store.need('assignments',original.id).status).toBe('awaiting_review');expect(store.need('assignments',original.id).acceptance).toEqual(original.acceptance);expect(store.need('assignments',assignment.id).status).not.toBe('completed');
 });
 it('bounds anchor content to current task pointers and does not copy arbitrary payload/state',()=>{
  const value={id:'assignment-id',kind:'review',projectId:'project-id',title:'x'.repeat(100000),instructions:'x'.repeat(100000),acceptance:['x'.repeat(100000)],payload:{artifactId:'artifact-id',peerJudgment:'DO NOT COPY',arbitrary:'x'.repeat(100000)}};
  const anchor=assignmentAnchor(value);expect(anchor.length).toBeLessThan(1500);expect(anchor).toContain('"artifactId":"artifact-id"');expect(anchor).not.toContain('DO NOT COPY');expect(anchor).not.toContain('x'.repeat(100));
  const malformed=assignmentAnchor({...value,payload:{artifactId:'x'.repeat(100000)}});expect(malformed.length).toBeLessThan(1500);expect(malformed).toContain('stored payload.artifactId');expect(malformed).not.toContain('x'.repeat(100));
 });
});
