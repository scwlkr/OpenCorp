import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyAuthoredDeliveryProvenance } from '../scripts/acceptance-evidence.js';
import { canonicalVerification } from '../src/tools/verification.js';
import type { Artifact, CompanySnapshot } from '../src/core/types.js';

// Synthetic receipts exercise proof rejection only; no model/provider/product
// work is claimed. The immutable source and worktree are real disposable Git.
describe('retained employee-authored commit after a failed or interrupted turn',()=>{
 let root:string;
 beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'opencorp-author-recovery-'));});
 afterEach(()=>rmSync(root,{recursive:true,force:true}));
 function fixture(status='failed',productName='paletteWOW'){
  const mirror=join(root,'repositories','product.git'),seed=join(root,'seed'),workspace=join(root,'workspaces','project');mkdirSync(join(root,'repositories'),{recursive:true});mkdirSync(seed);mkdirSync(join(root,'workspaces'));
  const env={PATH:'/usr/bin:/bin',HOME:root,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'};
  execFileSync('/usr/bin/git',['init','--bare',mirror],{env,stdio:'pipe'});
  const git=(args:string[])=>execFileSync('/usr/bin/git',['--git-dir',mirror,'--work-tree',seed,'-c','user.name=Disposable employee','-c','user.email=fixture@localhost','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null',...args],{cwd:seed,env,encoding:'utf8'}).trim();
  mkdirSync(join(seed,'.github','workflows'),{recursive:true});writeFileSync(join(seed,'.github','workflows','ci.yml'),'jobs:\n  test:\n    env:\n      WALK_RELEASE_VERSION: v6.4.0\n');
  writeFileSync(join(seed,'code.js'),'export const value=1;\n');git(['add','--all']);git(['commit','-m','Baseline']);const base=git(['rev-parse','HEAD']);
  writeFileSync(join(seed,'code.js'),'export const value=2;\n');git(['add','--all']);git(['commit','-m','Employee correction']);const head=git(['rev-parse','HEAD']);
  execFileSync('/usr/bin/git',['--git-dir',mirror,'worktree','add','-b','opencorp-project',workspace,head],{env,stdio:'pipe'});
  const gitDir=execFileSync('/usr/bin/git',['-C',workspace,'rev-parse','--absolute-git-dir'],{env,encoding:'utf8'}).trim();
  const at=(second:number)=>new Date(Date.UTC(2026,8,11,0,0,second)).toISOString();
  const logPath=join(root,'logs','verification','artifact.log'),dependencyReceipt=join(root,'runtime','dependency-environments','prepared.json');mkdirSync(join(root,'logs','verification'),{recursive:true});mkdirSync(join(root,'runtime','dependency-environments'),{recursive:true});writeFileSync(logPath,'Disposable passing canonical execution log\n');writeFileSync(dependencyReceipt,JSON.stringify({installed:true,incrementalCost:0}));
  const command=canonicalVerification(productName,workspace,base),check={source:'canonical-verifier',identity:head,command,status:'passed',exitCode:0,unchanged:true,logPath,dependencyReceipt,finishedAt:at(8)};
  const artifact={id:'artifact',projectId:'project',assignmentId:'assignment',employeeId:'author',runId:'author-run',kind:'commit',identity:head,baseCommit:base,uri:`https://github.com/fixture/product/commit/${head}`,summary:'An actual employee commit',createdAt:at(2),checks:[check],verification:{runId:'verify-run',identity:head,passed:true,receiptId:'receipt',command,exitCode:0,completedAt:at(8),logPath}} as unknown as Artifact;
  const author:any={id:'author-run',employeeId:'author',assignmentId:'assignment',status,createdAt:at(1),endedAt:at(4),workspace,sessionId:'author-session',modelId:'local-model',modelIdentity:'local-model-identity',usage:{requests:2},corporateCommands:[{type:'artifact.record',id:artifact.id,at:artifact.createdAt}]};
  const verifier:any={id:'verify-run',employeeId:'author',assignmentId:'assignment',status:'succeeded',createdAt:at(6),endedAt:at(9),workspace,sessionId:'verify-session',modelId:'local-model',modelIdentity:'local-model-identity',usage:{requests:2},verificationDependencies:{installed:true,incrementalCost:0,artifactId:artifact.id,receiptPath:dependencyReceipt}};
  const state={company:{id:'disposable-company'},policy:{allowedRepositories:['/fixture/product']},products:[{id:'product',name:productName,repository:'/fixture/product',binding:{repository:'fixture/product',mirror}}],projects:[{id:'project',productId:'product',workspace,gitDir,mirror}],assignments:[{id:'assignment',kind:'implementation',employeeId:'author',projectId:'project',payload:{}}],employees:[{id:'author'},{id:'reviewer'}],runs:[author,verifier],artifacts:[artifact]} as unknown as CompanySnapshot;
  const tool=(name:string,input:any,output:any)=>({type:'tool',tool:`corporate_${name}`,state:{status:'completed',input,output:JSON.stringify(output)}});
  const writeNative=(run:any,parts:any[])=>{const dir=join(root,'runtime','employees',run.id);mkdirSync(dir,{recursive:true});run.messagesPath=join(dir,'messages.json');writeFileSync(join(dir,'binding.json'),JSON.stringify({runId:run.id,employeeId:run.employeeId,sessionId:run.sessionId,workspace,model:{local:true,provider:'ollama',artifactIdentity:run.modelIdentity,alias:'local-model'}}));writeFileSync(run.messagesPath,JSON.stringify([{info:{role:'assistant',sessionID:run.sessionId,providerID:'opencorp-local',modelID:'local-model',time:{completed:Date.parse(run.endedAt)}},parts}]));};
  writeNative(author,[tool('commit_work',{summary:artifact.summary},artifact)]);writeNative(verifier,[tool('verify_product',{artifactId:artifact.id},check)]);
  const editMessages=(run:any,edit:(messages:any[])=>void)=>{const messages=JSON.parse(readFileSync(run.messagesPath,'utf8'));edit(messages);writeFileSync(run.messagesPath,JSON.stringify(messages));};
  const editBinding=(run:any,edit:(binding:any)=>void)=>{const path=join(root,'runtime','employees',run.id,'binding.json'),binding=JSON.parse(readFileSync(path,'utf8'));edit(binding);writeFileSync(path,JSON.stringify(binding));};
  return {state,artifact,author,verifier,check,workspace,writeNative,editMessages,editBinding,verify:()=>verifyAuthoredDeliveryProvenance(state,artifact,{dataRoot:root})};
 }
 it.each(['failed','interrupted','succeeded'])('retains true author status %s with exact completed commit and later successful verifier evidence',async status=>{
  const f=fixture(status),before=structuredClone(f.state),proof=await f.verify();expect(proof).toMatchObject({author:{runId:f.author.id,status},verifier:{runId:f.verifier.id,status:'succeeded'},identity:f.artifact.identity,baseCommit:f.artifact.baseCommit});expect(f.state).toEqual(before);expect(proof).not.toHaveProperty('mergeCommit');expect(proof).not.toHaveProperty('reviewId');
 });
 it('allows a different employee to verify retained work after reassignment without changing historical authorship',async()=>{
  const f=fixture();f.state.assignments[0].employeeId='reviewer';f.verifier.employeeId='reviewer';f.editBinding(f.verifier,b=>b.employeeId='reviewer');
  expect(await f.verify()).toMatchObject({author:{employeeId:'author',status:'failed'},verifier:{employeeId:'reviewer',status:'succeeded'}});
 });
 it('allows exact canonical verification in the separately assigned reviewer run',async()=>{
  const f=fixture();f.state.assignments.push({id:'review-assignment',projectId:'project',kind:'review',employeeId:'reviewer',payload:{artifactId:f.artifact.id}} as any);f.verifier.assignmentId='review-assignment';f.verifier.employeeId='reviewer';f.editBinding(f.verifier,b=>b.employeeId='reviewer');expect((await f.verify()).verifier.employeeId).toBe('reviewer');
 });
 it('keeps an ordinary successful author-and-verifier run valid',async()=>{
  const f=fixture('succeeded');f.author.endedAt=f.verifier.endedAt;f.author.verificationDependencies=f.verifier.verificationDependencies;f.artifact.verification.runId=f.author.id;
  f.editMessages(f.author,messages=>messages[0].parts.push({type:'tool',tool:'corporate_verify_product',state:{status:'completed',input:{artifactId:f.artifact.id},output:JSON.stringify(f.check)}}));expect((await f.verify()).verifier.runId).toBe(f.author.id);
 });
 it('uses the authored workflow version even after the project workspace advances',async()=>{
  const f=fixture('failed','WalkLang');writeFileSync(join(f.workspace,'.github','workflows','ci.yml'),'jobs:\n  test:\n    env:\n      WALK_RELEASE_VERSION: v9.9.9\n');const proof=await f.verify();expect(proof.verification.command).toContain("WALK_VERSION='v6.4.0'");expect(proof.verification.command).toBe(f.check.command);
 });
 it.each(['running author','uncertain author','owner author','missing employee','missing artifact','wrong assignment','wrong project','wrong mirror','wrong source','empty diff','import marker','null import marker','malformed workspace marker','candidate assignment','PR selection'] as const)('rejects %s',async fault=>{
  const f=fixture();
  if(fault==='running author')f.author.status='running';if(fault==='uncertain author')f.author.status='uncertain';
  if(fault==='owner author'){f.author.employeeId='owner';f.artifact.employeeId='owner';f.state.employees.push({id:'owner'} as any);}
  if(fault==='missing employee')f.state.employees=[];if(fault==='missing artifact')f.state.artifacts=[];if(fault==='wrong assignment')f.author.assignmentId='other';if(fault==='wrong project')f.state.assignments[0].projectId='other';if(fault==='wrong mirror')f.state.projects[0].mirror=root;if(fault==='wrong source')f.artifact.uri='https://github.com/other/product/commit/'+f.artifact.identity;if(fault==='empty diff')f.artifact.baseCommit=f.artifact.identity;
  if(fault==='import marker')f.artifact.sourcePullRequest={headSha:f.artifact.identity} as any;if(fault==='null import marker')Object.assign(f.artifact,{sourcePullRequest:null});if(fault==='malformed workspace marker')Object.assign(f.artifact,{reviewWorkspace:null});if(fault==='candidate assignment')Object.assign(f.state.assignments[0],{pullRequestCandidate:null});if(fault==='PR selection')f.state.assignments[0].payload.pullRequest={number:1,headSha:f.artifact.identity};await expect(f.verify()).rejects.toThrow();
 });
 it.each(['no command','no commit tool','incomplete commit','wrong commit result','import tool','hosted binding','copied session','wrong provider','foreign messages','missing inference','commit outside author time'] as const)('rejects %s authorship',async fault=>{
  const f=fixture();if(fault==='no command')f.author.corporateCommands=[];if(fault==='no commit tool')f.editMessages(f.author,m=>m[0].parts=[]);if(fault==='incomplete commit')f.editMessages(f.author,m=>m[0].parts[0].state.status='error');if(fault==='wrong commit result')f.editMessages(f.author,m=>m[0].parts[0].state.output=JSON.stringify({...f.artifact,identity:'a'.repeat(40)}));if(fault==='import tool')f.editMessages(f.author,m=>m[0].parts[0].tool='corporate_import_pull_request');if(fault==='hosted binding')f.editBinding(f.author,b=>b.model.provider='hosted');if(fault==='copied session')f.editMessages(f.author,m=>m[0].info.sessionID='other');if(fault==='wrong provider')f.editMessages(f.author,m=>m[0].info.providerID='hosted');if(fault==='foreign messages')f.author.messagesPath=f.verifier.messagesPath;if(fault==='missing inference')f.author.usage.requests=0;if(fault==='commit outside author time')f.artifact.createdAt='2026-09-12T00:00:00Z';await expect(f.verify()).rejects.toThrow();
 });
 it.each(['failed verifier','same failed run','earlier verifier','other assignment','wrong head','failed checks','old check receipt','invented command','no verifier tool','wrong verifier output','wrong dependency','missing log'] as const)('rejects %s recovery',async fault=>{
  const f=fixture();if(fault==='failed verifier')f.verifier.status='failed';if(fault==='same failed run')f.artifact.verification.runId=f.author.id;if(fault==='earlier verifier')f.verifier.createdAt=f.author.createdAt;if(fault==='other assignment')f.verifier.assignmentId='other';if(fault==='wrong head')f.artifact.verification.identity='a'.repeat(40);if(fault==='failed checks')f.check.status='failed';if(fault==='old check receipt')f.check.finishedAt='2026-09-10T00:00:00Z';if(fault==='invented command')f.artifact.verification.command='true';if(fault==='no verifier tool')f.editMessages(f.verifier,m=>m[0].parts=[]);if(fault==='wrong verifier output')f.editMessages(f.verifier,m=>m[0].parts[0].state.output=JSON.stringify({...f.check,identity:'a'.repeat(40)}));if(fault==='wrong dependency')f.verifier.verificationDependencies.artifactId='other';if(fault==='missing log')rmSync(f.artifact.verification.logPath);await expect(f.verify()).rejects.toThrow();
 });
});
