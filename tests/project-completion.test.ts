import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CompanyStore } from '../src/storage/store.js';
import type { Actor, Employee, Project } from '../src/core/types.js';

// Isolated domain fixtures, not evidence of real company/product acceptance.
const owner={kind:'owner'} as const,model='wlkr-management-qwen3.8-27b-q4-k-m:latest';
const criteria=['Document onboarding','Merge the onboarding change','Publish version 1.2.3'];
let root:string,store:CompanyStore,project:Project,manager:Employee,worker:Employee,managerActor:Actor;
function actor(employee:Employee,assignmentId:string):Extract<Actor,{kind:'employee'}>{
 const run=store.put('runs',{employeeId:employee.id,assignmentId,modelId:model,policyRevision:store.policy.revision,workspace:root,sessionId:randomUUID(),status:'running',attempt:1,heartbeatAt:new Date().toISOString(),leaseUntil:new Date(Date.now()+60000).toISOString(),tokenRevoked:false});
 return {kind:'employee',employeeId:employee.id,runId:run.id,policyRevision:store.policy.revision};
}
function assignment(employee:Employee,projectId?:string,kind='management',payload={}){return store.command(owner,{type:'assignment.create',employeeId:employee.id,supervisorId:manager.id,projectId,title:'Fixture assigned outcome',instructions:'Inspect and fulfill the narrow assigned outcome',acceptance:['Actual independently reviewed work'],kind,payload});}
function work(target=project){
 const authorAssignment=assignment(worker,target.id,'implementation'),author=actor(worker,authorAssignment.id),identity=randomUUID(),checks=[{source:'canonical-verifier',identity,status:'passed'}];
 const artifact=store.command(author,{type:'artifact.record',kind:'commit',identity,uri:'fixture-owned-commit',summary:'A narrow onboarding correction',checks});store.update('artifacts',artifact.id,{verification:{passed:true,identity,receiptId:randomUUID()}});
 const reviewAssignment=assignment(manager,target.id,'review',{artifactId:artifact.id}),reviewActor=actor(manager,reviewAssignment.id);
 const review=(projectAcceptance?:any[],verdict='approved',extra:any={})=>{
  if(verdict==='approved'&&!extra.supplementalAcceptance&&!store.need('assignments',authorAssignment.id).completionRequirements)store.command(managerActor,{type:'assignment.update',assignmentId:authorAssignment.id,completionRequirements:[{criterion:authorAssignment.acceptance[0],source:'artifact'}],rationale:'Fixture assignment is only the reviewed source artifact, distinct from broader project conditions'});
  const result=store.command(reviewActor,{type:'review.record',artifactId:artifact.id,artifactIdentity:identity,verdict,rationale:'Independent inspection of exact changed source and checks',checks,...(verdict==='approved'?{assignmentAcceptance:[{criterion:authorAssignment.acceptance[0],source:'artifact',evidence:'The exact fixture source artifact fulfills this narrow assignment'}]}:{}),...(projectAcceptance===undefined?{}:{projectAcceptance}),...extra});
  if(verdict==='approved'&&!extra.supplementalAcceptance)store.command(managerActor,{type:'assignment.update',assignmentId:authorAssignment.id,status:'completed',completionEvidence:[{criterion:authorAssignment.acceptance[0],rationale:'Observed independently reviewed narrow source',sources:[{type:'artifact',id:artifact.id}]}],rationale:'Complete the narrow fixture assignment with exact evidence'});return result;
 };
 return {artifact,review,reviewActor,authorAssignment,reviewAssignment};
}
const coverage=(criterion:string,source='artifact',version?:string)=>({criterion,source,evidence:'Independent reviewer inspected the exact artifact and the stated source condition',...(version?{version}:{})});
const evidence=(criterion:string,type:string,id:string)=>({criterion,rationale:'Observed outcome satisfies the criterion through the cited independent assessment',sources:[{type,id}]});
function update(completionEvidence?:any[],status?:string){return store.command(managerActor,{type:'project.update',projectId:project.id,rationale:'Assess the actual retained acceptance outcomes',...(completionEvidence===undefined?{}:{completionEvidence}),...(status?{status}:{})});}
function only(acceptance:string[]){store.command(owner,{type:'project.update',projectId:project.id,acceptance,rationale:'Fixture finite criterion selection'});}
function delivered(artifact:any){return {artifactId:artifact.id,identity:artifact.identity,state:'merged',mergeCommit:`merged-${artifact.id}`,defaultBranchHead:`default-${artifact.id}`,prUrl:`https://github.com/fixture/product/pull/${artifact.id}`,prNumber:1,deliveredAt:new Date().toISOString()};}
beforeEach(()=>{
 root=mkdtempSync(join(tmpdir(),'opencorp-project-completion-'));store=new CompanyStore(root);store.bootstrap();store.put('models',{name:model,local:true,available:true,artifactIdentity:'fixture-local-model'});store.command(owner,{type:'control',action:'start'});
 manager=store.list('employees').find(e=>store.level(e.id)==='ceo')!;const position=store.command(owner,{type:'position.create',title:'Product specialist',level:'worker',responsibilities:'Deliver bounded verified changes'});worker=store.command(owner,{type:'employee.hire',name:'Fixture author',positionId:position.id,homeManagerId:manager.id,modelId:model});
 managerActor=actor(manager,assignment(manager).id);project=store.command(owner,{type:'project.create',name:'Multi-milestone product outcome',productId:store.list('products')[0].id,outcome:'Documentation, delivered change and a real release',acceptance:[...criteria],supervisorId:manager.id,rationale:'Fixture intentionally includes independently observable milestones'});
});
afterEach(()=>{store.close();rmSync(root,{recursive:true,force:true});});

