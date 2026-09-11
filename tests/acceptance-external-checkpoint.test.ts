import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isEmployeeAuthoredArtifact, verifyProjectCheckpoint, verifyReviewedExternalCheckpoint } from '../scripts/acceptance-evidence.js';
import { canonicalVerification } from '../src/tools/verification.js';
import * as processTools from '../src/tools/process.js';
import type { Artifact, CompanySnapshot } from '../src/core/types.js';

// Disposable Git/native-message/provider observations test rejection boundaries.
// They are never installed-company or real-model acceptance receipts.
describe('reviewed external candidate as second-project executable progress',()=>{
 let root:string;
 beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'opencorp-external-checkpoint-'));});
 afterEach(()=>{vi.restoreAllMocks();rmSync(root,{recursive:true,force:true});});
 function fixture(){
  const mirror=join(root,'repositories','product.git'),seed=join(root,'seed');mkdirSync(join(root,'repositories'),{recursive:true});mkdirSync(seed);
  const env={PATH:'/usr/bin:/bin',HOME:root,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'};
  execFileSync('/usr/bin/git',['init','--bare',mirror],{env,stdio:'pipe'});
  const git=(workspace:string,args:string[])=>execFileSync('/usr/bin/git',['--git-dir',mirror,'--work-tree',workspace,'-c','user.name=External fixture author','-c','user.email=external@localhost','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null',...args],{env,cwd:workspace,encoding:'utf8'}).trim();
  writeFileSync(join(seed,'code.js'),'export const value = 1;\n');git(seed,['add','code.js']);git(seed,['commit','-m','Baseline']);const base=git(seed,['rev-parse','HEAD']);
  writeFileSync(join(seed,'code.js'),'export const value = 2;\n');git(seed,['add','code.js']);git(seed,['commit','-m','External correction']);const head=git(seed,['rev-parse','HEAD']);
  const workspace=join(root,'workspaces',`pr-import-assignment-${head}`),branch=`opencorp-pr-import-assignment-${head}`;mkdirSync(join(root,'workspaces'));
  execFileSync('/usr/bin/git',['--git-dir',mirror,'worktree','add','-b',branch,workspace,head],{env,stdio:'pipe'});
  const gitDir=execFileSync('/usr/bin/git',['-C',workspace,'rev-parse','--absolute-git-dir'],{env,encoding:'utf8'}).trim();
  const diff=execFileSync('/usr/bin/git',['--git-dir',gitDir,'--work-tree',workspace,'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.sshCommand=false','-c','core.pager=cat','-c','diff.external=','-c','core.attributesFile=/dev/null','diff','--stat','--patch','--full-index','--no-ext-diff','--no-textconv',base,head,'--'],{env,encoding:'utf8'});
  const at=(second:number)=>new Date(Date.UTC(2026,8,11,0,0,second)).toISOString();
  const source={repository:'fixture/product',number:12,url:'https://github.com/fixture/product/pull/12',authorLogin:'external-contributor',baseRef:'main',baseSha:base,headRepository:'external/product',headRef:'fix',headSha:head,observedAt:at(0)};
  const physical={workspace,gitDir,mirror,branch,baseCommit:base},command=canonicalVerification('paletteWOW',workspace,base),logPath=join(root,'logs','verification','artifact.log'),dependencyReceipt=join(root,'runtime','dependency-environments','dependencies.json');
  mkdirSync(join(root,'logs','verification'),{recursive:true});mkdirSync(join(root,'runtime','dependency-environments'),{recursive:true});writeFileSync(logPath,'Disposable canonical-check output\n');writeFileSync(dependencyReceipt,JSON.stringify({installed:true,incrementalCost:0}));
  const check={source:'canonical-verifier',identity:head,command,status:'passed',exitCode:0,unchanged:true,dependencyReceipt,logPath,finishedAt:at(3)};
  const artifact={id:'artifact',createdAt:at(2),projectId:'second-project',employeeId:'importer',assignmentId:'import-assignment',runId:'import-run',kind:'commit',summary:'Verify existing correction for this finite product project',identity:head,baseCommit:base,uri:source.url,sourcePullRequest:source,reviewWorkspace:physical,checks:[check],verification:{runId:'import-run',identity:head,passed:true,receiptId:'canonical-receipt',command,exitCode:0,completedAt:at(3),logPath}} as unknown as Artifact;
  const review={id:'review',createdAt:at(8),artifactId:artifact.id,artifactIdentity:head,employeeId:'reviewer',runId:'review-run',verdict:'approved',rationale:'The inspected code changes the expected value; exact canonical checks pass.',checks:[check],projectAcceptance:[{criterion:'Establish whether the selected correction is verified',source:'artifact',evidence:'Inspected the complete one-line correction and canonical checks at the selected commit.'}]};
  const importRun:any={id:'import-run',createdAt:at(1),endedAt:at(5),employeeId:'importer',assignmentId:'import-assignment',workspace,status:'succeeded',sessionId:'import-session',modelIdentity:'local-model-identity',usage:{requests:2},corporateCommands:[{type:'artifact.record',id:artifact.id,at:at(2)}],verificationDependencies:{artifactId:artifact.id,installed:true,incrementalCost:0,receiptPath:dependencyReceipt}};
  const inspection={artifactId:artifact.id,base,head,contentIdentity:createHash('sha256').update(diff).digest('hex'),totalCharacters:diff.length,ranges:[[0,diff.length]],complete:true,inspectedAt:at(7)};
  const reviewRun:any={id:'review-run',createdAt:at(6),endedAt:at(9),employeeId:'reviewer',assignmentId:'review-assignment',workspace,status:'succeeded',sessionId:'review-session',modelIdentity:'local-model-identity',usage:{requests:2},corporateCommands:[{type:'review.record',id:review.id,at:at(8)}],artifactInspections:{[artifact.id]:inspection}};
  const state={company:{id:'disposable-test-company'},policy:{allowedRepositories:['/fixture/product']},products:[{id:'product',name:'paletteWOW',repository:'/fixture/product',binding:{repository:source.repository,defaultBranch:'main',mirror}}],projects:[{id:'second-project',name:'Assess the existing correction',productId:'product',outcome:'Resolve readiness of the selected correction',acceptance:[review.projectAcceptance[0].criterion],status:'active'}],assignments:[{id:'import-assignment',projectId:'second-project',employeeId:'importer',kind:'implementation',payload:{pullRequest:{number:12,headSha:head}},pullRequestCandidate:{assignmentId:'import-assignment',source:structuredClone(source),workspace:structuredClone(physical)}},{id:'review-assignment',projectId:'second-project',employeeId:'reviewer',kind:'review',payload:{artifactId:artifact.id}}],employees:[{id:'importer'},{id:'reviewer'}],artifacts:[artifact],runs:[importRun,reviewRun],reviews:[review]} as unknown as CompanySnapshot;
  state.projects.push({...state.projects[0],id:'first-delivered-project'});
  const part=(tool:string,input:any,output:any)=>({type:'tool',tool:`corporate_${tool}`,state:{status:'completed',input,output:JSON.stringify(output)}});
  const writeNative=(run:any,parts:any[])=>{
   const dir=join(root,'runtime','employees',run.id);mkdirSync(dir,{recursive:true});run.messagesPath=join(dir,'messages.json');
   writeFileSync(join(dir,'binding.json'),JSON.stringify({runId:run.id,employeeId:run.employeeId,sessionId:run.sessionId,workspace,model:{local:true,provider:'ollama',alias:'fixture-local',artifactIdentity:run.modelIdentity}}));
   writeFileSync(run.messagesPath,JSON.stringify([{info:{role:'assistant',sessionID:run.sessionId,providerID:'opencorp-local',modelID:'fixture-local',time:{completed:Date.parse(run.endedAt)}},parts}]));
  };
  writeNative(importRun,[part('import_pull_request',{summary:artifact.summary},{command:'artifact.record',id:artifact.id,identity:head}),part('verify_product',{artifactId:artifact.id},{...check,output:'Disposable canonical output'})]);
  writeNative(reviewRun,[part('inspect_artifact',{artifactId:artifact.id},{inspectionComplete:true,contentIdentity:inspection.contentIdentity,base,head}),part('review_work',{artifactId:artifact.id,verdict:'approved'},{command:'review.record',id:review.id,artifactIdentity:head})]);
  const live:any={number:12,html_url:source.url,user:{login:source.authorLogin},base:{ref:source.baseRef,sha:base,repo:{full_name:source.repository}},head:{ref:source.headRef,sha:head,repo:{full_name:source.headRepository}}};
  const checked=processTools.checked;vi.spyOn(processTools,'checked').mockImplementation(async(executable,args,options)=>{if(executable==='gh'){expect(args).toEqual(['api','repos/fixture/product/pulls/12']);return JSON.stringify(live);}return checked(executable,args,options);});
  const editMessages=(run:any,edit:(messages:any[])=>void)=>{const messages=JSON.parse(readFileSync(run.messagesPath,'utf8'));edit(messages);writeFileSync(run.messagesPath,JSON.stringify(messages));};
  return {state,artifact,review,importRun,reviewRun,live,workspace,check,editMessages,verify:()=>verifyReviewedExternalCheckpoint(state,artifact,{dataRoot:root,otherProjectId:'first-delivered-project'})};
 }
 it('accepts exact company-performed review progress while preserving external authorship and active project state',async()=>{
  const f=fixture(),before=structuredClone(f.state),result=await f.verify();
  expect(result).toMatchObject({projectId:'second-project',proof:{kind:'reviewed-external-candidate',checkpoint:'executable-progress',externallyAuthored:true,sourceAuthor:'external-contributor',importer:{employeeId:'importer'},verifier:{employeeId:'importer'},reviewer:{employeeId:'reviewer',reviewId:'review'}}});
  expect(f.state).toEqual(before);expect(result).not.toHaveProperty('mergeCommit');expect(f.state.projects[0].status).toBe('active');expect(isEmployeeAuthoredArtifact(f.artifact)).toBe(false);
  await expect(verifyProjectCheckpoint(f.state,f.artifact,{dataRoot:root})).rejects.toThrow(/employee-authored checkpoint/);
 });
 it('allows the independent reviewer to perform canonical verification in its own bound review run',async()=>{
  const f=fixture();f.artifact.verification.runId=f.reviewRun.id;f.artifact.verification.completedAt='2026-09-11T00:00:07.000Z';f.check.finishedAt=f.artifact.verification.completedAt;f.reviewRun.verificationDependencies=f.importRun.verificationDependencies;
  f.editMessages(f.reviewRun,messages=>messages[0].parts.unshift({type:'tool',tool:'corporate_verify_product',state:{status:'completed',input:{artifactId:f.artifact.id},output:JSON.stringify(f.check)}}));
  expect(await f.verify()).toMatchObject({proof:{verifier:{employeeId:'reviewer'},reviewer:{employeeId:'reviewer'},importer:{employeeId:'importer'}}});
 });
 it('permits review against a future delivery criterion without claiming the criterion or merge completed',async()=>{
  const f=fixture();f.state.projects[0].acceptance=['Merge the verified correction'];f.review.projectAcceptance=[{criterion:'Merge the verified correction',source:'delivery',evidence:'This exact candidate and passing checks support delivery; no merge has been observed.'}];
  const result=await f.verify();expect(result.proof.reviewer.reviewScope[0].source).toBe('delivery');expect(result).not.toHaveProperty('mergeCommit');expect(f.state.projects[0].status).toBe('active');
 });
 it.each(['null source','partial provenance','wrong candidate','wrong selection','wrong repository','wrong mirror','wrong base','wrong author','missing record','relabeled kind'] as const)('rejects %s',async fault=>{
  const f=fixture();
  if(fault==='null source')Object.assign(f.artifact,{sourcePullRequest:null});
  if(fault==='partial provenance')delete f.artifact.reviewWorkspace;
  if(fault==='wrong candidate')f.state.assignments[0].pullRequestCandidate.assignmentId='other';
  if(fault==='wrong selection')f.state.assignments[0].payload.pullRequest.headSha='a'.repeat(40);
  if(fault==='wrong repository')f.state.products[0].binding.repository='another/product';
  if(fault==='wrong mirror')f.state.products[0].binding.mirror=root;
  if(fault==='wrong base')f.artifact.baseCommit='b'.repeat(40);
  if(fault==='wrong author')f.artifact.employeeId='reviewer';
  if(fault==='missing record')f.state.artifacts=[];
  if(fault==='relabeled kind')f.artifact.kind='analysis';
  await expect(f.verify()).rejects.toThrow();
 });
 it.each(['copied session','wrong model','foreign messages','failed run','absent inference','missing import command','missing import tool','wrong verification run','old verification','invented command','failed checks','missing log','copied tool output','failed tool','wrong dependency'] as const)('rejects %s evidence',async fault=>{
  const f=fixture();
  if(fault==='copied session')f.editMessages(f.importRun,messages=>messages[0].info.sessionID='another-session');
  if(fault==='wrong model')f.editMessages(f.reviewRun,messages=>messages[0].info.providerID='hosted');
  if(fault==='foreign messages')f.importRun.messagesPath=f.reviewRun.messagesPath;
  if(fault==='failed run')f.importRun.status='failed';
  if(fault==='absent inference')f.reviewRun.usage.requests=0;
  if(fault==='missing import command')f.importRun.corporateCommands=[];
  if(fault==='missing import tool')f.editMessages(f.importRun,messages=>messages[0].parts.shift());
  if(fault==='wrong verification run')f.artifact.verification.runId='other-run';
  if(fault==='old verification')f.artifact.verification.completedAt='2026-09-10T00:00:00.000Z';
  if(fault==='invented command')f.artifact.verification.command='true';
  if(fault==='failed checks')f.check.status='failed';
  if(fault==='missing log')rmSync(f.artifact.verification.logPath);
  if(fault==='copied tool output')f.editMessages(f.importRun,messages=>messages[0].parts[1].state.output=JSON.stringify({...f.check,identity:'a'.repeat(40)}));
  if(fault==='failed tool')f.editMessages(f.importRun,messages=>messages[0].parts[1].state.status='error');
  if(fault==='wrong dependency')f.importRun.verificationDependencies.artifactId='other-artifact';
  await expect(f.verify()).rejects.toThrow();
 });
 it.each(['import alone','self review','wrong review target','wrong review assignment','historical checks','empty rationale','no criterion','wrong criterion','empty criterion evidence','partial inspection','wrong diff','missing inspect tool','missing review command'] as const)('rejects %s as meaningful reviewed progress',async fault=>{
  const f=fixture();
  if(fault==='import alone')f.state.reviews=[];
  if(fault==='self review')f.review.employeeId='importer';
  if(fault==='wrong review target')f.review.artifactIdentity='a'.repeat(40);
  if(fault==='wrong review assignment')f.state.assignments[1].payload.artifactId='other-artifact';
  if(fault==='historical checks')f.review.checks=[{...f.check,finishedAt:'2026-09-10T00:00:00.000Z'}];
  if(fault==='empty rationale')f.review.rationale=' ';
  if(fault==='no criterion')f.review.projectAcceptance=[];
  if(fault==='wrong criterion')f.review.projectAcceptance[0].criterion='Unrelated old goal';
  if(fault==='empty criterion evidence')f.review.projectAcceptance[0].evidence=' ';
  if(fault==='partial inspection')f.reviewRun.artifactInspections.artifact.ranges=[[1,3]];
  if(fault==='wrong diff')f.reviewRun.artifactInspections.artifact.contentIdentity='copied-other-diff';
  if(fault==='missing inspect tool')f.editMessages(f.reviewRun,messages=>messages[0].parts.shift());
  if(fault==='missing review command')f.reviewRun.corporateCommands=[];
  await expect(f.verify()).rejects.toThrow();
 });
 it.each(['head','base','author'] as const)('rejects live provider %s drift',async field=>{const f=fixture();if(field==='author')f.live.user.login='other-author';else f.live[field].sha='a'.repeat(40);await expect(f.verify()).rejects.toThrow(/Live PR .* changed/);});
 it('rejects local changes, foreign workspace links and reuse of the first project',async()=>{
  const f=fixture();writeFileSync(join(f.workspace,'code.js'),'Uncommitted source');await expect(f.verify()).rejects.toThrow(/dirty/);
  await expect(verifyReviewedExternalCheckpoint(f.state,f.artifact,{dataRoot:root,otherProjectId:'second-project'})).rejects.toThrow(/separate retained project/);
  const linked=join(root,'linked-workspace');symlinkSync(f.workspace,linked);f.artifact.reviewWorkspace!.workspace=linked;f.state.assignments[0].pullRequestCandidate.workspace.workspace=linked;await expect(f.verify()).rejects.toThrow();
 });
 it('does not claim a distinct second project before the first delivery project is identified',async()=>{const f=fixture();await expect(verifyReviewedExternalCheckpoint(f.state,f.artifact,{dataRoot:root})).rejects.toThrow(/retained first delivery project/);});
});
