import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Actor, Artifact, Assignment, Employee, PositionLevel, Project } from '../src/core/types.js';
import { CompanyStore } from '../src/storage/store.js';
import { CorporateBroker } from '../src/tools/broker.js';

const owner={kind:'owner'} as const,model='wlkr-management-qwen3.8-27b-q4-k-m:latest';
let root:string,store:CompanyStore,broker:CorporateBroker,ceo:Employee,manager:Employee,author:Employee,reviewer:Employee,project:Project,original:Assignment,artifact:Artifact;
function hire(name:string,homeManagerId:string,level:PositionLevel='worker'):Employee{
 const position=store.command(owner,{type:'position.create',title:name,level,responsibilities:'Inspect actual product evidence'});
 return store.command(owner,{type:'employee.hire',name,positionId:position.id,homeManagerId,modelId:model});
}
function active(employee:Employee,assignment?:Assignment):Extract<Actor,{kind:'employee'}>{
 const task=assignment??store.command(owner,{type:'assignment.create',employeeId:employee.id,kind:'management',title:'Direct scoped work',instructions:'Use retained source evidence',acceptance:['Actual scoped assignment']});
 const run=store.put('runs',{employeeId:employee.id,assignmentId:task.id,modelId:model,status:'running',sessionId:randomUUID(),workspace:root,policyRevision:store.policy.revision,tokenRevoked:false,attempt:1,heartbeatAt:new Date().toISOString(),leaseUntil:new Date(Date.now()+60000).toISOString()});
 store.update('assignments',task.id,{status:'running'});
 return {kind:'employee',employeeId:employee.id,runId:run.id,policyRevision:store.policy.revision};
}
function reviewInput(){return {employeeId:reviewer.id,projectId:project.id,kind:'review',title:'Review the retained output',instructions:'Inspect the artifact and original acceptance, then record an independent verdict',acceptance:['Evidence-based independent verdict'],payload:{artifactId:artifact.id}};}
function retained(actor:Extract<Actor,{kind:'employee'}>){return {assignments:store.list('assignments'),employees:store.list('employees'),commands:store.need('runs',actor.runId).corporateCommands??[],calls:store.need('runs',actor.runId).corporateCalls??0};}
beforeEach(()=>{
 root=mkdtempSync(join(tmpdir(),'opencorp-review-scope-'));store=new CompanyStore(root);store.bootstrap();store.put('models',{name:model,artifactIdentity:'verified-local-fixture',local:true,available:true});store.command(owner,{type:'control',action:'start'});broker=new CorporateBroker(store,root);
 ceo=store.list('employees').find(employee=>store.level(employee.id)==='ceo')!;manager=hire('Project lead',ceo.id,'lead');author=hire('Author manager',manager.id,'manager');reviewer=hire('Independent reviewer',manager.id);
 project=store.command(owner,{type:'project.create',name:'Finite product work',productId:store.list('products')[0].id,outcome:'Deliver an independently reviewed correction',acceptance:['Observed correction'],supervisorId:manager.id,rationale:'Fixture scope'});
 original=store.command(owner,{type:'assignment.create',projectId:project.id,employeeId:author.id,title:'Actual authored output',instructions:'Produce finite source evidence',acceptance:['Observed correction']});
 const authorRun=store.put('runs',{assignmentId:original.id,employeeId:author.id,status:'succeeded',modelId:model});
 artifact=store.put('artifacts',{projectId:project.id,assignmentId:original.id,employeeId:author.id,runId:authorRun.id,uri:'fixture-evidence.md',identity:'retained-content-identity',kind:'analysis',summary:'Retained analysis for review',checks:[]});store.update('assignments',original.id,{status:'awaiting_review'});
});
afterEach(async()=>{await broker.cancel();store.close();rmSync(root,{recursive:true,force:true});});