describe('truthful project completion',()=>{
 it('keeps a broad project active after a partial reviewed artifact, retaining partial evidence only when explicitly recorded',()=>{
  const {artifact,review}=work(),reviewed=review([coverage(criteria[0])]),partial=[evidence(criteria[0],'artifact',artifact.id)];
  expect(()=>update(undefined,'completed')).toThrow(/evidence is required/);expect(()=>update(partial,'completed')).toThrow(/Merge the onboarding change/);expect(store.need('projects',project.id).completionEvidence).toBeUndefined();
  const progress=update(partial);expect(progress.status).toBe('active');expect(progress.completionEvidence[0].sources[0]).toMatchObject({id:artifact.id,reviewId:reviewed.id,identity:artifact.identity});
  expect(()=>update([...partial,evidence(criteria[1],'artifact',artifact.id),evidence(criteria[2],'artifact',artifact.id)],'completed')).toThrow(/explicitly map artifact evidence/);expect(store.need('projects',project.id).status).toBe('active');
 });
 it('requires explicit independent criterion coverage but does not require full-project coverage to approve a narrow assignment',()=>{
  only([criteria[0]]);const {artifact,review,authorAssignment}=work();review();expect(store.need('assignments',authorAssignment.id).status).toBe('completed');expect(()=>update([evidence(criteria[0],'artifact',artifact.id)],'completed')).toThrow(/criterion/);
 });
 it('allows responsible management to complete fully evidenced current criteria without Owner approval',()=>{
  only([criteria[0]]);const {artifact,review}=work(),reviewed=review([coverage(criteria[0])]);const completed=update([evidence(criteria[0],'artifact',artifact.id)],'completed');
  expect(completed.status).toBe('completed');expect(completed.completion).toMatchObject({actorId:manager.id,runId:managerActor.kind==='employee'?managerActor.runId:null,acceptance:[criteria[0]]});expect(completed.completionEvidence[0].sources[0].reviewId).toBe(reviewed.id);
  expect(()=>update([])).toThrow(/evidence is required/);expect(store.need('projects',project.id).status).toBe('completed');
 });
 it('validates review criterion scope, explicit evidence and expected release version before recording coverage',()=>{
  const {review,artifact}=work();
  expect(()=>review([coverage('Unrecorded criterion')])).toThrow(/exact current project criterion/);expect(()=>review([{criterion:criteria[0],source:'artifact',evidence:''}])).toThrow(/Independent criterion evidence/);expect(()=>review([coverage(criteria[2],'release')])).toThrow(/expected release version/);expect(()=>review([coverage(criteria[0])],'changes_requested')).toThrow(/Only approved/);
  expect(store.list('reviews').filter(r=>r.artifactId===artifact.id)).toEqual([]);review([coverage(criteria[0])]);
 });
 it('requires an actual confirmed merge for delivery coverage, including default-branch ancestry',()=>{
  only([criteria[1]]);const {artifact,review}=work();review([coverage(criteria[1],'delivery')]);const proof=[evidence(criteria[1],'delivery',artifact.id)];expect(()=>update(proof,'completed')).toThrow(/observed exact-artifact merge/);
  const receipt=delivered(artifact);store.update('projects',project.id,{delivery:{...receipt,defaultBranchHead:null}});expect(()=>update(proof,'completed')).toThrow(/default-branch ancestry/);
  store.update('projects',project.id,{delivery:receipt});expect(update(proof,'completed').completionEvidence[0].sources[0]).toMatchObject({mergeCommit:receipt.mergeCommit,url:receipt.prUrl});
 });
 it('accepts retained per-artifact delivery history after a later project delivery',()=>{
  only([criteria[1]]);const first=work();first.review([coverage(criteria[1],'delivery')]);const second=work();second.review();store.update('projects',project.id,{delivery:delivered(second.artifact),deliveryHistory:[delivered(first.artifact),delivered(second.artifact)]});
  expect(update([evidence(criteria[1],'delivery',first.artifact.id)],'completed').status).toBe('completed');
 });
 it('requires the independently reviewed release version and actual published package/provider evidence',()=>{
  only([criteria[2]]);const {artifact,review}=work();review([coverage(criteria[2],'release','1.2.3')]);const receipt=delivered(artifact);store.update('projects',project.id,{delivery:receipt});
  const release=store.put('artifacts',{kind:'release-package',assignmentId:assignment(manager).id,projectId:project.id,employeeId:manager.id,runId:managerActor.kind==='employee'?managerActor.runId:'',identity:'fixture-package-digest',packageDigest:'fixture-package-digest',sourceArtifactId:artifact.id,sourceCommit:receipt.mergeCommit,version:'1.2.2',releaseState:'ready',remoteRef:'https://github.com/fixture/product/releases/tag/1.2.3',assets:[{name:'fixture-asset',sha256:'fixture-hash'}],checks:[{source:'release-verifier',status:'passed',identity:receipt.mergeCommit,version:'1.2.3'}],uri:'fixture-manifest',summary:'Isolated release fixture'}),proof=[evidence(criteria[2],'release',release.id)];
  expect(()=>update(proof,'completed')).toThrow(/explicitly map release evidence/);store.update('artifacts',release.id,{version:'1.2.3'});expect(()=>update(proof,'completed')).toThrow(/observed published provider receipt/);
  store.update('artifacts',release.id,{releaseState:'published',publishedAt:new Date().toISOString()});expect(()=>update(proof,'completed')).toThrow(/observed published provider receipt/);
  const action=store.put('actions',{kind:'release',dedupeKey:`release:${release.id}:publish`,status:'succeeded',artifactId:artifact.id,artifactIdentity:artifact.identity,remoteRef:release.remoteRef});
  expect(update(proof,'completed').completionEvidence[0].sources[0]).toMatchObject({version:'1.2.3',actionId:action.id,sourceArtifactId:artifact.id});
 });
 it('clears obsolete coverage and reopens completion when current acceptance changes, preserving history',()=>{
  only([criteria[0]]);const {artifact,review}=work();review([coverage(criteria[0])]);update([evidence(criteria[0],'artifact',artifact.id)],'completed');
  const revised=store.command(managerActor,{type:'project.update',projectId:project.id,acceptance:[criteria[0],criteria[1]],rationale:'A newly recorded actual delivery condition remains unmet'});expect(revised.status).toBe('active');expect(revised.completionEvidence).toEqual([]);expect(revised.completion).toBeNull();expect(revised.acceptanceHistory.at(-1).acceptance).toEqual([criteria[0]]);expect(revised.completionHistory.at(-1).evidence[0].criterion).toBe(criteria[0]);
  expect(()=>update([evidence(criteria[0],'artifact',artifact.id)],'completed')).toThrow(/Merge the onboarding change/);
 });
 it('denies unrelated project evidence and ignores caller claims about review identities',()=>{
  only([criteria[0]]);const other=store.command(owner,{type:'project.create',name:'Other outcome',productId:project.productId,outcome:'Separate responsibility',acceptance:[criteria[0]],supervisorId:manager.id,rationale:'Fixture isolation'}),{artifact,review}=work(other);review([coverage(criteria[0])]);const own=work();own.review();
  expect(()=>update([evidence(criteria[0],'artifact',artifact.id)])).toThrow(/belong to this project/);const forged=evidence(criteria[0],'artifact',own.artifact.id);Object.assign(forged.sources[0],{reviewId:store.list('reviews')[0].id});expect(()=>update([forged])).toThrow(/independent exact-artifact review/);
 });
 it('refuses duplicate criteria, superseded unpublished artifacts and invalidated canonical evidence',()=>{
  only([criteria[0]]);const {artifact,review}=work();review([coverage(criteria[0])]);const proof=evidence(criteria[0],'artifact',artifact.id);
  expect(()=>update([proof,proof],'completed')).toThrow(/distinct exact/);store.update('artifacts',artifact.id,{verification:{passed:false,identity:artifact.identity,receiptId:'retained-failed-recheck'}});expect(()=>update([proof],'completed')).toThrow(/passing canonical verification/);
  store.update('artifacts',artifact.id,{verification:{passed:true,identity:artifact.identity,receiptId:'fixture-recheck'}});store.put('artifacts',{...artifact,id:undefined,identity:'new-unreviewed-identity'});expect(()=>update([proof],'completed')).toThrow(/superseded/);
 });
 it('does not bypass unfinished assignments even when every criterion has reviewed evidence',()=>{
  only([criteria[0]]);const {artifact,review}=work();review([coverage(criteria[0])]);assignment(worker,project.id,'implementation');expect(()=>update([evidence(criteria[0],'artifact',artifact.id)],'completed')).toThrow(/Complete and review project assignments/);
 });
 it('retains broker issue acceptance only for the exact approved independent review identity',()=>{
  const {artifact,review,reviewActor}=work(),issueAcceptance={reviewerId:reviewActor.employeeId,runId:reviewActor.runId,artifactId:artifact.id,artifactIdentity:artifact.identity,repository:'fixture/product',number:7,identity:'fixture-live-issue-hash',criteria:[{criterion:'Actual issue condition',evidence:'Inspected source',rationale:'Exact change fulfills condition'}]};
  expect(()=>review(undefined,'approved',{issueAcceptance:{...issueAcceptance,reviewerId:worker.id}})).toThrow(/this approved independent broker review/);
  const retained=review(undefined,'approved',{issueAcceptance});expect(retained.issueAcceptance).toEqual(issueAcceptance);
 });
 it('adds missing acceptance through a new independent supplemental review without rewriting completed work',()=>{
  only([criteria[1]]);const {artifact,review,authorAssignment}=work(),first=review();store.update('projects',project.id,{delivery:delivered(artifact)});const original=store.need('assignments',authorAssignment.id);
  expect(()=>review([coverage(criteria[1],'delivery')],'approved',{supplementalAcceptance:true})).toThrow(/new independent review assignment/);
  const task=assignment(manager,project.id,'review',{artifactId:artifact.id}),reviewer=actor(manager,task.id),input={type:'review.record',artifactId:artifact.id,artifactIdentity:artifact.identity,verdict:'approved',rationale:'New independent review of preserved exact source and actual delivery',checks:artifact.checks,projectAcceptance:[coverage(criteria[1],'delivery')]};
  expect(()=>store.command(reviewer,input)).toThrow(/not awaiting review/);expect(()=>store.command(reviewer,{...input,supplementalAcceptance:true,projectAcceptance:[]})).toThrow(/explicit criterion/);expect(()=>store.command(reviewer,{...input,supplementalAcceptance:true,verdict:'changes_requested'})).toThrow(/approved evidence verdict/);
  const supplemental=store.command(reviewer,{...input,supplementalAcceptance:true});expect(supplemental.supplementalAcceptance).toBe(true);expect(store.need('reviews',first.id)).toEqual(first);expect(store.need('assignments',authorAssignment.id)).toEqual(original);expect(store.need('assignments',task.id).status).toBe('completed');
  const completed=update([evidence(criteria[1],'delivery',artifact.id)],'completed');expect(completed.completionEvidence[0].sources[0].reviewId).toBe(supplemental.id);
 });
 it('does not allow supplemental acceptance to approve previously unreviewed work',()=>{
  const {review}=work();expect(()=>review([coverage(criteria[0])],'approved',{supplementalAcceptance:true})).toThrow(/already approved artifact/);expect(store.list('reviews')).toEqual([]);
 });
});
