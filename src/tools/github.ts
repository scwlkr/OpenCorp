import {parse as parseYaml, parseDocument} from 'yaml';
import {execFile} from 'node:child_process';
import {promisify, isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {deliveriesFor, deliveryFor, workspaceAdvancePending, deliveryCommunicationKey, isDeliveryCommunication, deliveryCommunicationMatches, observedDeliveryCommunication} from '../core/delivery.js';
import { CompanyStore } from '../storage/store.js';
import { type Actor, type Artifact, type Project, DomainError, type ExternalAction, type DeliveryReceipt } from '../core/types.js';
import { WorkspaceManager } from './workspaces.js';
import { checked, brokerEnvironment } from './process.js';

export class GitHubDelivery {
 constructor(public store:CompanyStore,public workspaces:WorkspaceManager){}
 private retainDelivery(projectId:string,receipt:DeliveryReceipt){
  const project=this.store.need('projects',projectId),history=deliveriesFor(project),index=history.findIndex(item=>item.artifactId===receipt.artifactId);
  if(index<0)history.push(receipt);else history[index]=receipt;
  this.store.update('projects',projectId,{deliveryHistory:history,...(!project.delivery||project.delivery.artifactId===receipt.artifactId||index<0?{delivery:receipt}:{})});
 }
 async readIssue(productId:string,number:number){
  if(!Number.isInteger(number)||number<1)throw new DomainError('invalid_issue','A positive issue number is required.');
  const product=this.store.need('products',productId),repository=product.binding?.repository;
  if(!repository||!this.store.policy.allowedRepositories.includes(product.repository))throw new DomainError('issue_scope','Inspect this registered product before reading its issue.',403);
  const issue=JSON.parse(await checked('gh',['api',`repos/${repository}/issues/${number}`]));
  if(issue.pull_request||issue.number!==number||typeof issue.title!=='string'||typeof issue.body!=='string'&&issue.body!==null)throw new DomainError('issue_identity','Provider response is not the requested issue.',409);
  const title=issue.title as string,body=String(issue.body??''),identity=createHash('sha256').update(JSON.stringify({repository,number,title,body})).digest('hex');
  return {repository,number,title,body,identity,url:`https://github.com/${repository}/issues/${number}`,state:issue.state,observedAt:new Date().toISOString()};
 }
 private async closureReview(productId:string,artifact:Artifact,number:number,reviewId?:string){
  const review=this.store.list('reviews').filter(r=>r.artifactId===artifact.id&&r.artifactIdentity===artifact.identity&&r.verdict==='approved'&&r.employeeId!==artifact.employeeId&&r.runId!==artifact.runId&&r.issueAcceptance?.number===number&&(!reviewId||r.id===reviewId)).at(-1);
  if(!review?.issueAcceptance)throw new DomainError('issue_review_required','Full issue closure requires independent review_work issueAcceptance for this exact artifact and fetched issue.',403);
  const live=await this.readIssue(productId,number),proof=review.issueAcceptance;
  if(proof.repository!==live.repository||proof.identity!==live.identity||proof.artifactIdentity!==artifact.identity||proof.artifactId!==artifact.id||proof.runId!==review.runId||proof.reviewerId!==review.employeeId)throw new DomainError('issue_changed','Issue scope changed or differs from the exact independent issue acceptance review. Read and review the actual issue again.',409);
  return review;
 }
 private validateText(title:string,body:string){
  if(typeof title!=='string'||!title.trim()||title.length>256||typeof body!=='string'||!body.trim()||body.length>20000)throw new DomainError('publication_text','A concrete title (1–256 characters) and body (1–20000 characters) are required.');
  assertNoClosingSyntax(title);assertNoClosingSyntax(body);
  if((title+body).includes('<!-- opencorp-action:'))throw new DomainError('publication_marker','Reserved delivery markers cannot be supplied by callers.');
 }

 private async publicationCost(actor:Actor,repo:string,productId:string,project:Project,artifact:Artifact){
  this.store.validateActor(actor,true);
  const product=this.store.need('products',productId),live=JSON.parse(await checked('gh',['api',`repos/${repo}`]));
  if(live.private!==false)throw new DomainError('cost_unconfirmed','Live repository visibility is not public; zero incremental Actions charge is not established.',409);
  if(live.default_branch!==product.binding.defaultBranch)throw new DomainError('default_branch_changed','The live default branch changed; refresh the product binding before publication.',409);
  const head=JSON.parse(await checked('gh',['api',`repos/${repo}/commits/${encodeURIComponent(live.default_branch)}`]));
  if(typeof head.sha!=='string'||!/^[a-f0-9]{40,64}$/i.test(head.sha))throw new DomainError('cost_unconfirmed','Current default-branch identity could not be established.',409);
  // pull_request_target and post-merge push workflows come from the current base,
  // which may have changed since the project's immutable review baseline.
  await checked('git',['--git-dir',product.binding.mirror,'-c','core.hooksPath=/dev/null','-c','credential.helper=','fetch','--no-tags',`https://github.com/${repo}.git`,head.sha],{env:{...brokerEnvironment(),GIT_CONFIG_GLOBAL:'/dev/null'},timeoutMs:120_000});
  const workflowPaths=await this.checkFreeWorkflow(product.binding.mirror,head.sha);
  const workflowQualification={reviewed:await this.qualifyWorkflowChange(project,artifact,artifact.baseCommit??project.baseCommit!),currentDefault:await this.qualifyWorkflowChange(project,artifact,head.sha)};
  this.store.validateActor(actor,true);
  return {repository:repo,visibility:'public',defaultBranch:live.default_branch,defaultBranchHead:head.sha,artifactId:artifact.id,artifactIdentity:artifact.identity,workflowPaths,workflowQualification,checkedAt:new Date().toISOString()};
 }
 private recordCost(actionId:string,proof:Awaited<ReturnType<GitHubDelivery['publicationCost']>>){this.store.update('actions',actionId,{costPreflight:proof,costEvidence:this.store.need('actions',actionId).ownerProposalId?this.store.need('actions',actionId).costEvidence:`Live public GitHub repository; known-free workflows inspected at current default head ${proof.defaultBranchHead}. Exact artifact ${proof.artifactId} (${proof.artifactIdentity}) workflow qualification: reviewed baseline ${proof.workflowQualification.reviewed.kind}; current default ${proof.workflowQualification.currentDefault.kind}. Qualification and public visibility checked immediately before dispatch.`});}
 private adoptPrepared(actor:Actor,action:ExternalAction){
  if(actor.kind!=='employee'||action.runId===actor.runId)return;
  const prior=this.store.need('runs',action.runId);
  if(!prior.tokenRevoked||['running','cancelling','queued'].includes(prior.status))throw new DomainError('prior_run_active','Previous intent owner has not finished; do not dispatch concurrently.',409);
  if(action.status!=='prepared')throw new DomainError('reconciliation_required','Only a never-dispatched or conclusively absent intent can be resumed.',409);
  this.store.validateActor(actor,true);
  if(action.ownerProposalId)return; // Dispatch validates the exact original assignment; keep frozen origin intact.
  this.store.update('actions',action.id,{runId:actor.runId,employeeId:actor.employeeId,policyRevision:actor.policyRevision,priorRunIds:[...(action.priorRunIds??[]),action.runId]});
  this.store.emit('action.adopted',{actionId:action.id,runId:actor.runId,priorRunId:action.runId});
 }
 private scope(actor:Actor,productId:string){this.store.validateActor(actor,true);if(actor.kind!=='employee')throw new DomainError('run_required','Tracked employee run required.',403);const run=this.store.need('runs',actor.runId),assignment=this.store.need('assignments',run.assignmentId),project=this.store.need('projects',assignment.projectId!);if(project.productId!==productId)throw new DomainError('product_denied','Action is outside this assignment product.',403);const product=this.store.need('products',productId);if(!product.binding?.repository)throw new DomainError('not_connected','Refresh product GitHub connection first.',409);return {product,project,repo:product.binding.repository as string};}
 private async observe(action:ExternalAction,dispatch:()=>Promise<{remoteRef:string;result?:unknown}>){try{const observed=await dispatch();return this.store.resolveAction(action.id,{status:'succeeded',...observed});}catch(error){this.store.resolveAction(action.id,{status:'uncertain',error:String(error),recovery:'Inspect remote state by the recorded target and marker; do not repeat automatically.'});throw new DomainError('external_uncertain',`External result uncertain; action ${action.id} must be reconciled. ${String(error)}`,409);}}
 async communicate(actor:Actor,input:{productId:string;kind:'issue_comment'|'issue_create'|'pr_comment';number?:number;title?:string;content:string;dedupeKey:string}){
  const {repo,project,product}=this.scope(actor,input.productId);if(!input.content?.trim())throw new DomainError('empty_message','Communication content is required.');
  if(!['issue_comment','issue_create','pr_comment'].includes(input.kind))throw new DomainError('channel_unavailable','Supported connected product channel is GitHub. Email and other channels need a configured adapter.',409);
  if(input.kind!=='issue_create'&&(!Number.isInteger(input.number)||input.number!<1))throw new DomainError('invalid_target',`communicate kind "${input.kind}" requires number: a positive integer identifying the actual issue or PR. Supply number directly beside kind, content and dedupeKey. Omit number only for issue_create.`);
  const assignment=this.store.need('assignments',this.store.need('runs',(actor as Extract<Actor,{kind:'employee'}>).runId).assignmentId),followup=assignment.schedulerKey?.startsWith('delivery-communication:');
  let receipt:DeliveryReceipt|undefined,retainedIntent:ExternalAction|undefined;
  if(followup){
   if(input.content.includes('<!-- opencorp-action:'))throw new DomainError('publication_marker','Reserved action markers cannot be supplied by callers.');
   if(!isDeliveryCommunication(project,assignment))throw new DomainError('communication_scope','Communication followup no longer matches its exact observed delivery.',409);
   receipt=deliveryFor(project,assignment.payload.artifactId)!;this.verified(this.store.need('artifacts',receipt.artifactId),project,true);
   if(input.kind!=='pr_comment'||input.number!==receipt.prNumber)throw new DomainError('communication_scope','This followup must communicate on its exact merged PR.',403);
   const related=this.store.list('actions').filter(action=>{const run=this.store.get('runs',action.runId);return deliveryCommunicationMatches(project,receipt!,repo,action,run,run?this.store.get('assignments',run.assignmentId):undefined);});
   const observed=related.find(observedDeliveryCommunication);if(observed)return observed;
   const pending=related.find(action=>['dispatched','uncertain'].includes(action.status));if(pending)throw new DomainError('reconciliation_required',`Action ${pending.id} is ${pending.status}; preserve its recorded send and reconcile it.`,409);
   const key=deliveryCommunicationKey(receipt),bound=this.store.list('actions').find(action=>action.dedupeKey===key);
   if(bound&&!related.some(action=>action.id===bound.id))throw new DomainError('dedupe_conflict','Delivery communication key belongs to a different retained intent.',409);
   const prior=bound??related.find(action=>action.status==='prepared');
   if(prior&&prior.status!=='prepared')throw new DomainError('reconciliation_required',`Action ${prior.id} is ${prior.status}.`,409);
   retainedIntent=prior;
   input={...input,dedupeKey:prior?.dedupeKey??key,...(prior?{content:prior.content.body,title:prior.content.title}:{} )};
  }
  const target=`${repo}/${input.kind==='pr_comment'?'pulls':'issues'}${input.number?`/${input.number}`:''}`;
  const prepared=this.store.prepareAction(actor,{...input,kind:'communication',target,...(receipt?{artifactId:receipt.artifactId,artifactIdentity:receipt.identity}:{}),content:retainedIntent?.content??{kind:input.kind,title:input.title??'',body:input.content,number:input.number??null},cost:0,costEvidence:'GitHub existing product identity: ordinary issue and PR communication has no incremental charge.'});
  if(prepared.status==='succeeded')return prepared;if(prepared.status!=='prepared')throw new DomainError('reconciliation_required',`Action ${prepared.id} is ${prepared.status}.`,409);
  // Confirm account and destination immediately before effect, under current policy.
  const login=await checked('gh',['api','user','--jq','.login']);if(login!==repo.split('/')[0])throw new DomainError('identity_mismatch',`Connected GitHub identity ${login} does not match configured product owner ${repo.split('/')[0]}.`,403);
  if(receipt){
   const live=JSON.parse(await checked('gh',['api',`repos/${repo}/pulls/${receipt.prNumber}`]));
   if(live.number!==receipt.prNumber||live.html_url!==receipt.prUrl||live.merged!==true||live.head?.sha!==receipt.identity||live.base?.repo?.full_name!==repo||live.base?.ref!==product.binding.defaultBranch||live.merge_commit_sha!==receipt.mergeCommit)throw new DomainError('communication_source_changed','Live PR no longer confirms this exact observed merge.',409);
   const current=this.store.need('projects',project.id),binding=this.store.need('products',product.id).binding,currentAssignment=this.store.need('assignments',assignment.id),currentRun=this.store.need('runs',(actor as Extract<Actor,{kind:'employee'}>).runId);
   if(!isDeliveryCommunication(current,currentAssignment)||currentAssignment.status!=='running'||currentAssignment.employeeId!==currentRun.employeeId||currentRun.employeeId!==(actor as Extract<Actor,{kind:'employee'}>).employeeId||currentRun.assignmentId!==currentAssignment.id||currentRun.status!=='running'||currentRun.tokenRevoked||binding?.repository!==repo||binding.defaultBranch!==product.binding.defaultBranch)throw new DomainError('communication_scope','Delivery scope changed before communication dispatch.',409);this.verified(this.store.need('artifacts',receipt.artifactId),current,true);
  }else if(input.number)await checked('gh',['api',`repos/${repo}/issues/${input.number}`,'--jq','.html_url']);
  this.adoptPrepared(actor,prepared);this.store.validateActor(actor,true);if(receipt)this.store.update('actions',prepared.id,{artifactId:receipt.artifactId,artifactIdentity:receipt.identity});const action=this.store.dispatchAction(actor,prepared.id);
  return this.observe(action,async()=>{const body=`${input.content}\n\n<!-- opencorp-action:${action.id} -->`;const result=JSON.parse(await checked('gh',['api','--method','POST',input.kind==='issue_create'?`repos/${repo}/issues`:`repos/${repo}/issues/${input.number}/comments`,'--input','-'],{input:JSON.stringify(input.kind==='issue_create'?{title:input.title,body}:{body})}));if(receipt&&(!Number.isSafeInteger(result.id)||result.id<1||result.html_url!==`${receipt.prUrl}#issuecomment-${result.id}`))throw new Error('Provider comment receipt does not match the assigned merged PR');return {remoteRef:result.html_url,result:{id:result.id,identity:login,number:result.number}};});
 }
 private verified(artifact:Artifact,project:Project,historicalMerge=false){const approved=historicalMerge?this.store.list('reviews').some(review=>review.artifactId===artifact.id&&review.artifactIdentity===artifact.identity&&review.verdict==='approved'&&review.employeeId!==artifact.employeeId&&review.runId!==artifact.runId):this.store.hasApprovedArtifact(artifact.assignmentId,artifact.identity);if(artifact.projectId!==project.id||!approved)throw new DomainError('review_required','Independent review of the exact artifact is required.',403);if(!artifact.checks?.length||artifact.checks.some((c:any)=>c.status!=='passed'||c.identity!==artifact.identity||c.source!=='canonical-verifier'))throw new DomainError('checks_required','Canonical verifier receipts for the exact commit are required.',403);}
 async deliver(actor:Actor,input:{productId:string;artifactId:string;title:string;body:string;issueNumber?:number;closeIssue?:boolean;remainingGate?:string}){
  const {repo,project,product}=this.scope(actor,input.productId);const artifact=this.store.need('artifacts',input.artifactId);this.verified(artifact,project);
  const prior=deliveryFor(project,artifact.id);if(prior)return this.merge(actor,{productId:input.productId,artifactId:artifact.id});
  if(workspaceAdvancePending(project)||deliveriesFor(project).some(item=>item.state!=='merged'||item.issueNumber&&!item.issueEvidenceActionId))throw new DomainError('delivery_pending','Finish the previous artifact delivery before publishing the next milestone in this project.',409);
  if(Object.hasOwn(artifact,'sourcePullRequest')||Object.hasOwn(artifact,'reviewWorkspace')){
   const candidate=this.workspaces.artifact(project,artifact),source=artifact.sourcePullRequest!,live=await this.workspaces.assertPullRequest(project,source);
   if(input.closeIssue!==undefined&&typeof input.closeIssue!=='boolean')throw new DomainError('invalid_issue_closure','closeIssue must be an explicit boolean.');
   if(input.closeIssue&&!input.issueNumber)throw new DomainError('issue_required','Explicit closure requires the exact issue number.');
   if(input.issueNumber!==undefined&&(!Number.isSafeInteger(input.issueNumber)||input.issueNumber<1))throw new DomainError('invalid_issue','A positive issue number is required.');
   if(input.issueNumber&&!input.closeIssue&&(typeof input.remainingGate!=='string'||!input.remainingGate.trim()||input.remainingGate.length>2000))throw new DomainError('remaining_gate_required','A partial issue milestone requires its exact remainingGate');
   if(input.remainingGate)assertNoClosingSyntax(input.remainingGate);
   const issueReview=input.closeIssue?await this.closureReview(product.id,artifact,input.issueNumber!):undefined;
   if(input.issueNumber&&!input.closeIssue)await this.readIssue(product.id,input.issueNumber);
   this.assertMergeText(live,{closeIssue:input.closeIssue===true,issueNumber:input.issueNumber});
   if(await this.workspaces.head(candidate)!==artifact.identity||!await this.workspaces.clean(candidate))throw new DomainError('candidate_changed','Reviewed external PR candidate is no longer clean at its exact head',409);
   const login=await checked('gh',['api','user','--jq','.login']);if(login!==repo.split('/')[0])throw new DomainError('identity_mismatch','Connected product identity changed.',403);
   this.assertMergeText(await this.workspaces.assertPullRequest(project,source),{closeIssue:input.closeIssue===true,issueNumber:input.issueNumber});this.store.validateActor(actor,true);
   this.retainDelivery(project.id,{source:'existing-pr',state:'awaiting_checks',artifactId:artifact.id,identity:artifact.identity,prNumber:source.number,prUrl:source.url,branch:source.headRef,closeIssue:input.closeIssue===true,issueNumber:input.issueNumber,issueReviewId:issueReview?.id,remainingGate:input.remainingGate});
   return {source:'existing-pr',state:'awaiting_checks',prNumber:source.number,prUrl:source.url,next:'Existing PR bound without push/create/edit. Exact provider checks, source and cost are rechecked before merge.'};
  }
  this.validateText(input.title,input.body);
  if(input.closeIssue!==undefined&&typeof input.closeIssue!=='boolean')throw new DomainError('invalid_issue_closure','closeIssue must be an explicit boolean.');
  if(input.closeIssue&&!input.issueNumber)throw new DomainError('issue_required','Explicit closure requires the exact issue number.');
  if(input.issueNumber!==undefined&&(!Number.isInteger(input.issueNumber)||input.issueNumber<1))throw new DomainError('invalid_issue','A positive issue number is required.');
  if(input.issueNumber&&!input.closeIssue&&(typeof input.remainingGate!=='string'||!input.remainingGate.trim()||input.remainingGate.length>2000))throw new DomainError('remaining_gate_required','A partial issue milestone requires remainingGate describing the actual work or external prerequisite still needed for that issue.');
  if(input.remainingGate)assertNoClosingSyntax(input.remainingGate);
  const issueReview=input.closeIssue?await this.closureReview(product.id,artifact,input.issueNumber!):undefined;
  if(input.issueNumber&&!input.closeIssue)await this.readIssue(product.id,input.issueNumber);
  // Publication branches identify exact artifacts. Keep legacy prepared intents on
  // their recorded branch; never reuse a prior merged PR for new product work.
  const oldIntent=this.store.list('actions').find(a=>a.dedupeKey===`pr:${project.id}:${artifact.identity}`);
  const branch=oldIntent?oldIntent.target.slice(repo.length+1):`${project.branch}-delivery-${artifact.id}`;
  if(await this.workspaces.head(project)!==artifact.identity||!await this.workspaces.clean(project))throw new DomainError('artifact_changed','Workspace must be clean at the reviewed commit.',409);
  await this.qualifyWorkflowChange(project,artifact,artifact.baseCommit??project.baseCommit!);
  await this.checkFreeWorkflow(product.binding.mirror,artifact.baseCommit??project.baseCommit!);
  const login=await checked('gh',['api','user','--jq','.login']);if(login!==repo.split('/')[0])throw new DomainError('identity_mismatch','Connected product identity changed.',403);
  const prepared=this.store.prepareAction(actor,{productId:product.id,kind:'pull_request',target:`${repo}:${branch}`,content:{artifactId:artifact.id,head:artifact.identity,branch,title:input.title,body:input.body,issueNumber:input.issueNumber??null,closeIssue:input.closeIssue===true,remainingGate:input.remainingGate??null,issueReviewId:issueReview?.id??null},dedupeKey:`pr:${project.id}:${artifact.identity}`,cost:0,costEvidence:'Public GitHub repository; standard Actions workflows unchanged or covered by the bounded WalkLang release-version qualification, and verified free of metered provider operations.'});
  let pr:any;
  if(prepared.status==='succeeded')pr=prepared.result;
  else {
   if(prepared.status!=='prepared')throw new DomainError('reconciliation_required',`Publication ${prepared.id} needs reconciliation.`,409);
   // Branch publication and PR creation are separate effects: a pause during
   // push must not dispatch a subsequent provider mutation.
   const pushIntent=this.store.prepareAction(actor,{productId:product.id,kind:'branch_push',target:`${repo}:refs/heads/${branch}`,content:{head:artifact.identity,branch},dedupeKey:`push:${project.id}:${artifact.identity}`,cost:0,costEvidence:prepared.costEvidence});
   if(pushIntent.status!=='succeeded'){
    if(pushIntent.status!=='prepared')throw new DomainError('reconciliation_required',`Branch publication ${pushIntent.id} needs reconciliation.`,409);
    this.recordCost(pushIntent.id,await this.publicationCost(actor,repo,product.id,project,artifact));
    this.adoptPrepared(actor,pushIntent);
    this.store.validateActor(actor,true);const push=this.store.dispatchAction(actor,pushIntent.id);
    await this.observe(push,async()=>{
     await checked('git',['--git-dir',project.gitDir,'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','credential.helper=','-c','credential.helper=!gh auth git-credential','push',`https://github.com/${repo}.git`,`${artifact.identity}:refs/heads/${branch}`],{env:{...brokerEnvironment(),GIT_CONFIG_GLOBAL:'/dev/null'},timeoutMs:120_000});
     return {remoteRef:`https://github.com/${repo}/tree/${branch}`,result:{head:artifact.identity,branch}};
    });
   }
   this.store.validateActor(actor,true);
   const existing=JSON.parse(await checked('gh',['pr','list','--repo',repo,'--head',branch,'--state','all','--json','number,url,headRefOid,state,title,body']));
   if(!existing.length)this.recordCost(prepared.id,await this.publicationCost(actor,repo,product.id,project,artifact));
   const body=`${input.body}${input.issueNumber?(input.closeIssue?`\n\nCloses #${input.issueNumber}.`:`\n\nRelated issue #${input.issueNumber}. Remaining work: ${input.remainingGate}`):''}\n\nIndependent OpenCorp review: ${this.store.list('reviews').filter(r=>r.artifactId===artifact.id).map(r=>`${this.store.need('employees',r.employeeId).name}: ${r.verdict}`).join('; ')}. Canonical verification passed for ${artifact.identity}.\n\n<!-- opencorp-action:${prepared.id} -->`;
   this.assertMergeText({title:input.title,body},{closeIssue:input.closeIssue===true,issueNumber:input.issueNumber});
   this.adoptPrepared(actor,prepared);
   if(issueReview)await this.closureReview(product.id,artifact,input.issueNumber!,issueReview.id);
   this.store.validateActor(actor,true);const action=this.store.dispatchAction(actor,prepared.id);
   const result=await this.observe(action,async()=>{
    if(existing.length){if(existing.length!==1||existing[0].headRefOid!==artifact.identity||existing[0].state!=='OPEN'||!existing[0].body?.includes(`<!-- opencorp-action:${action.id} -->`))throw new Error('Existing PR head does not match reviewed artifact');return {remoteRef:existing[0].url,result:existing[0]};}

    this.store.validateActor(actor,true);
    const created=JSON.parse(await checked('gh',['api','--method','POST',`repos/${repo}/pulls`,'--input','-'],{input:JSON.stringify({title:input.title,body,head:branch,base:product.binding.defaultBranch})}));return {remoteRef:created.html_url,result:{number:created.number,url:created.html_url,headRefOid:created.head.sha}};
   });pr=result.result;
  }
  this.retainDelivery(project.id,{state:'awaiting_checks',prUrl:pr.url,prNumber:pr.number,artifactId:artifact.id,identity:artifact.identity,branch,publicationActionId:prepared.id,pushActionId:this.store.list('actions').find(a=>a.dedupeKey===`push:${project.id}:${artifact.identity}`)?.id,issueNumber:input.issueNumber??null,closeIssue:input.closeIssue===true,remainingGate:input.remainingGate,issueReviewId:issueReview?.id});
  return {prUrl:pr.url,prNumber:pr.number,state:'awaiting_checks',next:'Required GitHub checks must pass at the reviewed commit before merge. Scheduler will continue delivery.'};
 }
 async merge(actor:Actor,input:{productId:string;artifactId:string}){
  const {repo,project:logical,product}=this.scope(actor,input.productId),artifact=this.store.need('artifacts',input.artifactId);this.verified(artifact,logical);const imported=Object.hasOwn(artifact,'sourcePullRequest')||Object.hasOwn(artifact,'reviewWorkspace'),project=imported?this.workspaces.artifact(logical,artifact):logical,delivery=deliveryFor(logical,artifact.id);if(!delivery?.prNumber)throw new DomainError('missing_pr','Publish a reviewed pull request first.');
  if(imported&&(delivery.source!=='existing-pr'||delivery.prNumber!==artifact.sourcePullRequest!.number||repo!==artifact.sourcePullRequest!.repository||delivery.prUrl!==artifact.sourcePullRequest!.url))throw new DomainError('pull_request_provenance','Delivery does not identify the imported source PR',403);
  const pr=JSON.parse(await checked('gh',['pr','view',String(delivery.prNumber),'--repo',repo,'--json','number,url,headRefOid,state,mergeable,mergeStateStatus,statusCheckRollup,baseRefName,title,body']));
  if(pr.headRefOid!==artifact.identity||pr.baseRefName!==product.binding.defaultBranch)throw new DomainError('head_changed','Remote PR no longer matches the reviewed commit or intended base.',409);
  if(delivery.state==='merged'&&pr.state!=='MERGED')throw new DomainError('merge_unconfirmed','Retained merge conflicts with current provider state; reconcile it without another merge dispatch.',409);
  if(pr.state==='MERGED')return this.confirmMerge(actor,repo,product.binding.defaultBranch,project,artifact);
  if(imported){await this.workspaces.assertPullRequest(project,artifact.sourcePullRequest!);if(await this.workspaces.head(project)!==artifact.identity||!await this.workspaces.clean(project))throw new DomainError('candidate_changed','Imported candidate changed after independent review',409);}
  if(delivery.identity&&delivery.identity!==artifact.identity)throw new DomainError('artifact_changed','Delivery receipt identifies another artifact commit.',409);
  this.assertMergeText(pr,delivery);if(delivery.closeIssue)await this.closureReview(product.id,artifact,delivery.issueNumber!,delivery.issueReviewId);
  const checks=pr.statusCheckRollup??[];if(!checks.length||checks.some((c:any)=>c.status!=='COMPLETED'&&c.state!=='SUCCESS'||c.conclusion&&!['SUCCESS','NEUTRAL','SKIPPED'].includes(c.conclusion)))throw new DomainError('checks_pending','Remote checks are pending or failed; no merge performed.',409);
  if(pr.mergeable!=='MERGEABLE'||!['CLEAN','UNSTABLE','HAS_HOOKS'].includes(pr.mergeStateStatus))throw new DomainError('merge_blocked',`Provider merge state: ${pr.mergeStateStatus}.`,409);
  const prepared=this.store.prepareAction(actor,{productId:product.id,kind:'merge',target:`${repo}/pulls/${pr.number}`,content:{actualHead:artifact.identity,checksPassed:true,prNumber:pr.number},artifactId:artifact.id,artifactIdentity:artifact.identity,dedupeKey:`merge:${repo}:${pr.number}:${artifact.identity}`,cost:0,costEvidence:'Existing public GitHub repository, independently reviewed exact commit, required standard Actions checks passed.'});
  if(prepared.status==='succeeded')return this.confirmMerge(actor,repo,product.binding.defaultBranch,project,artifact,(prepared.result as any)?.mergeCommit);
  this.recordCost(prepared.id,await this.publicationCost(actor,repo,product.id,project,artifact));
  if(delivery.closeIssue)await this.closureReview(product.id,artifact,delivery.issueNumber!,delivery.issueReviewId);
  const currentPr=JSON.parse(await checked('gh',['pr','view',String(delivery.prNumber),'--repo',repo,'--json','headRefOid,baseRefName,state,title,body']));
  if(currentPr.headRefOid!==artifact.identity||currentPr.baseRefName!==product.binding.defaultBranch)throw new DomainError('head_changed','Remote PR changed during preflight.',409);
  if(currentPr.state==='MERGED')return this.confirmMerge(actor,repo,product.binding.defaultBranch,project,artifact);
  this.assertMergeText(currentPr,delivery);
  if(imported){this.assertMergeText(await this.workspaces.assertPullRequest(project,artifact.sourcePullRequest!),delivery);const login=await checked('gh',['api','user','--jq','.login']);if(login!==repo.split('/')[0])throw new DomainError('identity_mismatch','Connected product identity changed.',403);if(await this.workspaces.head(project)!==artifact.identity||!await this.workspaces.clean(project))throw new DomainError('candidate_changed','Imported candidate changed during merge preflight',409);}
  this.adoptPrepared(actor,prepared);this.store.validateActor(actor,true);const action=this.store.dispatchAction(actor,prepared.id);
  const result=await this.observe(action,async()=>{const merged=JSON.parse(await checked('gh',['api','--method','PUT',`repos/${repo}/pulls/${pr.number}/merge`,'--input','-'],{input:JSON.stringify({sha:artifact.identity,merge_method:'squash',commit_title:currentPr.title||`OpenCorp reviewed artifact ${artifact.identity}`,commit_message:`Independently reviewed and verified artifact ${artifact.identity}.`})}));if(!merged.merged)throw new Error(merged.message);return {remoteRef:pr.url,result:{mergeCommit:merged.sha,prNumber:pr.number}};});
  return this.confirmMerge(actor,repo,product.binding.defaultBranch,project,artifact,(result.result as any).mergeCommit);
 }
 private assertMergeText(pr:any,delivery:Pick<DeliveryReceipt,'closeIssue'|'issueNumber'>){
  if(typeof pr.title!=='string'||typeof pr.body!=='string')throw new DomainError('pr_metadata_unconfirmed','Read complete live PR title/body before validating issue-closing behavior.',409);
  assertNoClosingSyntax(pr.title);let body=pr.body as string;
  if(delivery.closeIssue){const line=`Closes #${delivery.issueNumber}.`;if(!body.includes(line))throw new DomainError('issue_closure_changed','Reviewed issue closure directive is missing from the live PR.',409);body=body.replace(line,'');}
  assertNoClosingSyntax(body);
 }
 private assertImportedObservation(artifact:Artifact,pr:any){
  if(!Object.hasOwn(artifact,'sourcePullRequest')&&!Object.hasOwn(artifact,'reviewWorkspace'))return;
  const source=artifact.sourcePullRequest;
  if(!source||pr.number!==source.number||pr.html_url!==source.url||pr.base?.repo?.full_name!==source.repository||pr.base?.ref!==source.baseRef||pr.head?.repo?.full_name!==source.headRepository||pr.head?.ref!==source.headRef||pr.head?.sha!==source.headSha||pr.user?.login!==source.authorLogin)throw new DomainError('pull_request_provenance','Merged provider observation differs from the retained external PR identity; preserve the delivery for reconciliation',409);
 }
 private async confirmMerge(actor:Actor,repo:string,defaultBranch:string,project:Project,artifact:Artifact,expectedMergeCommit?:string){
  const delivery=deliveryFor(this.store.need('projects',project.id),artifact.id)!;
  const pr=JSON.parse(await checked('gh',['api',`repos/${repo}/pulls/${delivery.prNumber}`]));
  this.assertImportedObservation(artifact,pr);
  if(pr.merged!==true||pr.head?.sha!==artifact.identity||pr.base?.ref!==defaultBranch||!pr.merge_commit_sha)throw new DomainError('merge_unconfirmed','Provider does not confirm the reviewed commit merged to the intended base.',409);
  const mergedCommit=pr.merge_commit_sha;
  if(expectedMergeCommit&&mergedCommit!==expectedMergeCommit)throw new DomainError('merge_changed','Provider merge identity differs from the retained merge receipt.',409);
  const live=JSON.parse(await checked('gh',['api',`repos/${repo}/commits/${defaultBranch}`]));
  const comparison=JSON.parse(await checked('gh',['api',`repos/${repo}/compare/${mergedCommit}...${live.sha}`]));
  if(!['ahead','identical'].includes(comparison.status))throw new DomainError('merge_unconfirmed','Merge was reported but default branch ancestry does not confirm delivery.',409);
  const receipt:DeliveryReceipt={...delivery,state:'merged',artifactId:artifact.id,identity:artifact.identity,mergeCommit:mergedCommit,defaultBranchHead:live.sha,prUrl:pr.html_url,deliveredAt:delivery.deliveredAt??new Date().toISOString(),mergeActionId:this.store.list('actions').find(a=>a.kind==='merge'&&a.content?.prNumber===delivery.prNumber&&a.content?.actualHead===artifact.identity&&a.productId===project.productId&&a.status==='succeeded')?.id};
  this.retainDelivery(project.id,receipt);
  if(delivery.issueNumber){const evidence=await this.communicate(actor,{productId:project.productId!,kind:'issue_comment',number:delivery.issueNumber,content:`Delivered in ${pr.html_url} (default-branch commit ${mergedCommit}). Independent review and canonical verification passed for ${artifact.identity}.${delivery.closeIssue?' Full issue acceptance was independently reviewed against the exact issue scope.':` This is a partial milestone. Remaining work: ${delivery.remainingGate??'Legacy receipt has no recorded remaining gate; inspect the issue before claiming completion.'}`}`,dedupeKey:`delivery-evidence:${project.id}:${artifact.identity}`});this.retainDelivery(project.id,{...receipt,issueEvidenceActionId:evidence.id});}
  // An imported PR has a retained review workspace, not the project's ongoing
  // implementation checkout. Observe its merge without resetting either tree.
  if(!artifact.sourcePullRequest)await this.advanceWorkspace(actor,project,artifact,mergedCommit);
  return {state:'merged',url:pr.html_url,prUrl:pr.html_url,prNumber:delivery.prNumber,mergeCommit:mergedCommit,defaultBranchHead:live.sha};
 }
 private async advanceWorkspace(actor:Actor,project:Project,artifact:Artifact,mergeCommit:string){
  const current=this.store.need('projects',project.id),receipt=deliveryFor(current,artifact.id)!;
  if(receipt.workspaceAdvance?.state==='completed')return;
  // A prior artifact can be re-observed after later work started. Never reset it.
  if(current.delivery?.artifactId!==artifact.id)return;
  const head=await this.workspaces.head(current);
  if(![artifact.identity,mergeCommit].includes(head)||!await this.workspaces.clean(current))throw new DomainError('workspace_advance_required','Merge is retained, but the owned workspace has changed. Preserve and reconcile it before advancing the next milestone.',409);
  await checked('git',['--git-dir',current.gitDir,'-c','core.hooksPath=/dev/null','-c','credential.helper=','fetch','--no-tags',`https://github.com/${this.store.need('products',current.productId!).binding.repository}.git`,mergeCommit],{env:{...brokerEnvironment(),GIT_CONFIG_GLOBAL:'/dev/null'},timeoutMs:120_000});
  const reviewedTree=await this.workspaces.git(current,['rev-parse',`${artifact.identity}^{tree}`]),mergedTree=await this.workspaces.git(current,['rev-parse',`${mergeCommit}^{tree}`]);
  if(reviewedTree!==mergedTree)throw new DomainError('merged_tree_changed','Merged tree includes other changes; retain the reviewed baseline and inspect the current default branch before continuing this workspace.',409);
  const latest=this.store.need('projects',project.id),freshHead=await this.workspaces.head(latest),freshClean=await this.workspaces.clean(latest);
  this.store.validateActor(actor,true);
  if(this.store.need('projects',project.id).delivery?.artifactId!==artifact.id||freshHead!==head||!freshClean)throw new DomainError('workspace_advance_required','Owned workspace or latest delivery changed during merge observation; preserved work must be reconciled before advancement.',409);
  for(const prior of this.store.list('artifacts').filter(item=>item.projectId===project.id&&!item.baseCommit))this.store.update('artifacts',prior.id,{baseCommit:current.baseCommit});
  const intent={state:'prepared' as const,from:artifact.identity,to:mergeCommit,priorBaseCommit:current.baseCommit};this.retainDelivery(project.id,{...receipt,workspaceAdvance:intent});
  if(head!==mergeCommit)await this.workspaces.git(current,['-c','core.hooksPath=/dev/null','reset','--hard',mergeCommit]);
  if(await this.workspaces.head(current)!==mergeCommit||!await this.workspaces.clean(current))throw new DomainError('workspace_advance_required','Owned workspace advancement is not confirmed; inspect retained intent before more work.',409);
  this.store.update('projects',project.id,{baseCommit:mergeCommit});this.retainDelivery(project.id,{...receipt,workspaceAdvance:{...intent,state:'completed'}});
 }
 private async workflowSource(mirror:string,commit:string,file:string):Promise<string>{
  if(!/^[a-f0-9]{40,64}$/i.test(commit)||file!=='.github/workflows/ci.yml')throw new DomainError('cost_unconfirmed','Workflow qualification requires exact immutable source commits and the existing CI path.',409);
  // Compare original bytes, not checked()'s trimmed/redacted output. Nothing from
  // this raw source capture is returned to employees or included in errors.
  let bytes:Buffer;
  try{bytes=(await promisify(execFile)('/usr/bin/git',['--git-dir',mirror,'-c','core.hooksPath=/dev/null','cat-file','blob',`${commit}:${file}`],{env:{...brokerEnvironment(),GIT_CONFIG_GLOBAL:'/dev/null'},encoding:'buffer',timeout:30_000,maxBuffer:256_000})).stdout;}catch{throw new DomainError('cost_unconfirmed','Complete workflow source could not be captured within the 256KB qualification limit.',409);}
  const content=bytes.toString('utf8');if(!Buffer.from(content,'utf8').equals(bytes)||content.includes('\0'))throw new DomainError('cost_unconfirmed','Workflow qualification requires complete UTF-8 YAML source.',409);return content;
 }
 private async qualifyWorkflowChange(project:Project,artifact:Artifact,referenceCommit:string){
  const changed=(await this.workspaces.git(project,['diff','--name-only','--no-renames','--no-ext-diff','--no-textconv',referenceCommit,artifact.identity,'--','.github/workflows'])).split('\n').filter(Boolean);
  const binding={referenceCommit,artifactId:artifact.id,artifactIdentity:artifact.identity};
  if(!changed.length)return {...binding,kind:'unchanged' as const};
  const product=this.store.need('products',project.productId!),file='.github/workflows/ci.yml';
  if(product.name!=='WalkLang'||changed.length!==1||changed[0]!==file)throw new DomainError('cost_unconfirmed','Workflow changes are unqualified; only the existing WalkLang CI release-version literal has a bounded zero-cost adapter.',409);
  for(const commit of [referenceCommit,artifact.identity]){const entry=await this.workspaces.git(project,['ls-tree',commit,'--',file]);if(!/^100644 blob [a-f0-9]{40,64}\t\.github\/workflows\/ci\.yml$/.test(entry))throw new DomainError('cost_unconfirmed','The existing CI workflow must remain the same regular file; additions, deletions, mode changes and renames are unqualified.',409);}
  const [before,after]=await Promise.all([this.workflowSource(product.binding.mirror,referenceCommit,file),this.workflowSource(product.binding.mirror,artifact.identity,file)]);
  return {...binding,...qualifyWalkLangReleaseVersion(before,after),file};
 }
 async checkFreeWorkflow(mirror:string,commit:string){const files=(await checked('git',['--git-dir',mirror,'ls-tree','-r','--name-only',commit,'.github/workflows'])).split('\n').filter(Boolean);for(const file of files){const text=await checked('git',['--git-dir',mirror,'show',`${commit}:${file}`]);assertFreeWorkflow(text,file);}return files;}
 async reconcile(actionId:string){const action=this.store.need('actions',actionId);if(action.status!=='uncertain')return action;const product=this.store.need('products',action.productId),repo=product.binding?.repository;if(!repo)return action;
  if(action.kind==='communication'){const c=action.content;const items=JSON.parse(await checked('gh',['api',c.number?`repos/${repo}/issues/${c.number}/comments?per_page=100`:`repos/${repo}/issues?state=all&per_page=100`]));const found=items.find((item:any)=>item.body?.includes(`<!-- opencorp-action:${action.id} -->`)&&(!action.dedupeKey.startsWith('delivery-communication:')&&!(action.artifactId&&action.artifactIdentity&&c.kind==='pr_comment')||Number.isSafeInteger(item.id)&&item.id>0&&item.html_url===`https://github.com/${action.target.replace('/pulls/','/pull/')}#issuecomment-${item.id}`));if(found)return this.store.resolveAction(action.id,{status:'succeeded',remoteRef:found.html_url,result:{id:found.id,number:found.number}});}
  if(action.kind==='pull_request'){
   const branch=action.target.slice(repo.length+1);const pulls=JSON.parse(await checked('gh',['api',`repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${repo.split('/')[0]}:${branch}`)}&per_page=100`]));
   const found=pulls.find((pr:any)=>pr.head?.sha===action.content.head&&pr.head?.ref===branch&&pr.body?.includes(`<!-- opencorp-action:${action.id} -->`));
   if(found)return this.store.resolveAction(action.id,{status:'succeeded',remoteRef:found.html_url,result:{number:found.number,url:found.html_url,headRefOid:found.head.sha}});
  }
  if(action.kind==='branch_push'){
   const ref=JSON.parse(await checked('gh',['api',`repos/${repo}/git/ref/heads/${action.content.branch}`]));if(ref.object?.sha===action.content.head)return this.store.resolveAction(action.id,{status:'succeeded',remoteRef:`https://github.com/${repo}/tree/${action.content.branch}`,result:{head:action.content.head,branch:action.content.branch}});
  }
  if(action.kind==='merge'){const pr=JSON.parse(await checked('gh',['api',`repos/${repo}/pulls/${action.content.prNumber}`]));if(pr.merged&&pr.head.sha===action.content.actualHead){const artifact=action.artifactId?this.store.need('artifacts',action.artifactId):undefined;if(artifact&&(Object.hasOwn(artifact,'sourcePullRequest')||Object.hasOwn(artifact,'reviewWorkspace'))){this.workspaces.artifact(this.store.need('projects',artifact.projectId!),artifact);this.assertImportedObservation(artifact,pr);}return this.store.resolveAction(action.id,{status:'succeeded',remoteRef:pr.html_url,result:{mergeCommit:pr.merge_commit_sha,prNumber:pr.number}});}}
  return this.store.reconcileAction(action.id,{state:'unknown',evidence:'No conclusive provider observation yet. Manual/management reconciliation required; no retry authorized.'});
 }
}

/** Unknown runner/provider charging fails closed before publication. */
export function assertFreeWorkflow(text:string,file='workflow') {
 const knownRunners=new Set(['ubuntu-latest','ubuntu-22.04','ubuntu-24.04','windows-latest','windows-2022','windows-2025','macos-latest','macos-14','macos-15']);
 const knownActions=new Set(['actions/checkout','actions/upload-artifact','actions/download-artifact','actions/setup-node','actions/cache','actions/configure-pages','actions/upload-pages-artifact','actions/deploy-pages','ruby/setup-ruby']);
 const fail=(reason:string)=>{throw new DomainError('cost_unconfirmed',`${file}: ${reason}. Establish zero incremental charge before publication.`,409);};
 const workflow=parseYaml(text);if(!workflow||typeof workflow.jobs!=='object')fail('No inspectable jobs');
 if(/secrets\.|(?:^|\s)(?:vercel|wrangler|eas|flyctl|terraform|aws|gcloud|kamal)\s/i.test(text))fail('Credentialed or metered provider operation');
 for(const job of Object.values(workflow.jobs) as any[]){if(job.uses)fail('Reusable workflow cost not established');const runner=job['runs-on'];if(typeof runner!=='string'||!knownRunners.has(runner))fail(`Unqualified runner ${JSON.stringify(runner)}`);if(!Array.isArray(job.steps))fail('No inspectable steps');for(const step of job.steps){if(step.uses){const action=String(step.uses).split('@')[0];if(!knownActions.has(action))fail(`Unqualified action ${action}`);}}}
}

/** Block GitHub's supported auto-close forms; only the broker emits a reviewed line. */
export function assertNoClosingSyntax(text:string){
 const plain=text.replace(/[*_`~[\]<>]/g,'');
 if(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s*(?:(?:[\w.-]+\/[\w.-]+)?#\d+|https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+)/i.test(plain))throw new DomainError('closing_syntax_denied','Do not put issue-closing keywords in title/body. Use issueNumber plus remainingGate for a partial milestone, or closeIssue:true after exact independent issue acceptance review.',403);
}

/** A literal version substitution may not alter any other workflow behavior. */
export function qualifyWalkLangReleaseVersion(before:string,after:string){
 const fail=()=>{throw new DomainError('cost_unconfirmed','Only an existing jobs.test.env.WALK_RELEASE_VERSION semantic-version literal may change; every other workflow key and value must match.',409);};
 const parse=(source:string)=>{try{const document=parseDocument(source,{uniqueKeys:true});if(document.errors.length||document.warnings.length)fail();return document.toJS({maxAliasCount:100});}catch{fail();}};
 const previous=parse(before),next=parse(after),from=previous?.jobs?.test?.env?.WALK_RELEASE_VERSION,to=next?.jobs?.test?.env?.WALK_RELEASE_VERSION;
 const version=(value:unknown)=>{if(typeof value!=='string'||value.length>80)return false;const match=/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);return !!match&&(!match[4]||match[4].split('.').every(part=>!/^\d+$/.test(part)||part==='0'||!part.startsWith('0')));};
 if(!version(from)||!version(to))fail();
 const mask=(value:any)=>({...value,jobs:{...value.jobs,test:{...value.jobs.test,env:{...value.jobs.test.env,WALK_RELEASE_VERSION:'<qualified-version>'}}}});
 if(!isDeepStrictEqual(mask(previous),mask(next)))fail();
 assertFreeWorkflow(before);assertFreeWorkflow(after);
 return {kind:'walklang-release-version-only' as const,location:'jobs.test.env.WALK_RELEASE_VERSION',from:from as string,to:to as string,beforeSha256:createHash('sha256').update(before).digest('hex'),afterSha256:createHash('sha256').update(after).digest('hex')};
}
