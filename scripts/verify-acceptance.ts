import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync, readlinkSync, readdirSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { OwnerClient, readConnection, ApiError } from '../src/cli/client.js';
import { defaultDataRoot, sourceRoot } from '../src/server/paths.js';
import { serviceInstall, serviceStatus } from '../src/server/service.js';
import { checked, runProcess, redact } from '../src/tools/process.js';
import { verifyOwnerWebUI, verifyOwnerReconnect, withOwnerMutationSurfaces, ownerMutationSourceIdentity, type OwnerMutationSurfaces } from '../tests/surfaces.browser.js';
import type { CompanySnapshot, Artifact } from '../src/core/types.js';
import { deliveryFor } from '../src/core/delivery.js';
import { verifyPartialIssueComment, verifyProjectCheckpoint, verifyReviewedExternalCheckpoint, verifyAuthoredDeliveryProvenance, verifyOwnerSurfaceEvidence, verifyActiveWorkEvidence, fingerprintCompanyWorkspace, isEmployeeAuthoredArtifact } from './acceptance-evidence.js';

if(process.versions.node!=='24.20.0')throw new Error('Acceptance requires pinned Node 24.20.0.');
const dataRoot=defaultDataRoot(), output=join(dataRoot,'acceptance');mkdirSync(output,{recursive:true,mode:0o700});
const controlsRequested=process.argv.includes('--controls');
const unknown=process.argv.slice(2).filter(arg=>!['--controls','--help'].includes(arg));
if(unknown.length)throw new Error(`Unknown acceptance options: ${unknown.join(', ')}`);
if(process.argv.includes('--help')){console.log('npm run verify:acceptance -- [--controls]\nReads the installed real company and writes acceptance/acceptance.json plus docs/ACCEPTANCE.md. --controls exercises bounded pause/stop/service restarts, then resumes. No product implementation or external write is performed. Missing real employee product delivery remains a failure.');process.exit(0);}

type Check={id:string;label:string;passed:boolean;evidence?:any;error?:string};
const results:Check[]=[];
const report:any={kind:'installed-real-company-acceptance',startedAt:new Date().toISOString(),dataRoot,controlsRequested,checks:results,limitations:[]};
const client=new OwnerClient(dataRoot);
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const jsonFile=(path:string)=>JSON.parse(readFileSync(path,'utf8'));
function save(path:string,value:unknown){writeFileSync(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});}
async function check(id:string,label:string,perform:()=>Promise<any>|any){try{const evidence=await perform();results.push({id,label,passed:true,evidence});console.log(`PASS ${id}: ${label}`);return evidence;}catch(error){const message=redact(error instanceof Error?error.message:String(error));results.push({id,label,passed:false,error:message});console.log(`UNMET ${id}: ${message}`);return undefined;}}
function requireFile(path:unknown,label:string):string{assert.equal(typeof path,'string',`${label} path is missing`);assert.ok(existsSync(path as string),`${label} file missing: ${String(path)}`);assert.ok(lstatSync(path as string).isFile(),`${label} must be a regular file`);return path as string;}
function ownFile(path:unknown,label:string):string{const file=requireFile(path,label),rel=relative(dataRoot,resolve(file));assert.ok(!isAbsolute(rel)&&!rel.startsWith('..'),`${label} must belong to this installed company`);return file;}
function sameIds(before:{id:string}[],after:{id:string}[],label:string){assert.deepEqual(after.map(v=>v.id).sort(),before.map(v=>v.id).sort(),`${label} identities changed through restart`);}
function localRun(state:CompanySnapshot,runId:string){
  const run=state.runs.find(r=>r.id===runId);assert.ok(run,`Employee run ${runId} missing`);assert.equal(run.status,'succeeded',`Employee run ${runId} did not succeed`);assert.ok(run.sessionId,`Run ${runId} lacks actual runtime session`);assert.ok(run.modelIdentity,`Run ${runId} lacks actual model artifact identity`);assert.ok(run.usage?.requests>0,`Run ${runId} lacks observed local inference`);
  const messagesPath=ownFile(run.messagesPath,`Run ${runId} OpenCode messages`),bindingPath=join(dataRoot,'runtime','employees',run.id,'binding.json'),binding=jsonFile(requireFile(bindingPath,'Runtime session binding'));
  assert.equal(binding.runId,run.id);assert.equal(binding.employeeId,run.employeeId);assert.equal(binding.sessionId,run.sessionId);assert.equal(binding.model?.local,true,'Hosted inference cannot satisfy acceptance');assert.equal(binding.model?.provider,'ollama');assert.equal(binding.model?.artifactIdentity,run.modelIdentity);assert.ok(!/cloud|openai|anthropic|openrouter/i.test(binding.model?.alias??''),'Hosted model alias detected');
  const messages=jsonFile(messagesPath);assert.ok(Array.isArray(messages)&&messages.some((m:any)=>m.info?.role==='assistant'),'Actual OpenCode assistant messages are absent');
  return {runId:run.id,employeeId:run.employeeId,sessionId:run.sessionId,modelId:run.modelId,modelIdentity:run.modelIdentity,requests:run.usage.requests,messagesPath,bindingPath};
}
async function workspaceState(state:CompanySnapshot){
  const records:Record<string,any>={};
  for(const project of state.projects.filter(p=>p.workspace&&existsSync(p.workspace))){
    if(!project.productId){records[project.id]=fingerprintCompanyWorkspace(project.workspace!);continue;}
    const path=project.workspace!;const head=await checked('git',['-C',path,'rev-parse','HEAD']);
    const diff=await checked('git',['-C',path,'-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','diff','--no-ext-diff','--no-textconv','--binary','HEAD']);
    const pending=await checked('git',['-C',path,'ls-files','--others','--exclude-standard','-z']);
    const untracked:Record<string,string>={};for(const name of pending.split('\0').filter(Boolean)){const file=join(path,name),stat=lstatSync(file);if(stat.isSymbolicLink())untracked[name]=`symlink:${readlinkSync(file)}`;else if(stat.isFile())untracked[name]=hash(readFileSync(file));}
    records[project.id]={workspace:path,head,diffHash:hash(diff),untracked};
  }
  return records;
}
async function waitState(predicate:(state:CompanySnapshot)=>boolean,timeoutMs=20000){const deadline=Date.now()+timeoutMs;let last:CompanySnapshot|undefined;while(Date.now()<deadline){try{last=await client.state(AbortSignal.timeout(1500));if(predicate(last))return last;}catch{/* Restart may briefly disconnect the service. */}await sleep(200);}throw new Error(`Installed service did not reach expected state within ${timeoutMs}ms; last state ${last?.company.state??'unreachable'}`);}
async function rejectedCommand(command:Record<string,unknown>){let error:unknown;try{await client.request('command',command);}catch(caught){error=caught;}assert.ok(error instanceof ApiError&&error.status===403,`Expected policy rejection before mutation: ${JSON.stringify(command)}`);return {type:command.type,status:error.status,message:error.message};}

