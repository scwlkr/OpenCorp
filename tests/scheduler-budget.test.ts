import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyStore } from '../src/storage/store.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import { CorporateBroker } from '../src/tools/broker.js';
import type { LocalRuntime } from '../src/runtime/index.js';
import { RuntimeExecutionError, type ExecuteRequest, type RuntimeResult } from '../src/runtime/types.js';
import type { Assignment, EmployeeRun } from '../src/core/types.js';

const owner={kind:'owner'} as const;
const model='wlkr-management-qwen3.8-27b-q4-k-m:latest';
const maxSteps=readFileSync(new URL('./fixtures/opencode-1.18.30-max-steps.txt',import.meta.url),'utf8');
let root:string,workspace:string,store:CompanyStore,assignment:Assignment,run:EmployeeRun,broker:CorporateBroker;
beforeEach(()=>{
 root=mkdtempSync(join(tmpdir(),'opencorp-scheduler-budget-'));workspace=join(root,'workspaces','fixture');mkdirSync(workspace,{recursive:true});
 store=new CompanyStore(root);store.bootstrap();store.put('models',{name:model,artifactIdentity:'fixture-local-model',local:true,available:true,capabilities:['tools']});store.command(owner,{type:'control',action:'start'});
 const manager=store.list('employees').find(e=>store.level(e.id)==='ceo')!;
 const position=store.command(owner,{type:'position.create',title:'Fixture author',level:'worker',responsibilities:'Produce a retained fixture checkpoint'});
 const employee=store.command(owner,{type:'employee.hire',name:'Fixture employee',positionId:position.id,modelId:model,homeManagerId:manager.id});
 const project=store.command(owner,{type:'project.create',name:'Fixture company checkpoint',supervisorId:manager.id,outcome:'An actual retained analysis',acceptance:['An independently reviewed analysis'],rationale:'Isolated scheduler evidence test'});
 store.update('projects',project.id,{workspace});
 assignment=store.command(owner,{type:'assignment.create',employeeId:employee.id,projectId:project.id,title:'Write a fixture analysis',instructions:'Inspect the fixture and retain the actual analysis.',acceptance:['A retained analysis ready for independent review'],kind:'implementation'});
 run=store.claimNext({assignmentId:assignment.id,workspace})!;broker=new CorporateBroker(store,root);
});
afterEach(()=>{store.close();rmSync(root,{recursive:true,force:true});});

function result(exhausted=true):RuntimeResult {
 const messagesPath=join(root,'fixture-messages.json'),diagnosticsPath=join(root,'fixture-diagnostics.json');
 writeFileSync(messagesPath,JSON.stringify([{fixture:true,role:'assistant',text:'Preserved partial analysis'}]));
 writeFileSync(diagnosticsPath,JSON.stringify({fixture:true,runId:run.id,exhausted}));
 return {sessionId:`fixture-session-${run.id}`,text:'Preserved partial analysis',modelId:'qwen-main',artifactIdentity:'fixture-local-model',usage:{inputTokens:18000,outputTokens:2000,requests:34,durationMs:1000},messagesPath,diagnosticsPath,completion:{finishReason:'stop',continuations:0,outputLimit:4096,exhausted,...(exhausted?{nativeStepLimit:{limit:32 as const,request:32,toolEnabledSteps:30}}:{})}};
}
function scheduler(execute:(request:ExecuteRequest)=>Promise<RuntimeResult>){return new Scheduler(store,{execute} as unknown as LocalRuntime,broker,'http://localhost');}
async function execute(scheduler:Scheduler){await (scheduler as any).execute(store.need('runs',run.id));}