describe('new review assignment scope',()=>{
 it.each(['create_assignment','company_command'] as const)('prevents an author bypassing project authority through omitted scope via %s',async(tool)=>{
  const actor=active(author),input:any=reviewInput();delete input.projectId;const before=retained(actor);
  await expect(broker.call(actor,tool,tool==='company_command'?{command:{type:'assignment.create',...input}}:input)).rejects.toThrow(/explicit projectId and payload.artifactId/);
  expect(retained(actor)).toEqual(before);
  await expect(broker.call(actor,tool,tool==='company_command'?{command:{type:'assignment.create',...reviewInput()}}:reviewInput())).rejects.toThrow(/project supervisor/);
  expect(retained(actor)).toEqual(before);
 });
 it.each(['null-project','missing-artifact-id','missing-artifact','different-project','source-assignment-mismatch','missing-source-assignment','unregistered-product'] as const)('rejects %s before persistence or shared staffing',async(fault)=>{
  const actor=active(ceo),input:any=reviewInput();
  if(fault==='null-project')input.projectId=null;
  if(fault==='missing-artifact-id')input.payload={};
  if(fault==='missing-artifact')input.payload.artifactId=randomUUID();
  if(fault==='different-project')input.projectId=store.command(owner,{type:'project.create',name:'Other product',productId:store.list('products')[1].id,outcome:'Other scope',acceptance:['Other result'],supervisorId:manager.id,rationale:'Different product fixture'}).id;
  if(fault==='source-assignment-mismatch')store.update('assignments',original.id,{projectId:null});
  if(fault==='missing-source-assignment')store.update('artifacts',artifact.id,{assignmentId:randomUUID()});
  if(fault==='unregistered-product')store.update('projects',project.id,{productId:randomUUID()});
  const before=retained(actor);
  await expect(broker.call(actor,'create_assignment',input)).rejects.toThrow(/review|Review|products record/);
  expect(retained(actor)).toEqual(before);
 });
 it('requires an independent reviewer even when Owner creates the assignment',()=>{
  const before=store.list('assignments');expect(()=>store.command(owner,{type:'assignment.create',...reviewInput(),employeeId:author.id})).toThrow(/author cannot review/);expect(store.list('assignments')).toEqual(before);
 });
 it('accepts a valid supervisor review while borrowed staffing still needs its home manager',async()=>{
  const homeManager=hire('Other home manager',ceo.id,'manager'),borrowed=hire('Borrowed reviewer',homeManager.id),actor=active(manager);
  const receipt=await broker.call(actor,'create_assignment',{...reviewInput(),employeeId:borrowed.id}),task=store.need('assignments',receipt.id);
  expect(task).toMatchObject({projectId:project.id,employeeId:borrowed.id,supervisorId:manager.id,kind:'review',payload:{artifactId:artifact.id},status:'queued',accepted:false});
  const accepted=store.command(active(homeManager),{type:'assignment.accept',assignmentId:task.id,accept:true,rationale:'Capacity reserved for this exact independent review'});
  expect(accepted).toMatchObject({accepted:true,projectId:project.id,payload:{artifactId:artifact.id},staffingDecision:{employeeId:borrowed.id,managerId:homeManager.id,approved:true}});
  const reviewerActor=active(borrowed,accepted),detail=await broker.call(reviewerActor,'company_detail',{collection:'artifacts',id:artifact.id,view:'record'});
  expect(JSON.parse(detail.content)).toMatchObject({id:artifact.id,projectId:project.id,assignmentId:original.id});expect(store.need('runs',reviewerActor.runId).artifactInspections).toBeUndefined();
 });
 it('supports an exact company-maintenance project without inventing a product requirement',()=>{
  store.update('projects',project.id,{productId:null});const task=store.command(owner,{type:'assignment.create',...reviewInput()});expect(task).toMatchObject({projectId:project.id,payload:{artifactId:artifact.id},accepted:true});
 });
});

describe('immutable assignment scope',()=>{
 it('rejects author reassignment before changing instructions, priority, staffing or command receipts',async()=>{
  const task=store.command(owner,{type:'assignment.create',...reviewInput()}),actor=active(manager),before=retained(actor);
  await expect(broker.call(actor,'company_command',{command:{type:'assignment.update',assignmentId:task.id,employeeId:author.id,instructions:'Must not persist',priority:99,dependencies:[],rationale:'Attempted reassignment to the source author'}})).rejects.toThrow(/author cannot review/);
  expect(retained(actor)).toEqual(before);
 });
 it.each([{projectId:null},{projectId:'different-project'},{payload:{}},{payload:{artifactId:'different-artifact'}}])('rejects explicit scope edit %j without applying accompanying supported changes',async(scope)=>{
  const task=store.command(owner,{type:'assignment.create',...reviewInput()}),actor=active(manager),before=retained(actor);
  await expect(broker.call(actor,'company_command',{command:{type:'assignment.update',assignmentId:task.id,...scope,instructions:'Must not persist',priority:99,rationale:'Attempted scope repair'}})).rejects.toThrow(/does not support projectId or payload changes/);
  expect(retained(actor)).toEqual(before);
 });
 it('rejects even explicit same-value scope fields rather than silently suggesting update support',()=>{
  const task=store.command(owner,{type:'assignment.create',...reviewInput()});expect(()=>store.command(owner,{type:'assignment.update',assignmentId:task.id,projectId:task.projectId,payload:task.payload})).toThrow(/cancel the old assignment/);expect(store.need('assignments',task.id)).toEqual(task);
 });
 it('preserves supported supervisor revisions and original acceptance, payload and project',async()=>{
  const task=store.command(owner,{type:'assignment.create',...reviewInput()}),actor=active(manager),replacement=hire('Available independent reviewer',manager.id);
  const receipt=await broker.call(actor,'company_command',{command:{type:'assignment.update',assignmentId:task.id,employeeId:replacement.id,instructions:'Inspect exact original acceptance and actual source before a verdict',priority:9,dependencies:[],rationale:'Assign available independent capacity'}});
  expect(store.need('assignments',receipt.id)).toMatchObject({employeeId:replacement.id,priority:9,instructions:'Inspect exact original acceptance and actual source before a verdict',accepted:true,projectId:task.projectId,payload:task.payload,acceptance:task.acceptance});
 });
});