async function exerciseControls(){
  let prior:any;try{prior=jsonFile(join(output,'controls.json'));}catch{/* First acceptance has no prior receipt. */}
  try{
    const observed=await withOwnerMutationSurfaces(dataRoot,join(output,'owner-surfaces'),exerciseControlsWithSurfaces);
    const {result,...ownerSurfaces}=observed;assert.ok(result,'Installed control exercise produced no result');
    const evidence={...result,ownerSurfaces};save(join(output,'controls.json'),evidence);return evidence;
  }catch(error){
    // An outer browser failure cannot leave an earlier inner success as proof.
    let current:any;try{current=jsonFile(join(output,'controls.json'));}catch{/* Preserve failure even if no inner receipt was written. */}
    save(join(output,'controls.json'),{...current,companyId:report.companyId,passed:false,activeWorkEvidence:current?.activeWorkEvidence??(prior?.startedWithActiveRun?prior:prior?.activeWorkEvidence),error:redact(String(error)),surfaceEvidencePath:join(output,'owner-surfaces','surface-mutations.json')});throw error;
  }
}

async function exerciseControlsWithSurfaces(surfaces:OwnerMutationSurfaces){
  const before=await client.state(),service=await serviceStatus(dataRoot);assert.ok(service.installed&&service.running,'Install and run the LaunchAgent before --controls');
  let activeWorkEvidence;
  try{const prior=jsonFile(join(output,'controls.json')),proof=verifyActiveWorkEvidence(prior.startedWithActiveRun?prior:prior.activeWorkEvidence,before);activeWorkEvidence=Object.fromEntries(['companyId','performedAt','passed','startedWithActiveRun','activeRunIds','pausedRestart','stoppedRestart','identitiesPreserved','responsibilitiesPreserved','filesPreserved','stopSurvivedRestart'].map(key=>[key,proof[key]]));}catch{/* Missing or invalid prior evidence cannot qualify an idle run. */}
  let restartPending=false,completed=false,primaryFailed=false,primaryError:unknown;
  const restart=async()=>{
    const prior=await client.state(),old=(await readConnection(dataRoot)).discovery.pid;
    assert.ok(['paused','stopped'].includes(prior.company.state),'Installer restart must begin paused or stopped');assert.ok(old,'Prior service PID must be recorded');
    restartPending=true;
    const installed=await serviceInstall(dataRoot);assert.ok(installed.installed&&installed.running,'Reinstalled LaunchAgent must be healthy');
    const currentState=await waitState(s=>s.company.id===prior.company.id,30000),current=(await readConnection(dataRoot)).discovery.pid;
    assert.ok(current,'Reinstalled service PID must be recorded');assert.notEqual(current,old,'A new service process must be observed');assert.equal(currentState.company.state,prior.company.state,'Service installation changed persisted company control state');
    restartPending=false;
    return {method:'serviceInstall',priorPid:old,pid:current,label:installed.label,stateBefore:prior.company.state,stateAfter:currentState.company.state};
  };
  const evidence:any={companyId:before.company.id,performedAt:new Date().toISOString(),initialState:before.company.state,startedWithActiveRun:before.runs.some(r=>r.status==='running'),activeRunIds:before.runs.filter(r=>r.status==='running').map(r=>r.id),activeWorkEvidence};
  try{
    if(before.company.state==='paused')await surfaces.cli.control('resume');
    else if(before.company.state!=='running')await surfaces.cli.control('start');
    const pauseStart=Date.now();await surfaces.web.control('pause');await waitState(s=>s.company.state==='paused'&&!s.runs.some(r=>r.status==='running'||r.status==='cancelling'),12000);evidence.pauseElapsedMs=Date.now()-pauseStart;assert.ok(evidence.pauseElapsedMs<12000,'Pause did not cancel active work within the bounded interval');
    const marker=`Owner interface acceptance ${new Date().toISOString()}`;
    await surfaces.web.chat(`${marker} WebUI: acknowledge receipt only. No product or priority changes are requested.`);
    await surfaces.cli.chat(`${marker} CLI: acknowledge receipt only. No product or priority changes are requested.`);
    const paused=await client.state();
    const fingerprints=await workspaceState(paused);const pausedRunIds=paused.runs.map(r=>r.id);await sleep(1000);sameIds(paused.runs,(await client.state()).runs,'Paused runs');
    evidence.pausedReconnect=await verifyOwnerReconnect(dataRoot,async()=>{evidence.pausedRestart=await restart();});
    const resumedDaemon=await client.state();assert.equal(resumedDaemon.company.state,'paused');sameIds(paused.employees,resumedDaemon.employees,'Employee');sameIds(paused.appointments,resumedDaemon.appointments,'Appointment');sameIds(paused.assignments,resumedDaemon.assignments,'Assignment');sameIds(paused.decisions,resumedDaemon.decisions,'Decision');sameIds(paused.runs,resumedDaemon.runs,'Run');assert.deepEqual(await workspaceState(resumedDaemon),fingerprints,'Workspace changes were not preserved through paused restart');
    const responsibilities=(s:CompanySnapshot)=>s.assignments.map(a=>({id:a.id,employeeId:a.employeeId,supervisorId:a.supervisorId,projectId:a.projectId,status:a.status})).sort((a,b)=>a.id.localeCompare(b.id));assert.deepEqual(responsibilities(resumedDaemon),responsibilities(paused),'Responsibilities changed through restart');sameIds(paused.projects,resumedDaemon.projects,'Project');sameIds(paused.artifacts,resumedDaemon.artifacts,'Artifact');sameIds(paused.messages,resumedDaemon.messages,'Message');
    evidence.identitiesPreserved=true;evidence.responsibilitiesPreserved=true;evidence.filesPreserved=true;evidence.workspaceFingerprints=fingerprints;evidence.pausedRunIds=pausedRunIds;
    await surfaces.web.control('resume');await surfaces.cli.control('pause');
    const stopStart=Date.now();await surfaces.web.control('stop');evidence.stopElapsedMs=Date.now()-stopStart;assert.ok(evidence.stopElapsedMs<12000,'Stop exceeded bounded shutdown');const stoppedDoctor=await client.request<any>('doctor');assert.equal(stoppedDoctor.runtime?.ollama?.running,false,'Stop left owned Ollama running');assert.deepEqual(stoppedDoctor.runtime?.activeRuns,[],'Stop left active runtime work');
    const beforeStoppedRestart=await client.state(),stoppedFingerprints=await workspaceState(beforeStoppedRestart);
    evidence.stoppedRestart=await restart();const stopped=await client.state();assert.equal(stopped.company.state,'stopped','Intentional stop was overridden by daemon restart');
    for(const collection of ['employees','appointments','assignments','decisions','runs','projects','artifacts','messages'] as const)sameIds(beforeStoppedRestart[collection],stopped[collection],collection);
    assert.deepEqual(responsibilities(stopped),responsibilities(beforeStoppedRestart),'Responsibilities changed through stopped restart');assert.deepEqual(await workspaceState(stopped),stoppedFingerprints,'Stopped restart lost workspace changes');evidence.stoppedWorkspaceFingerprints=stoppedFingerprints;evidence.stopSurvivedRestart=true;
    await surfaces.web.control('start');await surfaces.cli.control('stop');await surfaces.cli.control('start');await surfaces.cli.control('pause');await surfaces.cli.control('resume');await surfaces.cli.control('stop');
    evidence.spending=await rejectedCommand({type:'policy.update',spendingLimit:1});evidence.hostedInference=await rejectedCommand({type:'policy.update',localOnly:false});const policy=(await client.state()).policy;assert.equal(policy.spendingLimit,0);assert.equal(policy.localOnly,true);
    evidence.backup=await client.request<any>('backup',{});requireFile(join(evidence.backup.path,'manifest.json'),'Installed-company backup manifest');completed=true;
  }catch(error){primaryFailed=true;primaryError=error;evidence.error=redact(String(error));}
    const cleanupErrors:string[]=[];
    try{
      if(restartPending){
        const registration=await runProcess('/bin/launchctl',['print',`gui/${process.getuid!()}/${service.label}`],{timeoutMs:3000});
        const detail=registration.stderr||registration.stdout;
        if(registration.code===113&&detail.includes(`Could not find service "${service.label}"`)){
          // One best-effort recovery install is allowed only after fresh proof
          // of absence. The real installer retains its own bounded rechecks.
          evidence.restartRecovery={method:'serviceInstall',registration:'confirmed_absent',attempts:1};
          await serviceInstall(dataRoot);
        }else if(registration.code!==0)throw new Error(`Restart registration is uncertain; no recovery install attempted. ${detail}`);
        else evidence.restartRecovery={method:'observe_registered_service',attempts:0};
        await waitState(s=>s.company.id===before.company.id,30000);
      }
    }catch(error){cleanupErrors.push(redact(String(error)));}
    try{
      await waitState(s=>s.company.id===before.company.id,10000);
      await surfaces.cli.control('resume');await waitState(s=>s.company.id===before.company.id&&s.company.state==='running');evidence.resumed=true;
    }catch(error){cleanupErrors.push(redact(String(error)));evidence.resumed=false;}
    evidence.passed=completed&&cleanupErrors.length===0;if(cleanupErrors.length)evidence.cleanupErrors=cleanupErrors;
    save(join(output,'controls.json'),evidence);
    if(primaryFailed)throw primaryError;
    if(cleanupErrors.length)throw new Error(`Acceptance control cleanup failed: ${cleanupErrors.join('; ')}`);
    return evidence;
}

