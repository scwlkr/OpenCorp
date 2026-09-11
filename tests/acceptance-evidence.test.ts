import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyPartialIssueComment, verifyProjectCheckpoint, verifyOwnerSurfaceEvidence, verifyActiveWorkEvidence, fingerprintCompanyWorkspace, isEmployeeAuthoredArtifact } from '../scripts/acceptance-evidence.js';
import type { Artifact, CompanySnapshot, DeliveryReceipt, ExternalAction } from '../src/core/types.js';

function fixture(artifactIdentity='current-head',prNumber=12){
 const projectId='project',productId='product',prUrl=`https://github.com/fixture/product/pull/${prNumber}`,mergeCommit=`merge-${prNumber}`,gate='The next release still requires its provider checks.';
 const action={id:`comment-${prNumber}`,kind:'communication',status:'succeeded',productId,content:{kind:'issue_comment',number:7},dedupeKey:`delivery-evidence:${projectId}:${artifactIdentity}`,remoteRef:`https://github.com/fixture/product/issues/7#issuecomment-${prNumber}`,result:{id:prNumber}} as ExternalAction;
 const delivery:DeliveryReceipt={artifactId:`artifact-${artifactIdentity}`,identity:artifactIdentity,state:'merged',prNumber,prUrl,mergeCommit,issueNumber:7,closeIssue:false,remainingGate:gate,issueEvidenceActionId:action.id};
 const issue={url:'https://api.github.com/repos/fixture/product/issues/7'},comment={id:prNumber,html_url:action.remoteRef!,issue_url:issue.url,body:`Delivered in ${prUrl} (default-branch commit ${mergeCommit}). Independent review and canonical verification passed for ${artifactIdentity}. This is a partial milestone. Remaining work: ${gate}\n\n<!-- opencorp-action:${action.id} -->`};
 return {projectId,productId,artifactIdentity,prUrl,mergeCommit,delivery,action,issue,comment};
}
describe('artifact-specific partial issue acceptance evidence',()=>{
 it('accepts the actual current milestone comment with its exact provider and action bindings',()=>{expect(()=>verifyPartialIssueComment(fixture())).not.toThrow();});
 it('rejects an older milestone comment despite the same issue, gate, valid marker and observed URL',()=>{
  const current=fixture(),old=fixture('prior-head',11);current.action=old.action;current.comment=old.comment;current.delivery.issueEvidenceActionId=old.action.id;
  expect(()=>verifyPartialIssueComment(current)).toThrow(/different delivered artifact/);
  current.action={...old.action,dedupeKey:`delivery-evidence:${current.projectId}:${current.artifactIdentity}`};expect(()=>verifyPartialIssueComment(current)).toThrow(/exact pull request/);
 });
 it.each(['issue','product','number','marker','gate','artifact','merge','url'] as const)('rejects mismatched %s evidence',field=>{
  const input=fixture();
  if(field==='issue')input.comment.issue_url='https://api.github.com/repos/fixture/product/issues/8';
  if(field==='product')input.action.productId='unrelated-product';
  if(field==='number')input.action.content.number=8;
  if(field==='marker')input.comment.body=input.comment.body.replace(`<!-- opencorp-action:${input.action.id} -->`,'<!-- unrelated-marker -->');
  if(field==='gate')input.comment.body=input.comment.body.replace(input.delivery.remainingGate!,'Different remaining work.');
  if(field==='artifact')input.comment.body=input.comment.body.replace(`passed for ${input.artifactIdentity}`, 'passed for a different artifact');
  if(field==='merge')input.comment.body=input.comment.body.replace(input.mergeCommit,'another-merge');
  if(field==='url')input.comment.html_url='https://github.com/fixture/product/issues/7#issuecomment-unrelated';
  expect(()=>verifyPartialIssueComment(input)).toThrow();
 });
});

