import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyStore } from '../src/storage/store.js';
import type { Actor, Employee } from '../src/core/types.js';

const owner={kind:'owner'} as const,model='wlkr-management-qwen3.8-27b-q4-k-m:latest';
let root:string,store:CompanyStore,ceo:Employee;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'opencorp-dependency-domain-'));store=new CompanyStore(root);store.bootstrap();store.put('models',{name:model,local:true,available:true,artifactIdentity:'fixture-local-model'});store.command(owner,{type:'control',action:'start'});ceo=store.list('employees').find(employee=>store.level(employee.id)==='ceo')!;});
afterEach(()=>{store.close();rmSync(root,{recursive:true,force:true});});
function assignment(dependencies:unknown=[],employeeId=ceo.id){return store.command(owner,{type:'assignment.create',employeeId,supervisorId:ceo.id,title:'Retained scoped work',instructions:'Deliver only the assigned outcome',acceptance:['Actual retained acceptance'],kind:'implementation',dependencies});}
function actor(employeeId=ceo.id):Extract<Actor,{kind:'employee'}>{const work=assignment([],employeeId),run=store.put('runs',{employeeId,assignmentId:work.id,modelId:model,policyRevision:store.policy.revision,status:'running',tokenRevoked:false,sessionId:'fixture-session'});store.update('assignments',work.id,{status:'running',kind:'management'});return {kind:'employee',employeeId,runId:run.id,policyRevision:store.policy.revision};}