async function liveDelivery(state:CompanySnapshot,artifact:Artifact){
  assert.ok(isEmployeeAuthoredArtifact(artifact),'An imported pull request is not an employee-authored product change');
  const project=state.projects.find(p=>p.id===artifact.projectId);assert.ok(project?.productId,'Artifact lacks registered product project');const product=state.products.find(p=>p.id===project.productId);assert.ok(product?.binding?.repository,'Product GitHub identity is not connected');const delivery=deliveryFor(project,artifact.id);assert.ok(delivery,'Artifact has no retained delivery receipt');assert.equal(delivery.state,'merged','Product artifact has not completed its merge workflow');assert.equal(delivery.artifactId,artifact.id,'Delivered artifact differs from review target');assert.equal(delivery.identity,artifact.identity,'Delivered commit differs from reviewed artifact');assert.ok(delivery.mergeCommit,'Observed default-branch merge commit is absent');
  const authorship=await verifyAuthoredDeliveryProvenance(state,artifact,{dataRoot}),{author,verifier}=authorship;
  const reviews=state.reviews.filter(r=>r.artifactId===artifact.id&&r.artifactIdentity===artifact.identity&&r.verdict==='approved'&&r.employeeId!==artifact.employeeId&&r.runId!==artifact.runId);assert.ok(reviews.length,'Independent exact-artifact review is absent');const reviewer=localRun(state,reviews[0].runId);assert.equal(reviewer.employeeId,reviews[0].employeeId);
  assert.ok(artifact.verification?.passed&&artifact.verification.identity===artifact.identity&&artifact.verification.receiptId,'Trusted canonical verifier receipt is absent');assert.ok(artifact.checks.length&&artifact.checks.every(c=>c.source==='canonical-verifier'&&c.identity===artifact.identity&&c.status==='passed'),'Canonical repository checks did not pass at this commit');for(const check of artifact.checks)requireFile(check.logPath,'Canonical verifier log');
  const repo=product.binding.repository,pr=JSON.parse(await checked('gh',['api',`repos/${repo}/pulls/${delivery.prNumber}`]));assert.equal(pr.merged,true,'GitHub does not report the actual PR merged');assert.equal(pr.head.sha,artifact.identity,'GitHub PR head differs from reviewed commit');assert.equal(pr.base.ref,product.binding.defaultBranch,'PR merged to an unexpected base');assert.equal(pr.merge_commit_sha,delivery.mergeCommit,'Provider merge identity differs from retained receipt');
  const live=JSON.parse(await checked('gh',['api',`repos/${repo}/commits/${product.binding.defaultBranch}`])),comparison=JSON.parse(await checked('gh',['api',`repos/${repo}/compare/${delivery.mergeCommit}...${live.sha}`]));assert.ok(['ahead','identical'].includes(comparison.status),'Current default branch does not include delivered commit');
  const diff=await checked('git',['-C',project.workspace!,'diff','--stat','--no-ext-diff','--no-textconv',artifact.baseCommit??project.baseCommit!,artifact.identity]);assert.ok(diff.trim(),'A nonempty real product improvement is required');
  let issueEvidence;
  if(delivery.issueNumber){
    const issue=JSON.parse(await checked('gh',['api',`repos/${repo}/issues/${delivery.issueNumber}`]));
    if(issue.state!=='closed'){
      assert.equal(delivery.closeIssue,false,'Issue closure was required but the delivered issue remains open');assert.ok(delivery.remainingGate?.trim(),'Open issue lacks an exact remaining gate');
      const action=state.actions.find(a=>a.id===delivery.issueEvidenceActionId);assert.ok(action?.kind==='communication'&&action.status==='succeeded'&&action.productId===product.id&&action.content?.number===delivery.issueNumber&&action.result?.id,'Partial issue delivery lacks its observed verification comment');
      const comment=JSON.parse(await checked('gh',['api',`repos/${repo}/issues/comments/${action.result.id}`]));verifyPartialIssueComment({projectId:project.id,productId:product.id,artifactIdentity:artifact.identity,prUrl:pr.html_url,mergeCommit:delivery.mergeCommit,delivery,action,issue,comment});
      issueEvidence={url:issue.html_url,state:issue.state,remainingGate:delivery.remainingGate,verificationComment:comment.html_url};
    }else issueEvidence={url:issue.html_url,state:issue.state};
  }
  return {product:product.name,projectId:project.id,artifactId:artifact.id,artifactIdentity:artifact.identity,summary:artifact.summary,author,verifier,verification:authorship.verification,reviewer,reviewId:reviews[0].id,alternativeModel:author.modelId!==reviewer.modelId,canonicalChecks:artifact.checks,prUrl:pr.html_url,mergeCommit:delivery.mergeCommit,currentDefaultHead:live.sha,diff,issue:issueEvidence};
}