describe('retained actual Owner interface evidence',()=>{
 const identity={fingerprint:'current-interface-hash',files:{'dist/cli/index.js':'cli-hash','dist/web/index.html':'web-hash'}};
 function surfaces(){
  const state={company:{id:'company'},messages:[],assignments:[]} as unknown as CompanySnapshot;
  const evidence:any={kind:'installed-owner-surface-mutations',companyId:'company',passed:true,sourceIdentity:identity,browserErrors:[],screenshots:['actual-screenshot.png'],controls:[],chats:[]};
  for(const surface of ['webui','compiled-cli']){
   for(const action of ['start','pause','resume','stop'])evidence.controls.push({surface,action,companyId:'company',beforeState:action==='resume'?'paused':action==='start'?'stopped':'running',afterState:action==='stop'?'stopped':action==='pause'?'paused':'running',apiMethod:'POST',apiPath:'/api/v1/control'});
   const messageId=`${surface}-message`,assignmentId=`${surface}-response`,content=`${surface} acknowledgment only`;
   state.messages.push({id:messageId,senderId:'owner',recipientId:'ceo',projectId:null,content} as any);state.assignments.push({id:assignmentId,kind:'conversation',projectId:null,payload:{messageId},status:'completed'} as any);
   evidence.chats.push({surface,companyId:'company',messageId,assignmentId,recipientId:'ceo',projectId:null,content,assignmentStatus:'queued',delivery:'persisted_response_queued',apiMethod:'POST',apiPath:'/api/v1/chat'});
  }
  return {state,evidence,verify:()=>verifyOwnerSurfaceEvidence(evidence,state,identity)};
 }
 it('requires both actual surfaces and preserves submission proof after response completion',()=>{expect(()=>surfaces().verify()).not.toThrow();});
 it('rejects old API-only control evidence rather than granting interface coverage',()=>{expect(()=>verifyOwnerSurfaceEvidence(undefined,surfaces().state,identity)).toThrow(/actual WebUI/);});
 it.each(['start','pause','resume','stop'])('rejects an unexercised CLI %s command',action=>{const {evidence,verify}=surfaces();evidence.controls=evidence.controls.filter((item:any)=>item.surface!=='compiled-cli'||item.action!==action);expect(verify).toThrow(/not exercised/);});
 it.each(['source','wrong company','wrong message','wrong response','lost message','wrong control','relabeled start','missing chat'] as const)('rejects %s evidence',field=>{
  const {state,evidence,verify}=surfaces();
  if(field==='source')evidence.sourceIdentity={fingerprint:'old',files:{}};
  if(field==='wrong company')evidence.companyId='unrelated-company';
  if(field==='wrong message')state.messages[0].content='Different actual message';
  if(field==='wrong response')state.assignments[0].payload.messageId='another-message';
  if(field==='lost message')state.messages.shift();
  if(field==='wrong control')evidence.controls[0].apiPath='/api/v1/status';
  if(field==='relabeled start')evidence.controls.find((item:any)=>item.surface==='webui'&&item.action==='resume').beforeState='stopped';
  if(field==='missing chat')evidence.chats.pop();
  expect(verify).toThrow();
 });
 it('accepts prior actual interruption history while an idle current surface run cannot establish it',()=>{
  const state={company:{id:'company'},runs:[{id:'interrupted-run',status:'cancelled'}]} as unknown as CompanySnapshot;
  const prior={companyId:'company',passed:true,startedWithActiveRun:true,activeRunIds:['interrupted-run'],pausedRestart:{method:'serviceInstall'},stoppedRestart:{method:'serviceInstall'},identitiesPreserved:true,responsibilitiesPreserved:true,filesPreserved:true,stopSurvivedRestart:true};
  expect(()=>verifyActiveWorkEvidence(prior,state)).not.toThrow();expect(()=>verifyActiveWorkEvidence({...prior,startedWithActiveRun:false,activeRunIds:[]},state)).toThrow(/current or retained/);expect(()=>verifyActiveWorkEvidence({...prior,activeRunIds:['lost-run']},state)).toThrow(/history was lost/);expect(()=>verifyActiveWorkEvidence({...prior,companyId:'other'},state)).toThrow();expect(()=>verifyActiveWorkEvidence({...prior,passed:false},state)).toThrow();
 });
});