describe('audited assignment completion prerequisites',()=>{
 it('holds a subset behind its blocked original until supervising management explicitly changes its dependencies',()=>{
  const original=assignment();store.update('assignments',original.id,{status:'blocked',blockedReason:'Original needs independently delivered subsets'});
  const subset=assignment([original.id]);expect(store.claimNext({assignmentId:subset.id})).toBeUndefined();
  const manager=actor(),rationale='This subset produces an original prerequisite; its source reference is not a completion dependency';
  const changed=store.command(manager,{type:'assignment.update',assignmentId:subset.id,dependencies:[],rationale,acceptance:['Untrusted replacement ignored']});
  expect(changed.acceptance).toEqual(subset.acceptance);expect(changed.dependencies).toEqual([]);expect(changed.status).toBe('queued');expect(store.need('assignments',original.id).status).toBe('blocked');
  expect(changed.dependencyDecisions).toEqual([{actorId:ceo.id,runId:manager.runId,at:expect.any(String),rationale,priorDependencies:[original.id],dependencies:[],priorStatus:'queued',status:'queued'}]);
  expect(store.need('runs',manager.runId).corporateCommands).toEqual([expect.objectContaining({type:'assignment.update',id:subset.id})]);
  store.update('runs',manager.runId,{status:'succeeded'});expect(store.claimNext({assignmentId:subset.id})?.assignmentId).toBe(subset.id);
  store.close();store=new CompanyStore(root);expect(store.need('assignments',subset.id).dependencyDecisions).toEqual(changed.dependencyDecisions);
 });
 it.each([null,'id',{},[null],[''],[' ']])('rejects explicitly malformed dependency arrays on creation and revision: %j',dependencies=>{
  const target=assignment(),before=store.list('assignments');expect(()=>assignment(dependencies)).toThrow(/explicit array/);expect(store.list('assignments')).toEqual(before);
  expect(()=>store.command(owner,{type:'assignment.update',assignmentId:target.id,dependencies,rationale:'Fix graph'})).toThrow(/explicit array/);expect(store.need('assignments',target.id)).toEqual(target);
 });
 it('rejects duplicate, missing, self and transitive dependencies without partial changes',()=>{
  const first=assignment(),second=assignment([first.id]),third=assignment([second.id]);
  for(const dependencies of [[first.id,first.id],['missing-assignment']])expect(()=>assignment(dependencies)).toThrow(/distinct|does not exist/);
  for(const dependencies of [[first.id],[third.id],['missing-assignment']]){
   expect(()=>store.command(owner,{type:'assignment.update',assignmentId:first.id,dependencies,rationale:'Invalid dependency graph'})).toThrow(/cycle|does not exist/);expect(store.need('assignments',first.id)).toEqual(first);
  }
  store.update('assignments',first.id,{dependencies:[third.id]});expect(()=>assignment([second.id])).toThrow(/cycle/);
  store.command(owner,{type:'assignment.update',assignmentId:first.id,dependencies:[],rationale:'Repair retained legacy cycle'});expect(store.need('assignments',first.id).dependencies).toEqual([]);
 });
 it('requires rationale even for unchanged dependency edits and does not count order changes as a graph correction',()=>{
  const first=assignment(),second=assignment(),target=assignment([first.id,second.id]);
  for(const rationale of [undefined,'',' '])expect(()=>store.command(owner,{type:'assignment.update',assignmentId:target.id,dependencies:target.dependencies,rationale})).toThrow(/Dependency rationale/);
  store.command(owner,{type:'assignment.update',assignmentId:target.id,dependencies:[second.id,first.id],rationale:'Only reordered unchanged prerequisites'});expect(store.need('assignments',target.id).dependencyDecisions).toBeUndefined();
 });
 it.each(['running','awaiting_review','completed','cancelled'] as const)('rejects dependency edits while %s',status=>{
  const target=store.update('assignments',assignment().id,{status});expect(()=>store.command(owner,{type:'assignment.update',assignmentId:target.id,dependencies:[],rationale:'Unsafe change during active or closed work'})).toThrow(/only while/);expect(store.need('assignments',target.id)).toEqual(target);
 });
 it.each(['queued','blocked','needs_changes'] as const)('allows supervising management to revise dependencies while %s',status=>{
  const prerequisite=assignment(),target=store.update('assignments',assignment([prerequisite.id]).id,{status}),manager=actor();
  store.command(manager,{type:'assignment.update',assignmentId:target.id,dependencies:[],rationale:'Exact observed prerequisite no longer applies'});expect(store.need('assignments',target.id)).toMatchObject({status,dependencies:[],acceptance:target.acceptance});
 });
 it('rejects unrelated management and rolls back dependency edits when a simultaneous transition is invalid',()=>{
  const prerequisite=assignment(),target=assignment([prerequisite.id]),position=store.command(owner,{type:'position.create',title:'Other manager',level:'manager',responsibilities:'Other work'}),other=store.command(owner,{type:'employee.hire',name:'Other manager',positionId:position.id,homeManagerId:ceo.id,modelId:model});
  const outsider=actor(other.id);expect(()=>store.command(outsider,{type:'assignment.update',assignmentId:target.id,dependencies:[],rationale:'Unrelated change'})).toThrow(/supervising management/);expect(store.need('runs',outsider.runId).corporateCommands??[]).toEqual([]);
  expect(()=>store.command(owner,{type:'assignment.update',assignmentId:target.id,dependencies:[],status:'queued',rationale:'Invalid same-state transition'})).toThrow(/Cannot move/);expect(store.need('assignments',target.id)).toEqual(target);
 });
 it.each(['blocked','cancelled'])('audits an explicit explained %s disposition with preserved edges and actual actor/run',status=>{
  const prerequisite=assignment(),target=assignment([prerequisite.id]),manager=actor(),blockedReason='The retained prerequisite still requires an actual external outcome',rationale='Management intentionally preserves this prerequisite';
  const changed=store.command(manager,{type:'assignment.update',assignmentId:target.id,status,blockedReason,rationale});
  expect(changed.dependencyDecisions).toEqual([{actorId:ceo.id,runId:manager.runId,at:expect.any(String),rationale,priorDependencies:target.dependencies,dependencies:target.dependencies,priorStatus:'queued',status,blockedReason}]);expect(changed.acceptance).toEqual(target.acceptance);
 });
 it('preserves ordinary unexplained block behavior and does not create correction evidence from a reason-only edit',()=>{
  const target=assignment();store.command(owner,{type:'assignment.update',assignmentId:target.id,status:'blocked'});expect(store.need('assignments',target.id).dependencyDecisions).toBeUndefined();
  store.command(owner,{type:'assignment.update',assignmentId:target.id,blockedReason:'More precise existing blocker',rationale:'Ordinary reason-only correction'});expect(store.need('assignments',target.id).dependencyDecisions).toBeUndefined();
 });
 it('holds legacy missing prerequisites without preventing a separate eligible assignment claim',()=>{
  const waiting=store.update('assignments',assignment().id,{dependencies:['legacy-missing-assignment']});expect(store.claimNext({assignmentId:waiting.id})).toBeUndefined();
  const ready=assignment();expect(store.claimNext({assignmentId:ready.id})?.assignmentId).toBe(ready.id);
 });
});
