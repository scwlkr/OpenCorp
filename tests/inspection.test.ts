import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyStore } from '../src/storage/store.js';
import { CorporateBroker } from '../src/tools/broker.js';
import type { Actor, Artifact, Project } from '../src/core/types.js';

const owner={kind:'owner'} as const,model='wlkr-management-qwen3.8-27b-q4-k-m:latest';
let root:string,store:CompanyStore,broker:CorporateBroker,project:Project,artifact:Artifact,actor:Extract<Actor,{kind:'employee'}>,originalId:string;
const git=(args:string[])=>execFileSync('/usr/bin/git',['--git-dir',project.gitDir,'--work-tree',project.workspace!,'-c','user.name=Inspection fixture','-c','user.email=fixture@localhost','-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{cwd:project.workspace,env:{PATH:'/usr/bin:/bin',HOME:root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},encoding:'utf8'}).trim();
function change(content:string){writeFileSync(join(project.workspace!,'source.txt'),content);git(['add','--all']);git(['commit','-m','Actual fixture change']);const identity=git(['rev-parse','HEAD']);artifact=store.update('artifacts',artifact.id,{identity,checks:[{source:'canonical-verifier',identity,status:'passed'}],verification:{identity,passed:true,receiptId:randomUUID()}});return identity;}
const inspect=(options:Record<string,any>={})=>broker.call(actor,'inspect_artifact',{artifactId:artifact.id,...options});
const review=()=>broker.call(actor,'review_work',{artifactId:artifact.id,verdict:'approved',rationale:'Inspected every exact diff page and actual fixture verifier receipt'});
beforeEach(()=>{
 root=mkdtempSync(join(tmpdir(),'opencorp-inspection-'));store=new CompanyStore(root);store.bootstrap();store.put('models',{name:model,artifactIdentity:'fixture-model',local:true,available:true,capabilities:['tools']});store.command(owner,{type:'control',action:'start'});broker=new CorporateBroker(store,root);
 const ceo=store.list('employees').find(e=>store.level(e.id)==='ceo')!,position=store.command(owner,{type:'position.create',title:'Author',level:'worker',responsibilities:'Produce useful code'}),worker=store.command(owner,{type:'employee.hire',name:'Author',positionId:position.id,homeManagerId:ceo.id,modelId:model});
 project=store.command(owner,{type:'project.create',name:'Independent review fixture',productId:store.list('products')[0].id,outcome:'Review exact source',acceptance:['All diff pages observed'],supervisorId:ceo.id,rationale:'Regression fixture'});
 project=store.update('projects',project.id,{workspace:join(root,'workspaces',project.id),gitDir:join(root,'repositories','fixture.git')});mkdirSync(project.workspace!,{recursive:true});mkdirSync(join(root,'repositories'),{recursive:true});execFileSync('/usr/bin/git',['init','--bare',project.gitDir],{stdio:'pipe'});writeFileSync(join(project.workspace!,'.git'),`gitdir: ${project.gitDir}\n`);
 writeFileSync(join(project.workspace!,'source.txt'),'Original baseline\n');git(['add','--all']);git(['commit','-m','Baseline']);project=store.update('projects',project.id,{baseCommit:git(['rev-parse','HEAD'])});
 const original=store.command(owner,{type:'assignment.create',employeeId:worker.id,projectId:project.id,title:'Author actual change',instructions:'Change source',acceptance:['Reviewed result'],kind:'implementation'});originalId=original.id;store.update('assignments',original.id,{status:'awaiting_review'});
 artifact=store.put('artifacts',{assignmentId:original.id,projectId:project.id,employeeId:worker.id,runId:'fixture-author-run',identity:project.baseCommit!,uri:'fixture-commit',kind:'commit',summary:'Actual source change',checks:[]});change('Useful corrected source\n');
 const task=store.command(owner,{type:'assignment.create',employeeId:ceo.id,projectId:project.id,title:'Independent review',instructions:'Inspect actual source',acceptance:['Complete inspection'],kind:'review',payload:{artifactId:artifact.id}}),run=store.put('runs',{employeeId:ceo.id,assignmentId:task.id,modelId:model,workspace:project.workspace,sessionId:randomUUID(),policyRevision:store.policy.revision,status:'running',attempt:1,heartbeatAt:new Date().toISOString(),leaseUntil:new Date(Date.now()+60000).toISOString(),tokenRevoked:false});actor={kind:'employee',employeeId:ceo.id,runId:run.id,policyRevision:store.policy.revision};
});
afterEach(async()=>{await broker.cancel();store.close();rmSync(root,{recursive:true,force:true});});

describe('complete exact-artifact inspection',()=>{
 it('finishes a normal small diff in one page but refuses legacy inspection claims',async()=>{
  store.update('runs',actor.runId,{inspectedArtifacts:[artifact.id],inspection:{artifactId:artifact.id,base:project.baseCommit,head:artifact.identity}});await expect(review()).rejects.toThrow(/every inspect_artifact page/);
  const page=await inspect();expect(page.diff).toContain('+Useful corrected source');expect(page).toMatchObject({offset:0,nextOffset:null,inspectionComplete:true,nextUninspectedOffset:null,base:project.baseCommit,head:artifact.identity});expect(page.contentIdentity).toBe(createHash('sha256').update(page.diff).digest('hex'));await review();expect(store.need('assignments',originalId).status).toBe('awaiting_review');
 });
 it('provides complete paged canonical check metadata behind an excerpted inspection summary',async()=>{
  const command='actual canonical argument '.repeat(1000),logPath='/owned/logs/'+ 'long-path-segment/'.repeat(100);artifact=store.update('artifacts',artifact.id,{checks:[{source:'canonical-verifier',identity:artifact.identity,status:'passed',command,logPath}],verification:{identity:artifact.identity,passed:true,receiptId:'fixture-canonical-receipt',command,logPath}});
  const inspection=await inspect();expect(inspection.artifact.checks.truncated).toBe(true);expect(JSON.stringify(inspection).length).toBeLessThanOrEqual(12000);let offset:number|null=0,content='';
  do{const page=await broker.call(actor,'company_detail',{...inspection.metadata,offset});content+=page.content;offset=page.nextOffset;}while(offset!==null);
  const full=JSON.parse(content);expect(full.checks[0]).toMatchObject({command,logPath,status:'passed'});expect(full.verification).toMatchObject({command,logPath,receiptId:'fixture-canonical-receipt'});
 });
 it('requires full coverage of a >120KB diff across repeated and out-of-order pages',async()=>{
  change('EARLY_REQUIRED_CHANGE\n'+'Unicode Ω changed source line\n'.repeat(6000)+'FINAL_REQUIRED_CHANGE\n');const full=await broker.workspaces.readDiff(project,project.baseCommit!,artifact.identity);expect(full.length).toBeGreaterThan(120000);
  const first=await inspect();expect(first.diff).toContain('EARLY_REQUIRED_CHANGE');expect(first.inspectionComplete).toBe(false);expect(JSON.stringify(first).length).toBeLessThanOrEqual(12000);await expect(review()).rejects.toThrow(/every inspect_artifact page/);
  const repeated=await inspect();expect(repeated.inspectedCharacters).toBe(first.inspectedCharacters);
  const last=await inspect({offset:full.length-1000});expect(last.diff).toContain('FINAL_REQUIRED_CHANGE');expect(last.nextOffset).toBeNull();expect(last.inspectionComplete).toBe(false);expect(last.nextUninspectedOffset).toBe(first.nextOffset);await expect(review()).rejects.toThrow(/every inspect_artifact page/);
  let page=last;while(!page.inspectionComplete){page=await inspect({offset:page.nextUninspectedOffset});expect(page.diff).toBe(full.slice(page.offset,page.offset+page.diff.length));expect(JSON.stringify(page).length).toBeLessThanOrEqual(12000);}
  const proof=store.need('runs',actor.runId).artifactInspections[artifact.id];expect(proof).toMatchObject({base:project.baseCommit,head:artifact.identity,contentIdentity:createHash('sha256').update(full).digest('hex'),totalCharacters:full.length,ranges:[[0,full.length]],complete:true});expect(page.inspectedCharacters).toBe(full.length);await review();expect(store.need('assignments',originalId).status).toBe('awaiting_review');
 });
 it('resets coverage for changed head/base and preserves existing evidence on invalid pages or oversized capture',async()=>{
  await inspect();const oldHead=artifact.identity;change('New actual source\n'.repeat(1000));await expect(review()).rejects.toThrow(/every inspect_artifact page/);
  await inspect({offset:6000,limit:100});let proof=store.need('runs',actor.runId).artifactInspections[artifact.id];expect(proof.ranges).toEqual([[6000,6100]]);expect(proof.complete).toBe(false);
  project=store.update('projects',project.id,{baseCommit:oldHead});await inspect({limit:100});proof=store.need('runs',actor.runId).artifactInspections[artifact.id];expect(proof.ranges).toEqual([[0,100]]);expect(proof.base).toBe(oldHead);
  await expect(inspect({offset:9999999})).rejects.toThrow(/Offset exceeds/);expect(store.need('runs',actor.runId).artifactInspections[artifact.id]).toEqual(proof);
  change('Oversized source line\n'.repeat(100000));await expect(inspect()).rejects.toThrow(/2000000-byte inspection limit/);expect(store.need('runs',actor.runId).artifactInspections[artifact.id]).toEqual(proof);expect(store.need('assignments',originalId).status).toBe('awaiting_review');await expect(review()).rejects.toThrow(/every inspect_artifact page/);
 });
 it('pages analysis artifacts and rejects changed narrative bytes without authorizing partial review',async()=>{
  const path=join(project.workspace!,'finding.md'),content='# Observed product finding\n'+'Actual source-linked observation.\n'.repeat(4000);writeFileSync(path,content);const identity=createHash('sha256').update(content).digest('hex');artifact=store.update('artifacts',artifact.id,{kind:'analysis',uri:path,identity,checks:[{source:'file-observation',identity,status:'observed'}]});
  let page=await inspect();expect(page.diff).toBe(content.slice(0,page.diff.length));expect(page.inspectionComplete).toBe(false);await expect(review()).rejects.toThrow(/every inspect_artifact page/);const proof=store.need('runs',actor.runId).artifactInspections[artifact.id];
  writeFileSync(path,content+'Unrecorded modification\n');await expect(inspect({offset:page.nextOffset})).rejects.toThrow(/no longer matches/);expect(store.need('runs',actor.runId).artifactInspections[artifact.id]).toEqual(proof);writeFileSync(path,content);
  while(!page.inspectionComplete)page=await inspect({offset:page.nextUninspectedOffset});expect(page.inspectedCharacters).toBe(content.length);await review();expect(store.need('assignments',originalId).status).toBe('awaiting_review');
 });
});


describe('full issue scope and immutable historical acceptance review',()=>{
 it('requires all live issue pages and checklist criteria before retaining exact issue acceptance',async()=>{
  const issue={repository:'fixture/product',number:7,title:'Actual full issue',body:'- [ ] Parser handles edge case\n'+'Source context '.repeat(800)+'\n- [ ] Release verified',identity:'exact-issue-digest',url:'https://github.com/fixture/product/issues/7',state:'open',observedAt:new Date().toISOString()};vi.spyOn(broker.github,'readIssue').mockResolvedValue(issue);
  await inspect();const input={artifactId:artifact.id,verdict:'approved',rationale:'Independently inspected source and checks',issueAcceptance:{issueNumber:7,issueIdentity:issue.identity,scopeRationale:'Entire source scope assessed, including release requirement',criteria:[{criterion:'Parser handles edge case',rationale:'Observed correction',evidence:'Exact source diff and canonical receipt'}]}};
  const first=await broker.call(actor,'repo_issue',{productId:project.productId,number:7,live:true});expect(first.inspectionComplete).toBe(false);await expect(broker.call(actor,'review_work',input)).rejects.toMatchObject({code:'issue_inspection_required'});
  await broker.call(actor,'repo_issue',{productId:project.productId,number:7,live:true,offset:first.nextUninspectedOffset});await expect(broker.call(actor,'review_work',input)).rejects.toMatchObject({code:'issue_criteria_incomplete'});
  input.issueAcceptance.criteria.push({criterion:'Release verified',rationale:'Actual retained release evidence inspected',evidence:'Actual fixture source and verification evidence'});await broker.call(actor,'review_work',input);
  expect(store.list('reviews')[0]?.issueAcceptance).toMatchObject({identity:issue.identity,body:issue.body,artifactIdentity:artifact.identity,reviewerId:actor.employeeId,runId:actor.runId,criteria:input.issueAcceptance.criteria});
 });
 it('keeps an earlier artifact diff and adds independent supplemental coverage after workspace baseline advances',async()=>{
  const base=project.baseCommit;artifact=store.update('artifacts',artifact.id,{baseCommit:base});await inspect();await review();const original=store.need('assignments',originalId),priorReview=store.list('reviews')[0];
  writeFileSync(join(project.workspace!,'source.txt'),'Subsequent milestone source\n');git(['add','--all']);git(['commit','-m','Subsequent work']);project=store.update('projects',project.id,{baseCommit:git(['rev-parse','HEAD'])});
  const task=store.command(owner,{type:'assignment.create',employeeId:actor.employeeId,projectId:project.id,title:'Assess exact prior acceptance',instructions:'Add truthful criterion mapping',acceptance:['Record actual coverage'],kind:'review',payload:{artifactId:artifact.id}}),oldRun=store.need('runs',actor.runId),next=store.put('runs',{...oldRun,id:undefined,sessionId:randomUUID(),assignmentId:task.id,artifactInspections:{},status:'running',tokenRevoked:false});actor={...actor,runId:next.id};
  const historical=await broker.call(actor,'company_detail',{collection:'artifacts',id:artifact.id});expect(historical.content).toContain('+Useful corrected source');expect(historical.content).not.toContain('Subsequent milestone');
  const page=await inspect();expect(page.base).toBe(base);expect(page.diff).toContain('+Useful corrected source');expect(page.diff).not.toContain('Subsequent milestone');
  await broker.call(actor,'review_work',{artifactId:artifact.id,verdict:'approved',rationale:'Retained exact artifact independently reassessed',supplementalAcceptance:true,projectAcceptance:[{criterion:'All diff pages observed',evidence:'Read the complete immutable diff, retained canonical receipts',source:'artifact'}]});
  expect(store.need('assignments',originalId)).toEqual(original);expect(store.need('reviews',priorReview.id)).toEqual(priorReview);expect(store.list('reviews')).toHaveLength(2);expect(store.need('assignments',task.id).status).toBe('completed');
 });
});