try{
  report.sourceRevision=await checked('git',['rev-parse','HEAD'],{cwd:sourceRoot});
  await check('canonical-verification','Typecheck, lint, tests and production build',async()=>{const command='npm run verify',result=await runProcess('npm',['run','verify'],{cwd:sourceRoot,timeoutMs:240000,maxOutput:400000});const logPath=join(output,'canonical-verification.log');writeFileSync(logPath,result.stdout+'\n'+result.stderr,{mode:0o600});assert.equal(result.code,0,`Canonical verifier failed; inspect ${logPath}`);return {command,logPath,sourceRevision:report.sourceRevision,coverage:'Includes controlled core/storage/provider failure fixtures; these do not count as autonomous product work.'};});
  let state=await check('connection','Installed Owner API is reachable',async()=>{const connected=await client.state();report.companyId=connected.company.id;report.url=(await readConnection(dataRoot)).discovery.url;return connected;}) as CompanySnapshot|undefined;
  if(state){
    if(controlsRequested)await check('controls-exercise','Pause/stop/restart preserve real company and resume',exerciseControls);
    state=await client.state();
    const actual=state;
    await check('doctor','Actual tools, models, integrations and supervised service',async()=>{const doctor=await client.request<any>('doctor');save(join(output,'doctor.json'),doctor);assert.ok(doctor.service?.installed&&doctor.service?.running,'User LaunchAgent must be installed and healthy');for(const name of ['node','OpenCode','Ollama','git','GitHub'])assert.equal(doctor.tools?.find((tool:any)=>tool.name===name)?.status,'available',`Required tool ${name} is unavailable`);assert.ok(doctor.models?.some((m:any)=>m.local&&m.available&&m.artifactIdentity),'No verified local model artifacts');assert.equal(actual.policy.localOnly,true);assert.equal(actual.policy.spendingLimit,0);return {path:join(output,'doctor.json'),service:doctor.service,models:doctor.models.map((m:any)=>({name:m.name,identity:m.artifactIdentity})),unavailable:doctor.integrations.filter((i:any)=>i.status==='unavailable')};});
    await check('formation','Stable company, three Elders, CEO and all registered products',()=>{const active=actual.employees.filter(e=>e.status==='active'),level=(id:string)=>actual.positions.find(p=>p.id===id)?.level;assert.equal(active.filter(e=>level(e.positionId)==='elder').length,3);assert.equal(active.filter(e=>level(e.positionId)==='ceo').length,1);assert.deepEqual(actual.products.map(p=>p.name).sort(),['OpenJob','WalkLang','paletteWOW'].sort());assert.equal(new Set(actual.employees.map(e=>e.id)).size,actual.employees.length);return {companyId:actual.company.id,employees:actual.employees.length,appointments:actual.appointments.length,products:actual.products.map(p=>({id:p.id,name:p.name}))};});
    await check('autonomous-agenda','Leadership locally assessed products, chose goals and staffed real projects',()=>{for(const p of actual.products){assert.ok(p.assessment?.trim(),`${p.name} lacks an actual leadership assessment`);assert.ok(p.goals?.length,`${p.name} lacks concrete leadership goals`);assert.ok(p.binding?.baseCommit&&Date.now()-Date.parse(p.binding.refreshedAt)<86400000,`${p.name} needs current repository onboarding evidence`);assert.ok(actual.decisions.some(d=>d.subject===p.name&&d.kind==='product.assess'&&d.authorId!=='owner'),`${p.name} assessment was not authored by company leadership`);}const management=actual.runs.filter(r=>actual.assignments.find(a=>a.id===r.assignmentId)?.kind==='management'&&r.status==='succeeded'&&r.corporateCommands?.some((c:any)=>['product.assess','project.create','assignment.create','decision.create'].includes(c.type)));assert.ok(management.length,'No successful local-model leadership command run');const local=management.map(r=>localRun(actual,r.id));assert.ok(actual.projects.some(p=>p.acceptance.length&&actual.assignments.some(a=>a.projectId===p.id&&a.kind==='implementation')),'Leadership has not staffed a finite implementation project');assert.ok(actual.decisions.some(d=>d.kind==='executive.appoint'&&d.status==='approved'&&actual.votes.filter(v=>v.decisionId===d.id).length===3),'No independent Elder-appointed executive');return {localLeadership:local,projects:actual.projects.map(p=>({id:p.id,name:p.name,acceptance:p.acceptance}))};});
    const delivered=await check('real-delivery','Employee-authored product change reviewed, checked and merged on actual default branch',async()=>{const candidates=actual.artifacts.filter(a=>{const project=actual.projects.find(p=>p.id===a.projectId);return a.kind==='commit'&&isEmployeeAuthoredArtifact(a)&&project&&deliveryFor(project,a.id)?.state==='merged';});assert.ok(candidates.length,'No employee-authored product artifact has completed an observed merge; imported pull requests retain their external authorship');const failures:string[]=[];for(const artifact of candidates){try{return await liveDelivery(actual,artifact);}catch(error){failures.push(`${artifact.id}: ${String(error)}`);}}throw new Error(failures.join('; '));});
    await check('second-project','A separate real project reached an authored artifact or verified executable checkpoint',async()=>{assert.ok(delivered?.projectId,'Second-project proof requires a successful first-delivery project anchor');const candidates=actual.artifacts.filter(a=>a.projectId&&a.projectId!==delivered.projectId);assert.ok(candidates.length,'Second project has no retained artifact or reviewed external candidate yet');const failures:string[]=[];for(const artifact of candidates){try{if(!isEmployeeAuthoredArtifact(artifact))return await verifyReviewedExternalCheckpoint(actual,artifact,{dataRoot,otherProjectId:delivered.projectId});const run=localRun(actual,artifact.runId),checkpoint=await verifyProjectCheckpoint(actual,artifact,{dataRoot,otherProjectId:delivered.projectId});return {...checkpoint,run};}catch(error){failures.push(`${artifact.id}: ${String(error)}`);}}throw new Error(failures.join('; '));});
    await check('recovery-controls','Actual restart during work, WebUI/CLI controls and chat, $0 and hosted denial',async()=>{const path=join(output,'controls.json'),evidence=jsonFile(requireFile(path,'Run verify:acceptance -- --controls to create control evidence'));assert.equal(evidence.companyId,actual.company.id);assert.equal(evidence.passed,true);assert.equal(evidence.pausedRestart?.method,'serviceInstall','Paused restart must exercise the actual service installer');assert.equal(evidence.stoppedRestart?.method,'serviceInstall','Stopped restart must exercise the actual service installer');assert.equal(evidence.resumed,true,'Control acceptance must finish with the company resumed');verifyActiveWorkEvidence(evidence.startedWithActiveRun?evidence:evidence.activeWorkEvidence,actual);verifyOwnerSurfaceEvidence(evidence.ownerSurfaces,actual,await ownerMutationSourceIdentity());for(const path of evidence.ownerSurfaces.screenshots)ownFile(path,'Owner interface mutation screenshot');assert.ok(evidence.identitiesPreserved&&evidence.responsibilitiesPreserved&&evidence.filesPreserved&&evidence.stopSurvivedRestart);assert.ok(Object.keys(evidence.workspaceFingerprints??{}).length,'No real project workspace was preserved');assert.equal(evidence.spending?.status,403);assert.equal(evidence.hostedInference?.status,403);requireFile(join(evidence.backup.path,'manifest.json'),'Backup manifest');return {path,...evidence};});
    // Retained history can exceed the broker's tail-only log capture; JSON needs its full prefix or an explicit overflow error.
    await check('cli-api','CLI and API return the same persistent company',async()=>{const {stdout}=await promisify(execFile)(process.execPath,[join(sourceRoot,'dist/cli/index.js'),'--data-dir',dataRoot,'--json','status'],{maxBuffer:16*1024*1024,timeout:15000});const result=JSON.parse(stdout);assert.equal(result.company.id,actual.company.id);assert.deepEqual(result.products.map((p:any)=>p.id).sort(),actual.products.map(p=>p.id).sort());return {companyId:result.company.id,command:'opencorp --json status',productIds:result.products.map((p:any)=>p.id)};});
    await check('webui','Actual production WebUI navigation, records, accessibility and screenshots',()=>verifyOwnerWebUI(dataRoot,join(output,'webui')));
    await check('tui','Actual PTY TUI browsing, chat, controls and reconnect',()=>{const path=join(output,'tui.json'),receipt=jsonFile(requireFile(path,'TUI PTY observation receipt'));assert.equal(receipt.companyId,actual.company.id);assert.equal(receipt.passed,true);assert.ok(receipt.observedAt&&receipt.chatExercised&&receipt.reconnectExercised,'TUI chat/reconnect not exercised');for(const view of ['overview','products','projects','employees','decisions','attention'])assert.ok(receipt.views?.map((v:string)=>v.toLowerCase()).includes(view),`TUI ${view} not exercised`);for(const control of ['pause','resume','stop'])assert.ok(receipt.controlsExercised?.includes(control),`TUI ${control} not exercised`);const transcriptPath=ownFile(receipt.ptyTranscriptPath,'TUI PTY transcript');assert.ok(readFileSync(transcriptPath,'utf8').length>100,'TUI transcript lacks real output');return {path,...receipt};});
    await check('communication','Actual task-related GitHub communication reached its recorded destination',async()=>{const actions=actual.actions.filter(a=>a.kind==='communication'&&a.status==='succeeded'&&a.remoteRef);assert.ok(actions.length,'No task-appropriate product communication was sent');for(const action of actions){const product=actual.products.find(p=>p.id===action.productId);if(!product?.binding?.repository)continue;const repo=product.binding.repository;let item:any;if(action.result?.id&&action.content.number)item=JSON.parse(await checked('gh',['api',`repos/${repo}/issues/comments/${action.result.id}`]));else if(action.result?.number)item=JSON.parse(await checked('gh',['api',`repos/${repo}/issues/${action.result.number}`]));else continue;if(item.body?.includes(`<!-- opencorp-action:${action.id} -->`)&&item.html_url===action.remoteRef)return {actionId:action.id,url:action.remoteRef,kind:action.content.kind,content:action.content.body};}throw new Error('No retained GitHub communication matches its actual provider marker and URL');});
    await check('real-local-runtime','Real OpenCode local tool use, independent review, image inference and cancellation',()=>{let path=process.env.OPENCORP_RUNTIME_VERIFY_RECORD;const parent=resolve(dataRoot,'..');if(!path){const candidates=readdirSync(parent).filter(name=>name.startsWith('opencorp-runtime-verification-')).map(name=>join(parent,name,'local-runtime-verification.json')).filter(existsSync).sort((a,b)=>lstatSync(b).mtimeMs-lstatSync(a).mtimeMs);path=candidates[0];}const result=jsonFile(requireFile(path,'Successful npm run verify:local-runtime receipt (or OPENCORP_RUNTIME_VERIFY_RECORD)'));assert.equal(result.kind,'disposable-real-runtime-check');assert.equal(result.passed,true,'Real local runtime verifier has not passed');for(const key of ['implementation','review','vision']){assert.ok(result[key]?.usage?.requests>0&&result[key]?.artifactIdentity&&result[key]?.sessionId,`Real ${key} inference missing`);requireFile(result[key].messagesPath,`${key} runtime messages`);}assert.equal(result.cancellation?.passed,true);return {path,kind:result.kind,implementation:result.implementation.modelId,review:result.review.modelId,vision:result.vision.modelId,finishedAt:result.finishedAt,note:'Disposable runtime fixture; real product proof is required separately above.'};});
    await check('running','Installed company remains running within approved local/$0 authority',async()=>{const final=await client.state(),service=await serviceStatus(dataRoot);assert.equal(final.company.state,'running');assert.ok(service.installed&&service.running);assert.equal(final.policy.localOnly,true);assert.equal(final.policy.spendingLimit,0);report.limitations=final.attention.filter(a=>a.status==='open').map(a=>({id:a.id,title:a.title,detail:a.detail,requiredAction:a.requiredAction}));return {url:(await readConnection(dataRoot)).discovery.url,companyId:final.company.id,state:final.company.state,service:service.label};});
  }else report.limitations.push({detail:'Installed Owner API unavailable. Start/install OpenCorp, then rerun acceptance.'});
}catch(error){results.push({id:'acceptance-harness',label:'Acceptance harness completed independent checks',passed:false,error:redact(String(error))});}
finally{
  report.finishedAt=new Date().toISOString();report.passed=results.every(result=>result.passed)&&results.length>=14;report.unmet=results.filter(result=>!result.passed).map(result=>({id:result.id,action:result.error}));
  const reportPath=join(output,'acceptance.json');save(reportPath,report);
  const markdown=`# OpenCorp acceptance\n\nStatus: **${report.passed?'PASSED':'INCOMPLETE'}**. Checked ${report.finishedAt}.\n\nInstalled company: ${report.companyId??'unavailable'}. URL: ${report.url??'unavailable'}. Source revision: ${report.sourceRevision??'unavailable'}.\n\n[Actual acceptance JSON](${reportPath})\n\n| Requirement | Result | Evidence or exact remaining gate |\n| --- | --- | --- |\n${results.map(result=>`| ${result.label.replaceAll('|','\\|')} | ${result.passed?'Passed':'Unmet'} | ${String(result.passed?(result.evidence?.path??result.evidence?.prUrl??'Recorded in acceptance JSON'):result.error).replaceAll('|','\\|').replaceAll('\n',' ')} |`).join('\n')}\n\nFixtures cover invalid authority, blind governance, identity/model changes, dismissal, uncertain effects and backup restore. They never count as employee-authored product improvements. Required real-product, local-model, provider and interface evidence is evaluated separately.\n\n${report.limitations.length?`Current attention:\n\n${report.limitations.map((item:any)=>`- ${item.title??'Limitation'}: ${item.requiredAction??item.detail}`).join('\n')}\n`:'No additional open attention items recorded.\n'}\nRerun: \`mise exec node@24.20.0 -- npm run verify:acceptance\`. Exercise installed control/restart preservation with \`-- --controls\` while actual employee product work is active.\n`;
  writeFileSync(join(sourceRoot,'docs','ACCEPTANCE.md'),markdown);console.log(`Acceptance ${report.passed?'PASSED':'INCOMPLETE'}: ${reportPath}`);if(!report.passed)process.exitCode=1;
}
