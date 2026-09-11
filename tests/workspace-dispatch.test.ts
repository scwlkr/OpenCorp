import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyStore } from '../src/storage/store.js';
import type { Employee, Project } from '../src/core/types.js';

const owner={kind:'owner'} as const,model='wlkr-management-qwen3.8-27b-q4-k-m:latest';
let root:string,store:CompanyStore,manager:Employee,project:Project;
function task(kind='management',payload:any={}){return store.command(owner,{type:'assignment.create',employeeId:manager.id,supervisorId:manager.id,projectId:project.id,title:'Fixture project task',instructions:'Read and act within this product workspace',acceptance:['Actual observed result'],kind,payload});}
beforeEach(()=>{
 root=mkdtempSync(join(tmpdir(),'opencorp-workspace-dispatch-'));store=new CompanyStore(root);store.bootstrap();store.put('models',{name:model,local:true,available:true,artifactIdentity:'fixture-model'});store.command(owner,{type:'control',action:'start'});manager=store.list('employees').find(e=>store.level(e.id)==='ceo')!;
 project=store.command(owner,{type:'project.create',name:'Retained merged milestone',productId:store.list('products')[0].id,outcome:'Advance only after exact native reconciliation',acceptance:['Preserved reviewed work'],supervisorId:manager.id,rationale:'Fixture dispatch boundary'});
 store.update('projects',project.id,{delivery:{artifactId:'reviewed-artifact',identity:'reviewed-head',state:'merged',prNumber:12,prUrl:'https://github.com/fixture/product/pull/12',publicationActionId:'observed-publication',mergeCommit:'observed-merge',defaultBranchHead:'observed-merge',workspaceAdvance:{state:'prepared',from:'reviewed-head',to:'observed-merge'}}});
});
afterEach(()=>{store.close();rmSync(root,{recursive:true,force:true});});

describe('atomic workspace advancement dispatch boundary',()=>{
 it.each(['management','assessment','conversation','implementation','review'])('holds %s project work without consuming attempts or claiming a run',kind=>{
  if(kind==='review'){
   const author=store.list('employees').find(employee=>employee.id!==manager.id)!,source=store.update('assignments',task('implementation').id,{employeeId:author.id,status:'completed'});
   store.put('artifacts',{id:'reviewed-artifact',projectId:project.id,assignmentId:source.id,employeeId:author.id,runId:'retained-source-run',identity:'reviewed-head',uri:'git:reviewed-head',kind:'commit',summary:'Retained reviewed fixture source',checks:[]});
  }
  const assignment=task(kind,kind==='review'?{artifactId:'reviewed-artifact'}:{}),before=store.need('assignments',assignment.id);expect(store.claimNext({assignmentId:assignment.id,workspace:root})).toBeUndefined();expect(store.list('runs')).toEqual([]);expect(store.need('assignments',assignment.id)).toEqual(before);
 });
 it('does not accept caller-authored mergeReady payload as trusted advancement authority',()=>{
  const assignment=task('management',{mergeReady:true,artifactId:'reviewed-artifact'});expect(assignment.schedulerKey).toBeUndefined();expect(store.claimNext({assignmentId:assignment.id,workspace:root})).toBeUndefined();
 });
 it.each(['merge-ready:reviewed-artifact:reviewed-head','workspace-advance:reviewed-artifact:observed-merge'])('allows only the exact trusted broker-first continuation %s',schedulerKey=>{
  const assignment=task('management',{mergeReady:true,artifactId:'reviewed-artifact'});store.update('assignments',assignment.id,{schedulerKey});const run=store.claimNext({assignmentId:assignment.id,workspace:root});expect(run?.assignmentId).toBe(assignment.id);expect(run?.runtimeDispatch).toBe('claimed');expect(store.need('projects',project.id).delivery.workspaceAdvance.state).toBe('prepared');
 });
 it.each(['wrong-artifact','wrong-key','wrong-supervisor','wrong-kind'])('rejects a continuation with %s',mismatch=>{
  const assignment=task('management',{mergeReady:true,artifactId:'reviewed-artifact'});store.update('assignments',assignment.id,{schedulerKey:'workspace-advance:reviewed-artifact:observed-merge',...(mismatch==='wrong-artifact'?{payload:{mergeReady:true,artifactId:'old-artifact'}}:{}),...(mismatch==='wrong-key'?{schedulerKey:'workspace-advance:reviewed-artifact:old-merge'}:{}),...(mismatch==='wrong-supervisor'?{supervisorId:'another-supervisor'}:{}),...(mismatch==='wrong-kind'?{kind:'assessment'}:{})});expect(store.claimNext({assignmentId:assignment.id,workspace:root})).toBeUndefined();
 });
 it('resumes ordinary project dispatch after the exact advancement is complete',()=>{
  const assignment=task();expect(store.claimNext({assignmentId:assignment.id,workspace:root})).toBeUndefined();const delivery=store.need('projects',project.id).delivery;store.update('projects',project.id,{delivery:{...delivery,workspaceAdvance:{...delivery.workspaceAdvance,state:'completed'}}});expect(store.claimNext({assignmentId:assignment.id,workspace:root})?.assignmentId).toBe(assignment.id);
 });
});
