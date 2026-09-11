import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CompanyStore} from '../src/storage/store.js';
import type {Actor,Assignment,Project} from '../src/core/types.js';

const owner={kind:'owner'} as const,head='a'.repeat(40),base='b'.repeat(40);
let root:string,store:CompanyStore,ceo:string,project:Project;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'opencorp-pr-domain-'));store=new CompanyStore(root);store.bootstrap();ceo=store.list('employees').find(e=>store.level(e.id)==='ceo')!.id;store.put('models',{name:store.need('employees',ceo).modelId,local:true,available:true,artifactIdentity:'disposable-domain-fixture-model',capabilities:['tools']});project=store.command(owner,{type:'project.create',productId:store.list('products')[0].id,name:'Explicit external source review',outcome:'Evaluate selected PR',acceptance:['Independent source evaluation'],rationale:'Observed product work',supervisorId:ceo});store.command(owner,{type:'control',action:'start'});});
afterEach(()=>{store.close();rmSync(root,{recursive:true,force:true});});
function assign(extra:Record<string,unknown>={}){return store.command(owner,{type:'assignment.create',projectId:project.id,employeeId:ceo,title:'Evaluate exact PR',instructions:'Import and verify the selected source',acceptance:['Exact candidate passes canonical checks'],kind:'implementation',payload:{pullRequest:{number:12,headSha:head}},...extra}) as Assignment;}
function active(assignment:Assignment){const run=store.claimNext({assignmentId:assignment.id,workspace:join(root,'workspaces','candidate')})!;store.bindSession(run.id,'isolated-fixture-session',run.workspace!);return {run,actor:{kind:'employee',employeeId:ceo,runId:run.id,policyRevision:store.policy.revision} as Actor};}
function prepared(assignment:Assignment,workspace:string){return {assignmentId:assignment.id,source:{repository:'fixture/product',number:12,url:'https://github.com/fixture/product/pull/12',authorLogin:'dependabot[bot]',baseRef:'main',baseSha:base,headRepository:'fixture/product',headRef:'dependabot/library',headSha:head,observedAt:'2026-09-11T00:00:00.000Z'},workspace:{workspace,gitDir:join(root,'repositories','fixture.git','worktrees','candidate'),mirror:join(root,'repositories','fixture.git'),branch:'fixture-candidate',baseCommit:base}};}

describe('explicit external PR assignment and retained source custody',()=>{
 it.each([{number:0,headSha:head},{number:12},{number:12,headSha:'unobserved-branch'},null])('rejects malformed source selection before creating an assignment',pullRequest=>{const before=store.list('assignments');expect(()=>assign({payload:{pullRequest}})).toThrow(/existing PR requires/);expect(store.list('assignments')).toEqual(before);});
 it('rejects source selection on company-only or nonimplementation assignments',()=>{
  expect(()=>assign({projectId:null})).toThrow(/existing PR requires/);expect(()=>assign({kind:'management'})).toThrow(/existing PR requires/);
  const author=store.list('employees').find(employee=>employee.id!==ceo)!,source=assign({employeeId:author.id}),artifact=store.put('artifacts',{assignmentId:source.id,projectId:project.id,employeeId:author.id,runId:'source-fixture-run',identity:head,uri:`git:${head}`,kind:'commit',summary:'Existing retained source',checks:[]});
  expect(()=>assign({kind:'review',payload:{artifactId:artifact.id,pullRequest:{number:12,headSha:head}}})).toThrow(/existing PR requires/);
 });
 it('retains the explicit finite acceptance and exact source without changing project acceptance',()=>{const before=structuredClone(project),assignment=assign();expect(assignment).toMatchObject({payload:{pullRequest:{number:12,headSha:head}},acceptance:['Exact candidate passes canonical checks']});expect(store.need('projects',project.id)).toEqual(before);});
 it('records importer custody separately from external source and reuses immutable imported evidence',()=>{
  const assignment=assign(),{run,actor}=active(assignment),candidate=prepared(assignment,run.workspace!);store.update('assignments',assignment.id,{pullRequestCandidate:candidate});
  const artifact=store.recordPullRequestArtifact(actor,'Imported exact dependency candidate');expect(artifact).toMatchObject({employeeId:ceo,runId:run.id,identity:head,baseCommit:base,sourcePullRequest:candidate.source,reviewWorkspace:candidate.workspace,checks:[]});expect(store.need('assignments',assignment.id).status).toBe('awaiting_review');
  expect(store.recordPullRequestArtifact(actor,'A later summary')).toEqual(artifact);expect(store.list('artifacts')).toHaveLength(1);expect(store.hasApprovedArtifact(assignment.id,head)).toBe(false);
 });
 it('rolls back custody, assignment transition and command receipts when source provenance cannot be retained',async()=>{
  const assignment=assign(),{run,actor}=active(assignment);store.update('assignments',assignment.id,{pullRequestCandidate:prepared(assignment,run.workspace!)});await Promise.resolve();
  const events:string[]=[];store.events.on('event',event=>events.push(event.type));
  store.db.exec("CREATE TRIGGER reject_import_source BEFORE UPDATE ON artifacts BEGIN SELECT RAISE(ABORT,'fixture provenance write failed'); END;");
  expect(()=>store.recordPullRequestArtifact(actor,'Candidate import')).toThrow(/fixture provenance write failed/);await Promise.resolve();
  expect(store.list('artifacts')).toEqual([]);expect(store.need('assignments',assignment.id).status).toBe('running');expect(store.need('runs',run.id).corporateCommands??[]).toEqual([]);expect(events).not.toContain('artifact.record');
 });
 it.each(['absent','wrong assignment','wrong head','wrong workspace'] as const)('denies %s candidate preparation without recording a fabricated import',field=>{
  const assignment=assign(),{run,actor}=active(assignment),candidate=prepared(assignment,run.workspace!);
  if(field==='wrong assignment')candidate.assignmentId='another-assignment';if(field==='wrong head')candidate.source.headSha=base;if(field==='wrong workspace')candidate.workspace.workspace='/unrelated';
  if(field!=='absent')store.update('assignments',assignment.id,{pullRequestCandidate:candidate});expect(()=>store.recordPullRequestArtifact(actor,'Unqualified import')).toThrow(/prepared exact assigned PR/);expect(store.list('artifacts')).toEqual([]);expect(store.need('assignments',assignment.id).status).toBe('running');
 });
});