describe('native iteration exhaustion and checkpoint corrections',()=>{
 it('blocks a permanent API error on its first attempt and retains the response for supervisor diagnosis',async()=>{
  const response=result(false),error=new RuntimeExecutionError('runtime_failed',`OpenCode session error: ${JSON.stringify({name:'APIError',data:{message:'Local inference HTTP 400: Cannot have 2 or more assistant messages at the end of the list.',statusCode:400,isRetryable:false,responseHeaders:{'keep-alive':'timeout=5'}}})}`,response);
  const subject=scheduler(async request=>{await request.onSession?.(response.sessionId);throw error;});await execute(subject);
  expect(store.need('runs',run.id)).toMatchObject({status:'failed',transient:false,runtimeFailureCode:'runtime_failed',error:String(error),runtimeCompletion:response.completion,messagesPath:response.messagesPath});
  expect(store.need('assignments',assignment.id)).toMatchObject({status:'blocked',attempts:1,instructions:assignment.instructions});expect(store.need('assignments',assignment.id).managementCorrections??0).toBe(0);
  expect(store.list('assignments').filter(a=>a.schedulerKey===`fault:${run.id}`)).toHaveLength(1);expect(store.list('runs')).toHaveLength(1);
 });

 it('allows only one actual transport retry, then routes its repeated failure to management',async()=>{
  const subject=scheduler(async()=>{throw new RuntimeExecutionError('runtime_failed','fetch failed',undefined,{cause:Object.assign(new Error('socket hang up'),{code:'ECONNRESET'})});});
  const firstRun=run;await execute(subject);expect(store.need('runs',firstRun.id)).toMatchObject({status:'failed',transient:true});expect(store.need('assignments',assignment.id).status).toBe('queued');expect(store.list('assignments').some(a=>a.schedulerKey===`fault:${firstRun.id}`)).toBe(false);
  store.update('assignments',assignment.id,{availableAt:new Date(0).toISOString()});run=store.claimNext({assignmentId:assignment.id,workspace})!;await execute(subject);
  expect(store.need('runs',run.id)).toMatchObject({status:'failed',transient:true});expect(store.need('assignments',assignment.id)).toMatchObject({status:'blocked',attempts:2});expect(store.list('assignments').filter(a=>a.schedulerKey===`fault:${run.id}`)).toHaveLength(1);expect(store.list('runs')).toHaveLength(2);
 });

 it('preserves an incomplete result and files, then creates one causal supervisor diagnosis without an automatic correction',async()=>{
  const partial=join(workspace,'partial.md');writeFileSync(partial,'Actual preserved fixture edits, not a submitted artifact.\n');
  const response=result(),runtime=vi.fn(async(request:ExecuteRequest)=>{await request.onSession?.(response.sessionId);return response;}),subject=scheduler(runtime);
  await execute(subject);
  (subject as any).reconcileOrganization();(subject as any).reconcileOrganization();
  const retained=store.need('runs',run.id),blocked=store.need('assignments',assignment.id);
  expect(retained).toMatchObject({status:'failed',tokenRevoked:true,transient:false,sessionId:response.sessionId,runtimeFailureCode:'step_budget_exhausted',text:response.text,modelIdentity:response.artifactIdentity,usage:response.usage,messagesPath:response.messagesPath,runtimeDiagnosticsPath:response.diagnosticsPath,runtimeCompletion:response.completion});
  expect(retained.error).toContain('exhausted its 32 iterations');expect(retained.error).toContain('an artifact authored in this run');
  expect(blocked).toMatchObject({status:'blocked',attempts:1,instructions:assignment.instructions,acceptance:assignment.acceptance});expect(blocked.managementCorrections??0).toBe(0);expect(blocked.retryDecisions??[]).toEqual([]);
  const diagnoses=store.list('assignments').filter(a=>a.schedulerKey===`fault:${run.id}`);expect(diagnoses).toHaveLength(1);
  expect(diagnoses[0]).toMatchObject({employeeId:assignment.supervisorId,kind:'management',payload:{failedRunId:run.id,failedAssignmentId:assignment.id}});expect(diagnoses[0].instructions).toContain(run.id);
  expect(readFileSync(partial,'utf8')).toBe('Actual preserved fixture edits, not a submitted artifact.\n');expect(JSON.parse(readFileSync(response.diagnosticsPath,'utf8'))).toMatchObject({runId:run.id,exhausted:true});expect(JSON.parse(readFileSync(response.messagesPath,'utf8'))).toHaveLength(1);
  expect(store.list('artifacts')).toEqual([]);expect(store.list('runs')).toHaveLength(1);expect(runtime).toHaveBeenCalledOnce();
 });

 it('keeps an actually recorded checkpoint successful at the native limit and leaves it awaiting independent review',async()=>{
  const response=result(),subject=scheduler(async request=>{
   await request.onSession?.(response.sessionId);writeFileSync(join(workspace,'analysis.md'),'# Fixture findings\n\nThe retained fixture requires an independent reviewer.\n');
   await broker.call(broker.actor(run.id,request.token!), 'record_artifact',{path:'analysis.md',summary:'Actual fixture analysis'});return response;
  });
  await execute(subject);
  const artifact=store.list('artifacts')[0];expect(artifact).toMatchObject({assignmentId:assignment.id,employeeId:run.employeeId,runId:run.id,kind:'analysis'});expect(readFileSync(artifact.uri,'utf8')).toContain('independent reviewer');
  expect(store.need('runs',run.id)).toMatchObject({status:'succeeded',runtimeCompletion:response.completion});expect(store.need('runs',run.id).runtimeFailureCode).toBeUndefined();
  expect(store.need('assignments',assignment.id).status).toBe('awaiting_review');expect(store.list('reviews')).toEqual([]);expect(store.list('assignments').some(a=>a.schedulerKey===`fault:${run.id}`)).toBe(false);
  expect(store.list('messages').find(message=>message.runId===run.id)?.content).toBe(response.text);expect(store.list('experiences').find(experience=>experience.runId===run.id)?.summary).toBe(`${assignment.title}: ${response.text}`);
 });

 it.each(['protocol','quoted','no-limit'])('preserves checkpoints and raw evidence while publishing only employee output: %s',async variant=>{
  const response=result(variant!=='no-limit');response.text=variant==='quoted'?`The provider supplied this quoted marker:\n${maxSteps}`:maxSteps;
  writeFileSync(response.messagesPath,JSON.stringify([{role:'assistant',text:response.text}]));writeFileSync(response.diagnosticsPath,JSON.stringify(response));
  const rawMessages=readFileSync(response.messagesPath),rawDiagnostics=readFileSync(response.diagnosticsPath);
  const subject=scheduler(async request=>{await request.onSession?.(response.sessionId);writeFileSync(join(workspace,'analysis.md'),'# Real retained fixture checkpoint\n');await broker.call(broker.actor(run.id,request.token!), 'record_artifact',{path:'analysis.md',summary:'Retained analysis'});return response;});
  await execute(subject);
  expect(store.need('runs',run.id)).toMatchObject({status:'succeeded',text:response.text,runtimeCompletion:response.completion});expect(store.need('assignments',assignment.id).status).toBe('awaiting_review');
  expect(store.list('artifacts')).toHaveLength(1);expect(store.list('reviews')).toEqual([]);expect(store.list('runs')).toHaveLength(1);expect(store.list('assignments').some(item=>item.schedulerKey===`fault:${run.id}`)).toBe(false);
  expect(readFileSync(response.messagesPath)).toEqual(rawMessages);expect(readFileSync(response.diagnosticsPath)).toEqual(rawDiagnostics);
  const messages=store.list('messages').filter(message=>message.runId===run.id),experiences=store.list('experiences').filter(experience=>experience.runId===run.id);
  if(variant==='protocol'){expect(messages).toEqual([]);expect(experiences).toEqual([]);}else{expect(messages[0].content).toBe(response.text);expect(experiences[0].summary).toBe(`${assignment.title}: ${response.text}`);}
 });

 it.each(['protocol','employee-reply'])('requires an actual conversation reply while retaining native-limit evidence: %s',async variant=>{
  assignment=store.update('assignments',assignment.id,{kind:'conversation',instructions:'Reply to the actual Owner acknowledgment request.',acceptance:['Provide the requested acknowledgment']});
  const response=result();response.text=variant==='protocol'?maxSteps:'Acknowledged. Your message has been received.';
  writeFileSync(response.messagesPath,JSON.stringify([{role:'assistant',text:response.text}]));writeFileSync(response.diagnosticsPath,JSON.stringify(response));
  const rawMessages=readFileSync(response.messagesPath),rawDiagnostics=readFileSync(response.diagnosticsPath);
  const runtime=vi.fn(async(request:ExecuteRequest)=>{await request.onSession?.(response.sessionId);return response;}),subject=scheduler(runtime);
  await execute(subject);
  const retained=store.need('runs',run.id),after=store.need('assignments',assignment.id),messages=store.list('messages').filter(message=>message.runId===run.id);
  expect(retained).toMatchObject({text:response.text,runtimeCompletion:response.completion,messagesPath:response.messagesPath,runtimeDiagnosticsPath:response.diagnosticsPath,usage:response.usage});
  expect(readFileSync(response.messagesPath)).toEqual(rawMessages);expect(readFileSync(response.diagnosticsPath)).toEqual(rawDiagnostics);expect(runtime).toHaveBeenCalledOnce();expect(store.list('runs')).toHaveLength(1);
  if(variant==='protocol'){
   expect(retained).toMatchObject({status:'failed',tokenRevoked:true,transient:false,runtimeFailureCode:'step_budget_exhausted'});expect(retained.error).toContain('an actual employee reply');
   expect(after).toMatchObject({status:'blocked',attempts:1,instructions:assignment.instructions,acceptance:assignment.acceptance});expect(after.managementCorrections??0).toBe(0);expect(after.retryDecisions??[]).toEqual([]);
   expect(messages).toEqual([]);expect(store.list('experiences').filter(experience=>experience.runId===run.id)).toEqual([]);
   const diagnoses=store.list('assignments').filter(item=>item.schedulerKey===`fault:${run.id}`);expect(diagnoses).toHaveLength(1);expect(diagnoses[0]).toMatchObject({employeeId:assignment.supervisorId,kind:'management',payload:{failedRunId:run.id,failedAssignmentId:assignment.id}});
  }else{
   expect(retained.status).toBe('succeeded');expect(after.status).toBe('completed');expect(messages).toHaveLength(1);expect(messages[0].content).toBe(response.text);expect(store.list('assignments').some(item=>item.schedulerKey===`fault:${run.id}`)).toBe(false);
  }
 });

 it.each([1,2])('allows exactly the configured %i ordinary checkpoint corrections before diagnosis',async maxCorrections=>{
  if(maxCorrections===1){store.command(owner,{type:'policy.update',maxCorrections});store.update('runs',run.id,{policyRevision:store.policy.revision});}
  const subject=scheduler(async request=>{const response=result(false);await request.onSession?.(response.sessionId);return response;});
  for(let attempt=0;attempt<=maxCorrections;attempt++){
   const current=run;await execute(subject);const after=store.need('assignments',assignment.id);
   expect(store.need('runs',current.id)).toMatchObject({status:'failed',transient:false});expect(store.need('runs',current.id).runtimeFailureCode).toBeUndefined();
   expect(after.managementCorrections).toBe(Math.min(attempt+1,maxCorrections));
   if(attempt<maxCorrections){
    expect(after.status).toBe('queued');expect(store.list('assignments').some(a=>a.schedulerKey===`fault:${current.id}`)).toBe(false);
    store.update('assignments',assignment.id,{availableAt:new Date(0).toISOString()});run=store.claimNext({assignmentId:assignment.id,workspace})!;expect(run).toBeDefined();
   }else{
    expect(after.status).toBe('blocked');expect(store.list('assignments').filter(a=>a.schedulerKey===`fault:${current.id}`)).toHaveLength(1);
   }
  }
  expect(store.list('runs')).toHaveLength(maxCorrections+1);expect(store.list('artifacts')).toEqual([]);expect(store.need('assignments',assignment.id).acceptance).toEqual(assignment.acceptance);
 });
});