describe('actual second-project checkpoint evidence',()=>{
 let root:string;
 beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'opencorp-checkpoint-proof-'));});
 afterEach(()=>rmSync(root,{recursive:true,force:true}));
 function checkpoint(kind:'analysis'|'commit'='analysis'){
  const workspace=join(root,'workspaces','project'),gitDir=join(root,'repositories','project.git');mkdirSync(workspace,{recursive:true});
  const state={policy:{allowedRepositories:['/fixture/registered-product']},products:[{id:'product',repository:'/fixture/registered-product'}],projects:[{id:'project',name:'Meaningful checkpoint',productId:'product',workspace,gitDir,outcome:'A measured correction',acceptance:['Actual scoped outcome']}],assignments:[{id:'assignment',projectId:'project',employeeId:'employee',kind:'implementation'}],employees:[{id:'employee'}],runs:[{id:'run',employeeId:'employee',assignmentId:'assignment',workspace,status:'succeeded',sessionId:'actual-fixture-session',modelIdentity:'actual-fixture-local-model',usage:{requests:1}}]} as unknown as CompanySnapshot;
  const artifact={id:'artifact',projectId:'project',employeeId:'employee',assignmentId:'assignment',runId:'run',kind,summary:'Concrete checkpoint evidence',checks:[]} as unknown as Artifact;
  if(kind==='analysis'){
   const content=Buffer.from('# Actual observed checkpoint\nRetained scoped evidence.\n');artifact.uri=join(workspace,'finding.md');writeFileSync(artifact.uri,content);artifact.identity=createHash('sha256').update(content).digest('hex');artifact.baselineIdentity=null;artifact.verification={source:'file-observation',identity:artifact.identity,passed:true};artifact.checks=[{source:'file-observation',identity:artifact.identity,status:'observed',bytes:content.length}];
  }else{
   mkdirSync(join(root,'repositories'),{recursive:true});execFileSync('/usr/bin/git',['init','--bare',gitDir],{stdio:'pipe'});writeFileSync(join(workspace,'.git'),`gitdir: ${gitDir}\n`);
   const git=(args:string[])=>execFileSync('/usr/bin/git',['--git-dir',gitDir,'--work-tree',workspace,'-c','user.name=Fixture employee','-c','user.email=fixture@localhost','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null',...args],{cwd:workspace,env:{PATH:'/usr/bin:/bin',HOME:root,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'},encoding:'utf8'}).trim();
   writeFileSync(join(workspace,'code.js'),'export const value = 1;\n');git(['add','code.js']);git(['commit','-m','Fixture baseline']);artifact.baseCommit=git(['rev-parse','HEAD']);state.projects[0].baseCommit=artifact.baseCommit;
   writeFileSync(join(workspace,'code.js'),'export const value = 2;\n');git(['add','code.js']);git(['commit','-m','Fixture employee correction']);artifact.identity=git(['rev-parse','HEAD']);artifact.uri=`https://github.com/fixture/product/commit/${artifact.identity}`;
  }
  state.projects.push({id:'first-delivered-project',name:'First delivered project'} as any);
  return {state,artifact,verify:()=>verifyProjectCheckpoint(state,artifact,{dataRoot:root,otherProjectId:'first-delivered-project'})};
 }
 it('verifies a genuine new narrative without demanding review or merge for this checkpoint',async()=>{
  const {artifact,verify}=checkpoint();expect(await verify()).toMatchObject({projectId:'project',artifactId:'artifact',runId:'run',proof:{kind:'analysis',identity:artifact.identity,baselineIdentity:null}});
 });
 it('permits a legitimate company-maintenance project with actual content and employee provenance',async()=>{
  const {state,verify}=checkpoint();state.projects[0].productId=null;expect(await verify()).toMatchObject({projectId:'project',productId:null,proof:{kind:'analysis'}});
 });
 it('verifies a nonempty immutable code commit before independent review/merge is required',async()=>{
  const {artifact,verify}=checkpoint('commit');expect(await verify()).toMatchObject({identity:artifact.identity,proof:{kind:'commit',baseCommit:artifact.baseCommit,diff:expect.stringContaining('code.js')}});
 });
 it.each(['source','workspace','null source','false source','relabeled narrative'] as const)('excludes imported artifacts with %s provenance from authored delivery and checkpoint proof',async field=>{
  const {artifact,verify}=checkpoint(field==='relabeled narrative'?'analysis':'commit');
  expect(isEmployeeAuthoredArtifact(artifact)).toBe(true);
  if(field==='workspace')Object.assign(artifact,{reviewWorkspace:{workspace:join(root,'workspaces','external-review')}});
  else Object.assign(artifact,{sourcePullRequest:field==='null source'?null:field==='false source'?false:{number:12,authorLogin:'external-contributor'}});
  expect(isEmployeeAuthoredArtifact(artifact)).toBe(false);
  await expect(verify()).rejects.toThrow(/Imported pull request code cannot establish an employee-authored checkpoint/);
 });
 it('retains historical authorship after the assignment is legitimately reassigned',async()=>{
  const {state,verify}=checkpoint();state.assignments[0].employeeId='new-assignee';expect(await verify()).toMatchObject({employeeId:'employee',runId:'run'});
 });
 it.each(['product','assignment','run assignment','author','project','workspace','run status'] as const)('rejects a checkpoint with the wrong %s binding',async field=>{
  const {state,artifact,verify}=checkpoint();
  if(field==='product')state.projects[0].productId='unregistered';
  if(field==='assignment')artifact.assignmentId='other-assignment';
  if(field==='run assignment')state.runs[0].assignmentId='other-assignment';
  if(field==='author')artifact.employeeId='other-employee';
  if(field==='project')state.assignments[0].projectId='other-project';
  if(field==='workspace')state.runs[0].workspace=root;
  if(field==='run status')state.runs[0].status='failed';
  await expect(verify()).rejects.toThrow();
 });
 it.each(['deleted','changed','baseline','observation','bytes'] as const)('rejects %s narrative evidence',async field=>{
  const {artifact,verify}=checkpoint();
  if(field==='deleted')rmSync(artifact.uri);
  if(field==='changed')writeFileSync(artifact.uri,'Different contents');
  if(field==='baseline')artifact.baselineIdentity=artifact.identity;
  if(field==='observation')artifact.verification.source='invented';
  if(field==='bytes')artifact.checks[0].bytes++;
  await expect(verify()).rejects.toThrow();
 });
 it('rejects the first delivered project reused as the second checkpoint',async()=>{
  const {state,artifact}=checkpoint();await expect(verifyProjectCheckpoint(state,artifact,{dataRoot:root,otherProjectId:'project'})).rejects.toThrow(/separate retained project/);
 });
 it.each(['analysis','commit'] as const)('does not count the sole project %s when the first delivery has not passed',async kind=>{
  const {state,artifact}=checkpoint(kind);state.projects=state.projects.filter(project=>project.id===artifact.projectId);
  await expect(verifyProjectCheckpoint(state,artifact,{dataRoot:root})).rejects.toThrow(/retained first delivery project/);
 });
 it('rejects an anchor that is not a retained company project',async()=>{
  const {state,artifact}=checkpoint();await expect(verifyProjectCheckpoint(state,artifact,{dataRoot:root,otherProjectId:'unretained-project'})).rejects.toThrow(/retained first delivery project/);
 });
 it('rejects missing commits and commits with no source change',async()=>{
  const {artifact,verify}=checkpoint('commit');artifact.identity='a'.repeat(40);await expect(verify()).rejects.toThrow();artifact.identity=artifact.baseCommit;await expect(verify()).rejects.toThrow(/no actual change/);
 });
});

describe('ordinary company workspace preservation',()=>{
 let root:string;
 beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'opencorp-company-preservation-'));});
 afterEach(()=>rmSync(root,{recursive:true,force:true}));
 it('detects changed files and empty directories without requiring Git',()=>{
  const workspace=join(root,'workspace');mkdirSync(join(workspace,'notes','empty'),{recursive:true});writeFileSync(join(workspace,'notes','finding.md'),'Original finding');
  const before=fingerprintCompanyWorkspace(workspace);expect(before.entries).toMatchObject({'notes/empty':{kind:'directory'},'notes/finding.md':{kind:'file',identity:expect.stringMatching(/^[a-f0-9]{64}$/)}});expect(fingerprintCompanyWorkspace(workspace)).toEqual(before);
  writeFileSync(join(workspace,'notes','finding.md'),'Changed finding');expect(fingerprintCompanyWorkspace(workspace)).not.toEqual(before);writeFileSync(join(workspace,'notes','finding.md'),'Original finding');expect(fingerprintCompanyWorkspace(workspace)).toEqual(before);
  rmSync(join(workspace,'notes','empty'),{recursive:true});expect(fingerprintCompanyWorkspace(workspace)).not.toEqual(before);
 });
 it('records symlink targets, including dangling links, without reading their external contents',()=>{
  const workspace=join(root,'workspace'),outside=join(root,'outside');mkdirSync(workspace);mkdirSync(outside);writeFileSync(join(outside,'private.txt'),'External contents');symlinkSync(outside,join(workspace,'external'));symlinkSync(join(root,'missing'),join(workspace,'dangling'));
  const before=fingerprintCompanyWorkspace(workspace);expect(before.entries.external).toEqual({kind:'symlink',target:outside});expect(before.entries.dangling).toEqual({kind:'symlink',target:join(root,'missing')});expect(before.entries['external/private.txt']).toBeUndefined();
  writeFileSync(join(outside,'private.txt'),'Changed outside the workspace');expect(fingerprintCompanyWorkspace(workspace)).toEqual(before);
  rmSync(join(workspace,'external'));symlinkSync(join(root,'different'),join(workspace,'external'));expect(fingerprintCompanyWorkspace(workspace)).not.toEqual(before);
 });
 it('rejects a symlink used as the workspace root',()=>{const target=join(root,'target'),linked=join(root,'linked');mkdirSync(target);symlinkSync(target,linked);expect(()=>fingerprintCompanyWorkspace(linked)).toThrow(/ordinary directory/);});
});
