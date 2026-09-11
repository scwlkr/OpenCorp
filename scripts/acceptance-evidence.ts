import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstatSync, readFileSync, realpathSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Artifact, CompanySnapshot, DeliveryReceipt, ExternalAction } from '../src/core/types.js';
import { artifactProject, safeChild } from '../src/tools/workspaces.js';
import { canonicalVerification } from '../src/tools/verification.js';
import { brokerEnvironment, checked } from '../src/tools/process.js';

/** Import/review activity is useful work, but does not author the imported code.
 * Either provenance field reserves this distinction, including malformed values. */
export function isEmployeeAuthoredArtifact(artifact:Artifact){
 return !Object.hasOwn(artifact,'sourcePullRequest')&&!Object.hasOwn(artifact,'reviewWorkspace');
}

function canonicalVerificationFromSource(productName:string,workspace:string,baseCommit:string|undefined,workflow:string|undefined){
 if(productName!=='WalkLang')return canonicalVerification(productName,workspace,baseCommit);
 const parsed=parseYaml(workflow??''),version=parsed?.jobs?.test?.env?.WALK_RELEASE_VERSION??parsed?.env?.WALK_RELEASE_VERSION;
 assert.ok(typeof version==='string'&&/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version),'Authored workflow has no concrete canonical version');
 return `export WALK_VERSION='${version}'; make clean && make -j4 walk test && make conformance && WALK_BIN="$PWD/build/walk" scripts/stress-compatibility.sh && scripts/check-docs-site.sh && make release VERSION="$WALK_VERSION" OUT=dist`;
}

/** A completed employee commit survives a later turn failure. Prove its actual
 * authorship separately from the successful exact-head canonical check run. */
export async function verifyAuthoredDeliveryProvenance(state:CompanySnapshot,artifact:Artifact,input:{dataRoot:string}){
 assert.ok(isEmployeeAuthoredArtifact(artifact),'Imported or malformed source provenance cannot establish employee authorship');assert.equal(artifact.kind,'commit');
 assert.deepEqual(state.artifacts.find(item=>item.id===artifact.id),artifact,'Commit must be the retained company artifact');
 const project=state.projects.find(item=>item.id===artifact.projectId),assignment=state.assignments.find(item=>item.id===artifact.assignmentId);
 assert.ok(project?.productId&&project.workspace&&project.gitDir,'Authored commit lacks its product workspace');
 const product=state.products.find(item=>item.id===project.productId);assert.ok(product?.binding&&state.policy.allowedRepositories.includes(product.repository),'Authored commit product is not registered');
 assert.ok(assignment?.kind==='implementation'&&assignment.projectId===project.id,'Authored commit lacks its employee implementation assignment');
 assert.ok(!assignment.payload?.pullRequest&&!Object.hasOwn(assignment,'pullRequestCandidate'),'An imported candidate assignment cannot establish code authorship');
 const workspace=safeChild(join(input.dataRoot,'workspaces'),project.workspace),gitDir=safeChild(join(input.dataRoot,'repositories'),project.gitDir);
 assert.ok(!lstatSync(project.workspace).isSymbolicLink());assert.equal(readFileSync(join(workspace,'.git'),'utf8').trim(),`gitdir: ${project.gitDir}`);assert.equal(project.mirror,product.binding.mirror);safeChild(product.binding.mirror,gitDir);
 assert.ok([artifact.baseCommit,artifact.identity].every(value=>typeof value==='string'&&/^[a-f0-9]{40,64}$/.test(value)),'Authored commit requires immutable base/head identities');
 assert.equal(artifact.uri,`https://github.com/${product.binding.repository}/commit/${artifact.identity}`,'Authored commit URI does not identify its registered product source');
 const git=(args:string[])=>checked('git',['--git-dir',gitDir,'--work-tree',workspace,'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.sshCommand=false','-c','core.pager=cat','-c','diff.external=','-c','core.attributesFile=/dev/null',...args],{cwd:workspace,env:{...brokerEnvironment(),GIT_CONFIG_GLOBAL:'/dev/null'}});
 assert.equal(await git(['rev-parse',`${artifact.identity}^{commit}`]),artifact.identity);assert.equal(await git(['rev-parse',`${artifact.baseCommit}^{commit}`]),artifact.baseCommit);await git(['merge-base','--is-ancestor',artifact.baseCommit!,artifact.identity]);
 const diff=await git(['diff','--stat','--no-ext-diff','--no-textconv',artifact.baseCommit!,artifact.identity,'--']);assert.ok(diff.trim(),'Authored commit has no actual change from its retained baseline');
 const ownFile=(path:string,root=input.dataRoot)=>{assert.equal(typeof path,'string','Runtime evidence file is missing');const resolved=safeChild(root,path),stat=lstatSync(path);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0,'Evidence must be a retained nonempty regular file');return resolved;};
 const at=(value:string)=>{const parsed=Date.parse(value);assert.ok(Number.isFinite(parsed),'Evidence timestamp is missing');return parsed;};
 const local=(id:string,author=false)=>{
  const run=state.runs.find(item=>item.id===id);assert.ok(run&&state.employees.some(employee=>employee.id===run.employeeId)&&run.employeeId!=='owner','Actual employee run is missing');
  assert.ok((author?['succeeded','failed','interrupted']:['succeeded']).includes(run.status),'Run has no permitted terminal status');assert.ok(run.sessionId&&run.modelIdentity&&run.usage?.requests>0,'Actual local inference provenance is missing');assert.equal(safeChild(join(input.dataRoot,'workspaces'),run.workspace!),workspace);
  const runRoot=join(input.dataRoot,'runtime','employees',run.id),bindingPath=ownFile(join(runRoot,'binding.json'),runRoot),binding=JSON.parse(readFileSync(bindingPath,'utf8'));
  assert.equal(binding.runId,run.id);assert.equal(binding.employeeId,run.employeeId);assert.equal(binding.sessionId,run.sessionId);assert.equal(realpathSync(binding.workspace),workspace);assert.equal(binding.model?.local,true);assert.equal(binding.model?.provider,'ollama');assert.equal(binding.model?.artifactIdentity,run.modelIdentity);assert.ok(typeof binding.model?.alias==='string'&&!/cloud|openai|anthropic|openrouter/i.test(binding.model.alias));
  const messagesPath=ownFile(run.messagesPath,runRoot),messages=JSON.parse(readFileSync(messagesPath,'utf8'));
  assert.ok(Array.isArray(messages)&&messages.length&&messages.every((message:any)=>message.info?.sessionID===run.sessionId),'Native messages belong to another session');
  assert.ok(messages.some((message:any)=>message.info.role==='assistant'&&message.info.time?.completed&&!message.info.error&&message.info.providerID==='opencorp-local'&&message.info.modelID===binding.model.alias),'Completed local native assistant evidence is absent');
  const tools=messages.flatMap((message:any)=>message.parts??[]).filter((part:any)=>part.type==='tool'&&part.state?.status==='completed');
  return {run,tools,evidence:{runId:run.id,employeeId:run.employeeId,status:run.status,sessionId:run.sessionId,modelId:run.modelId,modelIdentity:run.modelIdentity,requests:run.usage.requests,messagesPath,bindingPath}};
 };
 const completedTool=(proof:ReturnType<typeof local>,name:string,accept:(part:any,output:any)=>boolean)=>assert.ok(proof.tools.some((part:any)=>{if(part.tool!==`corporate_${name}`)return false;try{return accept(part,JSON.parse(part.state.output));}catch{return false;}}),`Actual completed ${name} receipt is missing from the bound native run`);
 const author=local(artifact.runId,true);assert.equal(author.run.assignmentId,assignment.id);assert.equal(author.run.employeeId,artifact.employeeId);assert.ok(author.run.corporateCommands?.some((command:any)=>command.type==='artifact.record'&&command.id===artifact.id),'Authored commit lacks its current-run broker command');
 completedTool(author,'commit_work',(_part,output)=>output.id===artifact.id&&output.identity===artifact.identity&&output.runId===author.run.id&&output.employeeId===artifact.employeeId&&output.assignmentId===assignment.id&&output.kind==='commit'&&isEmployeeAuthoredArtifact(output));
 assert.ok(at(artifact.createdAt)>=at(author.run.createdAt)&&at(artifact.createdAt)<=at(author.run.endedAt),'Commit was not recorded during its author run');
 const verification=artifact.verification;assert.ok(verification?.passed&&verification.identity===artifact.identity&&verification.receiptId&&verification.exitCode===0,'Passing exact-head canonical receipt is missing');
 const verifier=local(verification.runId),verifierAssignment=state.assignments.find(item=>item.id===verifier.run.assignmentId);
 assert.ok(verifierAssignment?.projectId===project.id&&(verifierAssignment.id===assignment.id||verifierAssignment.kind==='review'&&verifierAssignment.payload?.artifactId===artifact.id),'Canonical verifier did not own this exact assignment/artifact');
 if(author.run.status!=='succeeded')assert.ok(verifier.run.id!==author.run.id&&at(verifier.run.createdAt)>=at(author.run.endedAt),'Failed/interrupted authorship needs a later successful canonical verification run');
 assert.ok(at(verification.completedAt)>=at(artifact.createdAt)&&at(verification.completedAt)>=at(verifier.run.createdAt)&&at(verification.completedAt)<=at(verifier.run.endedAt),'Canonical receipt time does not belong to its actual run');
 // After delivery the workspace may have advanced to later work. Resolve the
 // verifier command from the immutable authored tree, not its current files.
 const workflow=product.name==='WalkLang'?await git(['show',`${artifact.identity}:.github/workflows/ci.yml`]):undefined;
 const command=canonicalVerificationFromSource(product.name,workspace,artifact.baseCommit,workflow);assert.equal(verification.command,command);
 assert.equal(verification.logPath,join(input.dataRoot,'logs','verification',`${artifact.id}.log`));const logPath=ownFile(verification.logPath,join(input.dataRoot,'logs','verification'));
 assert.ok(artifact.checks.length&&artifact.checks.every(check=>check.source==='canonical-verifier'&&check.identity===artifact.identity&&check.status==='passed'&&check.exitCode===0&&check.unchanged===true&&check.command===command&&check.logPath===verification.logPath&&check.finishedAt===verification.completedAt),'Canonical checks differ from the current exact-head receipt');
 assert.ok(verifier.run.verificationDependencies?.installed&&verifier.run.verificationDependencies.artifactId===artifact.id&&verifier.run.verificationDependencies.incrementalCost===0,'Canonical run lacks its actual zero-cost dependency preparation');
 for(const check of artifact.checks){assert.equal(check.dependencyReceipt,verifier.run.verificationDependencies.receiptPath);ownFile(check.dependencyReceipt,join(input.dataRoot,'runtime','dependency-environments'));}
 completedTool(verifier,'verify_product',(part,output)=>part.state.input?.artifactId===artifact.id&&artifact.checks.every(check=>Object.entries(check).every(([key,value])=>JSON.stringify(output[key])===JSON.stringify(value))));
 return {author:author.evidence,verifier:verifier.evidence,verification:{...verification,logPath,logSha256:createHash('sha256').update(readFileSync(logPath)).digest('hex')},baseCommit:artifact.baseCommit,identity:artifact.identity,diff};
}

/** Company maintenance workspaces need preservation evidence without Git.
 * Record links themselves; never traverse a link into another workspace. */
export function fingerprintCompanyWorkspace(workspace:string){
 const root=lstatSync(workspace);assert.ok(root.isDirectory()&&!root.isSymbolicLink(),'Company workspace must be an ordinary directory');
 const entries:Record<string,unknown>=Object.create(null);
 const visit=(path:string,key:string)=>{
  const stat=lstatSync(path);
  if(stat.isSymbolicLink()){entries[key]={kind:'symlink',target:readlinkSync(path)};return;}
  if(stat.isDirectory()){entries[key]={kind:'directory',mode:stat.mode&0o777};for(const name of readdirSync(path).sort())visit(join(path,name),key==='.'?name:`${key}/${name}`);return;}
  assert.ok(stat.isFile(),`Unsupported company workspace entry: ${key}`);entries[key]={kind:'file',mode:stat.mode&0o777,identity:createHash('sha256').update(readFileSync(path)).digest('hex')};
 };
 visit(workspace,'.');return {workspace,kind:'company-files',entries};
}

/** Read the actual checkpoint, without treating a stored URI or successful chat
 * as proof that its attributed employee delivered this project's artifact. */
export async function verifyProjectCheckpoint(state:CompanySnapshot,artifact:Artifact,input:{dataRoot:string;otherProjectId?:string}){
 assert.ok(isEmployeeAuthoredArtifact(artifact),'Imported pull request code cannot establish an employee-authored checkpoint; retain a new authored artifact or company-maintenance analysis');
 assert.ok(input.otherProjectId&&state.projects.some(item=>item.id===input.otherProjectId),'Second-project proof requires the retained first delivery project');
 const project=state.projects.find(item=>item.id===artifact.projectId);assert.ok(project&&project.id!==input.otherProjectId,'Checkpoint must belong to a separate retained project');
 assert.ok(project.acceptance?.length&&project.outcome?.trim(),'Checkpoint project lacks its finite intended outcome and acceptance');
 const product=project.productId?state.products.find(item=>item.id===project.productId):undefined;
 if(project.productId)assert.ok(product&&state.policy.allowedRepositories.includes(product.repository),'Checkpoint product is not registered within the company repository authority');
 const assignment=state.assignments.find(item=>item.id===artifact.assignmentId),run=state.runs.find(item=>item.id===artifact.runId);
 assert.ok(assignment&&run,'Checkpoint assignment or employee run is missing');assert.equal(assignment.projectId,project.id,'Checkpoint assignment belongs to another project');assert.equal(run.assignmentId,assignment.id,'Checkpoint run belongs to another assignment');
 assert.equal(artifact.employeeId,run.employeeId,'Checkpoint author differs from its employee run');assert.ok(state.employees.some(item=>item.id===run.employeeId),'Checkpoint employee identity is missing');
 assert.equal(run.status,'succeeded','Checkpoint employee run did not succeed');assert.ok(run.sessionId&&run.modelIdentity&&run.usage?.requests>0,'Checkpoint lacks actual local-runtime provenance');
 assert.ok(artifact.summary?.trim()&&artifact.identity&&artifact.uri,'Checkpoint lacks its artifact identity, location or summary');assert.ok(project.workspace&&run.workspace,'Checkpoint workspace is missing');
 const workspace=safeChild(join(input.dataRoot,'workspaces'),project.workspace);assert.ok(!lstatSync(project.workspace).isSymbolicLink(),'Checkpoint workspace must not be a symlink');assert.equal(realpathSync(run.workspace),workspace,'Checkpoint run used a different workspace');
 let proof:Record<string,unknown>;
 if(artifact.kind==='analysis'){
  const path=safeChild(workspace,artifact.uri),stat=lstatSync(artifact.uri);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&stat.size<=200000,'Narrative checkpoint must be a nonempty retained regular file within the broker limit');
  const content=readFileSync(path),text=content.toString('utf8'),identity=createHash('sha256').update(content).digest('hex');assert.ok(text.trim()&&Buffer.from(text,'utf8').equals(content)&&!text.includes('\0'),'Narrative checkpoint must contain actual readable text');assert.equal(identity,artifact.identity,'Narrative checkpoint contents changed after recording');
  assert.ok(Object.hasOwn(artifact,'baselineIdentity')&&(artifact.baselineIdentity===null||typeof artifact.baselineIdentity==='string'&&artifact.baselineIdentity!==identity),'Narrative checkpoint lacks evidence of a change from its recorded baseline');
  assert.ok(artifact.verification?.passed&&artifact.verification.identity===identity&&artifact.verification.source==='file-observation','Narrative checkpoint lacks the actual broker file observation');assert.ok(artifact.checks.some(check=>check.source==='file-observation'&&check.identity===identity&&check.status==='observed'&&check.bytes===content.length),'Narrative checkpoint byte receipt does not match its retained content');
  proof={kind:'analysis',path,identity,bytes:content.length,baselineIdentity:artifact.baselineIdentity};
 }else{
  assert.equal(artifact.kind,'commit','Checkpoint kind lacks supported direct employee artifact evidence');assert.equal(assignment.kind,'implementation','Product commit requires an implementation assignment');assert.ok(product,'Product commit requires a registered product');
  assert.ok(project.gitDir,'Checkpoint Git metadata is missing');safeChild(join(input.dataRoot,'repositories'),project.gitDir);assert.equal(readFileSync(join(workspace,'.git'),'utf8').trim(),`gitdir: ${project.gitDir}`,'Checkpoint Git workspace pointer changed');
  const base=artifact.baseCommit??project.baseCommit;assert.ok([base,artifact.identity].every(id=>typeof id==='string'&&/^[a-f0-9]{40,64}$/i.test(id)),'Checkpoint requires immutable baseline and commit identities');
  const git=(args:string[])=>checked('git',['--git-dir',project.gitDir,'--work-tree',workspace,'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.sshCommand=false','-c','core.pager=cat','-c','diff.external=','-c','core.attributesFile=/dev/null',...args],{cwd:workspace,env:{...brokerEnvironment(),GIT_CONFIG_GLOBAL:'/dev/null'}});
  assert.equal(await git(['rev-parse',`${artifact.identity}^{commit}`]),artifact.identity,'Checkpoint object is not its recorded commit');assert.equal(await git(['rev-parse',`${base}^{commit}`]),base,'Checkpoint baseline is not its recorded commit');await git(['merge-base','--is-ancestor',base!,artifact.identity]);
  const diff=await git(['diff','--stat','--no-ext-diff','--no-textconv',base!,artifact.identity,'--']);assert.ok(diff.trim(),'Checkpoint commit has no actual change from its baseline');proof={kind:'commit',baseCommit:base,identity:artifact.identity,diff};
 }
 return {projectId:project.id,name:project.name,productId:project.productId,artifactId:artifact.id,employeeId:run.employeeId,assignmentId:assignment.id,runId:run.id,identity:artifact.identity,uri:artifact.uri,proof};
}

/** DoD 5 permits executable progress: company verification/review can advance a
 * project without authoring its imported source. This never satisfies DoD 4. */
export async function verifyReviewedExternalCheckpoint(state:CompanySnapshot,artifact:Artifact,input:{dataRoot:string;otherProjectId?:string}){
 assert.ok(!isEmployeeAuthoredArtifact(artifact)&&artifact.sourcePullRequest&&artifact.reviewWorkspace,'External checkpoint needs complete imported candidate provenance');
 assert.equal(artifact.kind,'commit','External checkpoint must retain the imported commit kind');
 assert.deepEqual(state.artifacts.find(item=>item.id===artifact.id),artifact,'External checkpoint is not its retained company artifact');
 assert.ok(input.otherProjectId&&state.projects.some(item=>item.id===input.otherProjectId),'External second-project proof requires the retained first delivery project');
 const project=state.projects.find(item=>item.id===artifact.projectId);assert.ok(project&&project.id!==input.otherProjectId,'Checkpoint must belong to a separate retained project');
 assert.ok(project.outcome?.trim()&&project.acceptance?.length,'Checkpoint project lacks its finite outcome and acceptance');
 const product=state.products.find(item=>item.id===project.productId);assert.ok(product&&state.policy.allowedRepositories.includes(product.repository)&&product.binding,'External checkpoint requires a registered connected product');
 const source=artifact.sourcePullRequest,physical=artifactProject(project,artifact),assignment=state.assignments.find(item=>item.id===artifact.assignmentId),candidate=assignment?.pullRequestCandidate;
 assert.ok(assignment&&assignment.projectId===project.id&&assignment.kind==='implementation'&&candidate,'Imported checkpoint lacks its selected finite assignment');
 assert.match(assignment.id,/^[A-Za-z0-9-]+$/);assert.ok(Number.isSafeInteger(source.number)&&source.number>0);
 for(const key of ['repository','url','authorLogin','baseRef','headRepository','headRef'] as const)assert.ok(typeof source[key]==='string'&&source[key].trim(),`Candidate ${key} is missing`);
 assert.ok([source.baseSha,source.headSha].every(value=>typeof value==='string'&&/^[a-f0-9]{40,64}$/.test(value)),'Candidate requires immutable base/head identities');
 assert.equal(source.repository,product.binding.repository);assert.equal(source.baseRef,product.binding.defaultBranch);
 assert.equal(source.url,`https://github.com/${source.repository}/pull/${source.number}`);assert.equal(artifact.uri,source.url);
 assert.equal(candidate.assignmentId,assignment.id);assert.deepEqual(candidate.source,source);assert.deepEqual(candidate.workspace,artifact.reviewWorkspace);
 assert.equal(assignment.payload?.pullRequest?.number,source.number);assert.equal(assignment.payload?.pullRequest?.headSha,source.headSha);
 assert.equal(physical.workspace,join(input.dataRoot,'workspaces',`pr-${assignment.id}-${source.headSha}`));assert.equal(physical.mirror,product.binding.mirror);
 const workspace=safeChild(join(input.dataRoot,'workspaces'),physical.workspace!),gitDir=safeChild(join(input.dataRoot,'repositories'),physical.gitDir);
 assert.ok(!lstatSync(physical.workspace!).isSymbolicLink());safeChild(product.binding.mirror,gitDir);
 assert.equal(readFileSync(join(workspace,'.git'),'utf8').trim(),`gitdir: ${physical.gitDir}`,'Candidate Git pointer changed');
 const gitArgs=['--git-dir',gitDir,'--work-tree',workspace,'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.sshCommand=false','-c','core.pager=cat','-c','diff.external=','-c','core.attributesFile=/dev/null'];
 const gitOptions={cwd:workspace,env:{...brokerEnvironment(),GIT_CONFIG_GLOBAL:'/dev/null'}},git=(args:string[])=>checked('git',[...gitArgs,...args],gitOptions);
 assert.equal(await git(['rev-parse','HEAD']),source.headSha,'Candidate workspace head changed');assert.equal(await git(['status','--porcelain']),'','Candidate workspace is dirty');
 assert.equal(await git(['rev-parse',`${source.baseSha}^{commit}`]),source.baseSha);await git(['merge-base','--is-ancestor',source.baseSha,source.headSha]);
 const diff=(await promisify(execFile)('/usr/bin/git',[...gitArgs,'diff','--stat','--patch','--full-index','--no-ext-diff','--no-textconv',source.baseSha,source.headSha,'--'],{...gitOptions,encoding:'buffer',maxBuffer:2_000_000,timeout:30000})).stdout;
 const text=diff.toString('utf8');assert.ok(text.trim()&&Buffer.from(text,'utf8').equals(diff)&&!text.includes('\0'),'Candidate needs its complete nonempty readable diff');
 const ownFile=(path:string,root=input.dataRoot)=>{assert.equal(typeof path,'string','Evidence file path is missing');const resolved=safeChild(root,path),stat=lstatSync(path);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0,'Evidence must be a retained nonempty regular file');return resolved;};
 const timestamp=(value:string)=>{const at=Date.parse(value);assert.ok(Number.isFinite(at),'Evidence timestamp is missing');return at;};
 const local=(id:string)=>{
  const run=state.runs.find(item=>item.id===id);assert.ok(run&&state.employees.some(employee=>employee.id===run.employeeId),'Checkpoint employee run is missing');
  assert.equal(run.status,'succeeded');assert.ok(run.sessionId&&run.modelIdentity&&run.usage?.requests>0,'Checkpoint needs actual local inference');assert.equal(realpathSync(run.workspace!),workspace,'Checkpoint run used a different candidate workspace');
  const bindingPath=ownFile(join(input.dataRoot,'runtime','employees',run.id,'binding.json')),binding=JSON.parse(readFileSync(bindingPath,'utf8'));
  assert.equal(binding.runId,run.id);assert.equal(binding.employeeId,run.employeeId);assert.equal(binding.sessionId,run.sessionId);assert.equal(realpathSync(binding.workspace),workspace);
  assert.equal(binding.model?.local,true);assert.equal(binding.model?.provider,'ollama');assert.equal(binding.model?.artifactIdentity,run.modelIdentity);assert.ok(typeof binding.model?.alias==='string'&&!/cloud|openai|anthropic|openrouter/i.test(binding.model.alias));
  const messagesPath=ownFile(run.messagesPath,join(input.dataRoot,'runtime','employees',run.id)),messages=JSON.parse(readFileSync(messagesPath,'utf8'));
  assert.ok(Array.isArray(messages)&&messages.length&&messages.every((message:any)=>message.info?.sessionID===run.sessionId),'Messages belong to another native session');
  assert.ok(messages.some((message:any)=>message.info.role==='assistant'&&message.info.time?.completed&&!message.info.error&&message.info.providerID==='opencorp-local'&&message.info.modelID===binding.model.alias),'Completed local native assistant evidence is absent');
  const tools=messages.flatMap((message:any)=>message.parts??[]).filter((part:any)=>part.type==='tool'&&part.state?.status==='completed');
  return {run,tools,evidence:{runId:run.id,employeeId:run.employeeId,sessionId:run.sessionId,modelIdentity:run.modelIdentity,messagesPath,bindingPath}};
 };
 const completedTool=(proof:ReturnType<typeof local>,name:string,accept:(part:any,output:any)=>boolean)=>{
  const found=proof.tools.find((part:any)=>{if(part.tool!==`corporate_${name}`)return false;try{return accept(part,JSON.parse(part.state.output));}catch{return false;}});
  assert.ok(found,`Actual completed ${name} receipt is missing from this native run`);return found;
 };
 const importer=local(artifact.runId);assert.equal(importer.run.employeeId,artifact.employeeId);assert.equal(importer.run.assignmentId,assignment.id);
 assert.ok(importer.run.corporateCommands?.some((command:any)=>command.type==='artifact.record'&&command.id===artifact.id),'Imported record lacks its actual employee command');
 completedTool(importer,'import_pull_request',(_part,output)=>output.command==='artifact.record'&&output.id===artifact.id&&output.identity===artifact.identity);
 assert.ok(timestamp(source.observedAt)<=timestamp(artifact.createdAt));
 const verification=artifact.verification;assert.ok(verification?.passed&&verification.identity===artifact.identity&&verification.receiptId&&verification.exitCode===0,'Current exact candidate canonical receipt is absent');
 const verifier=local(verification.runId),verifierAssignment=state.assignments.find(item=>item.id===verifier.run.assignmentId);
 assert.ok(verifierAssignment?.projectId===project.id&&(verifierAssignment.id===assignment.id||verifierAssignment.kind==='review'&&verifierAssignment.payload?.artifactId===artifact.id),'Verification run did not own this candidate assignment');
 assert.equal(verification.command,canonicalVerification(product.name,workspace,artifact.baseCommit));
 assert.ok(timestamp(verification.completedAt)>=timestamp(artifact.createdAt)&&timestamp(verification.completedAt)>=timestamp(verifier.run.createdAt)&&timestamp(verification.completedAt)<=timestamp(verifier.run.endedAt),'Canonical receipt predates this import or belongs to another run');
 assert.equal(verification.logPath,join(input.dataRoot,'logs','verification',`${artifact.id}.log`));const logPath=ownFile(verification.logPath,join(input.dataRoot,'logs','verification'));
 assert.ok(artifact.checks.length&&artifact.checks.every(check=>check.source==='canonical-verifier'&&check.identity===artifact.identity&&check.status==='passed'&&check.exitCode===0&&check.unchanged===true&&check.command===verification.command&&check.logPath===verification.logPath&&check.finishedAt===verification.completedAt),'Passing canonical checks do not match the current exact receipt');
 assert.ok(verifier.run.verificationDependencies?.installed&&verifier.run.verificationDependencies.artifactId===artifact.id&&verifier.run.verificationDependencies.incrementalCost===0,'Canonical execution lacks this run\'s completed zero-cost dependency preparation');
 for(const check of artifact.checks){assert.equal(check.dependencyReceipt,verifier.run.verificationDependencies.receiptPath);ownFile(check.dependencyReceipt,join(input.dataRoot,'runtime','dependency-environments'));}
 completedTool(verifier,'verify_product',(part,output)=>part.state.input?.artifactId===artifact.id&&artifact.checks.every(check=>Object.entries(check).every(([key,value])=>JSON.stringify(output[key])===JSON.stringify(value))));
 const reviews=state.reviews.filter(review=>review.artifactId===artifact.id&&review.artifactIdentity===artifact.identity&&review.verdict==='approved'&&review.employeeId!==artifact.employeeId&&review.runId!==artifact.runId&&review.rationale?.trim());
 let independent:Record<string,any>|undefined;const reviewErrors:string[]=[];
 for(const review of reviews){try{
  const reviewer=local(review.runId),reviewAssignment=state.assignments.find(item=>item.id===reviewer.run.assignmentId);assert.equal(reviewer.run.employeeId,review.employeeId);
  assert.ok(reviewAssignment?.kind==='review'&&reviewAssignment.projectId===project.id&&reviewAssignment.payload?.artifactId===artifact.id,'Reviewer lacks its separate exact-artifact assignment');
  assert.ok(reviewer.run.corporateCommands?.some((command:any)=>command.type==='review.record'&&command.id===review.id));assert.deepEqual(review.checks,artifact.checks,'Review used different or historical canonical checks');
  assert.ok(timestamp(review.createdAt)>=timestamp(verification.completedAt)&&timestamp(review.createdAt)>=timestamp(reviewer.run.createdAt)&&timestamp(review.createdAt)<=timestamp(reviewer.run.endedAt));
  const inspection=reviewer.run.artifactInspections?.[artifact.id];assert.ok(inspection?.complete&&inspection.artifactId===artifact.id&&inspection.base===source.baseSha&&inspection.head===source.headSha&&inspection.contentIdentity===createHash('sha256').update(diff).digest('hex')&&inspection.totalCharacters===text.length,'Reviewer did not inspect this complete exact candidate diff');
  assert.deepEqual(inspection.ranges,[[0,text.length]]);assert.ok(timestamp(inspection.inspectedAt)>=timestamp(reviewer.run.createdAt)&&timestamp(inspection.inspectedAt)<=timestamp(review.createdAt));
  completedTool(reviewer,'inspect_artifact',(part,output)=>part.state.input?.artifactId===artifact.id&&output.inspectionComplete===true&&output.contentIdentity===inspection.contentIdentity&&output.head===artifact.identity&&output.base===source.baseSha);
  const reviewScope=(review.projectAcceptance??[]).filter((entry:any)=>['artifact','delivery','release'].includes(entry.source)&&project.acceptance.includes(entry.criterion)&&typeof entry.evidence==='string'&&entry.evidence.trim()&&(entry.source!=='release'||typeof entry.version==='string'&&entry.version.trim()));assert.ok(reviewScope.length,'Independent review must explicitly connect candidate evidence to a current project criterion');
  completedTool(reviewer,'review_work',(part,output)=>part.state.input?.artifactId===artifact.id&&part.state.input?.verdict==='approved'&&output.command==='review.record'&&output.id===review.id&&output.artifactIdentity===artifact.identity);
  independent={...reviewer.evidence,reviewId:review.id,rationale:review.rationale,reviewScope,inspection};break;
 }catch(error){reviewErrors.push(String(error));}}
 assert.ok(independent,`Substantive independent current-candidate review is absent: ${reviewErrors.join('; ')}`);
 const live=JSON.parse(await checked('gh',['api',`repos/${source.repository}/pulls/${source.number}`]));
 const observed={repository:live.base?.repo?.full_name,number:live.number,url:live.html_url,authorLogin:live.user?.login,baseRef:live.base?.ref,baseSha:live.base?.sha,headRepository:live.head?.repo?.full_name,headRef:live.head?.ref,headSha:live.head?.sha};
 for(const [key,value] of Object.entries(observed))assert.equal(value,source[key as keyof typeof source],`Live PR ${key} changed after candidate review`);
 assert.equal(await git(['rev-parse','HEAD']),source.headSha);assert.equal(await git(['status','--porcelain']),'','Candidate changed while checking evidence');
 return {projectId:project.id,name:project.name,productId:product.id,artifactId:artifact.id,identity:artifact.identity,uri:artifact.uri,
  proof:{kind:'reviewed-external-candidate',checkpoint:'executable-progress',externallyAuthored:true,sourceAuthor:source.authorLogin,sourcePullRequest:source,
   importer:importer.evidence,verifier:verifier.evidence,reviewer:independent,verification:{...verification,logPath,logSha256:createHash('sha256').update(readFileSync(logPath)).digest('hex')},checks:artifact.checks,
   outcome:project.outcome,workspace,observedAt:new Date().toISOString(),claim:'Company-performed verification and independent review of external source; no company code authorship, merge or project-completion claim.'}};
}

/** Retained API-only controls cannot stand in for actual Owner UI/CLI actions. */
export function verifyOwnerSurfaceEvidence(evidence:any,state:CompanySnapshot,sourceIdentity:{fingerprint:string;files:Record<string,string>}){
 assert.equal(evidence?.kind,'installed-owner-surface-mutations','Run --controls to exercise the actual WebUI and compiled CLI');assert.equal(evidence.passed,true,'Owner surface mutation verification did not pass');assert.equal(evidence.companyId,state.company.id,'Owner surface evidence belongs to another company');assert.deepEqual(evidence.sourceIdentity,sourceIdentity,'Owner surface evidence predates the current interfaces or verification helper');assert.deepEqual(evidence.browserErrors,[],'Owner surface browser errors were observed');
 assert.ok(evidence.screenshots?.length,'Actual Owner mutation screenshots are missing');
 const chats:any[]=[];
 for(const surface of ['webui','compiled-cli']){
  for(const action of ['start','pause','resume','stop']){
   const receipt=evidence.controls?.find((item:any)=>item.surface===surface&&item.action===action);assert.ok(receipt,`${surface} ${action} was not exercised`);assert.equal(receipt.companyId,state.company.id);assert.equal(receipt.apiMethod,'POST');assert.equal(receipt.apiPath,'/api/v1/control');assert.equal(receipt.afterState,action==='pause'?'paused':action==='stop'?'stopped':'running');
   if(surface==='webui'&&action==='resume')assert.equal(receipt.beforeState,'paused','WebUI Start cannot be relabeled as Resume');
  }
  const receipt=evidence.chats?.find((item:any)=>item.surface===surface);assert.ok(receipt,`${surface} chat submission was not exercised`);assert.equal(receipt.companyId,state.company.id);assert.equal(receipt.apiMethod,'POST');assert.equal(receipt.apiPath,'/api/v1/chat');assert.equal(receipt.delivery,'persisted_response_queued');assert.equal(receipt.assignmentStatus,'queued');
  const message=state.messages.find(item=>item.id===receipt.messageId),assignment=state.assignments.find(item=>item.id===receipt.assignmentId);assert.ok(message&&assignment,`${surface} chat or response assignment is no longer retained`);assert.equal(message.senderId,'owner');assert.equal(message.recipientId,receipt.recipientId);assert.equal(message.projectId??null,receipt.projectId??null);assert.equal(message.content,receipt.content);assert.ok(message.content.trim());assert.equal(assignment.kind,'conversation');assert.equal(assignment.payload?.messageId,message.id,'Response assignment belongs to a different message');assert.equal(assignment.projectId??null,receipt.projectId??null);chats.push(receipt);
 }
 assert.equal(new Set(chats.map(item=>item.messageId)).size,2,'Both interfaces must submit their own actual message');assert.equal(new Set(chats.map(item=>item.assignmentId)).size,2,'Both interfaces must retain their own response assignment');
 return evidence;
}

/** A terminal-window surface pass may retain an earlier actual interruption,
 * but an idle control run alone cannot establish restart-during-work proof. */
export function verifyActiveWorkEvidence(evidence:any,state:CompanySnapshot){
 assert.ok(evidence,'Actual interruption evidence is missing');assert.equal(evidence.companyId,state.company.id);assert.equal(evidence.passed,true);assert.equal(evidence.startedWithActiveRun,true,'Restart-during-work needs a current or retained real active employee run');
 assert.ok(Array.isArray(evidence.activeRunIds)&&evidence.activeRunIds.length&&evidence.activeRunIds.every((id:string)=>state.runs.some(run=>run.id===id)),'Original interrupted run history was lost');
 assert.equal(evidence.pausedRestart?.method,'serviceInstall');assert.equal(evidence.stoppedRestart?.method,'serviceInstall');assert.ok(evidence.identitiesPreserved&&evidence.responsibilitiesPreserved&&evidence.filesPreserved&&evidence.stopSurvivedRestart,'Actual interruption lacks durable responsibility and file preservation proof');
 return evidence;
}

/** Provider observations must describe this exact delivered milestone, not an
 * older comment that happens to name the same remaining issue gate. */
export function verifyPartialIssueComment(input:{projectId:string;productId:string;artifactIdentity:string;prUrl:string;mergeCommit:string;delivery:DeliveryReceipt;action:ExternalAction;issue:{url:string};comment:{id:number;html_url:string;issue_url:string;body:string}}){
 const {projectId,productId,artifactIdentity,prUrl,mergeCommit,delivery,action,issue,comment}=input;
 assert.equal(delivery.closeIssue,false,'Open issue requires an explicit partial delivery');
 assert.ok(Number.isInteger(delivery.issueNumber)&&delivery.issueNumber!>0,'Exact delivered issue number is missing');
 assert.ok(delivery.remainingGate?.trim(),'Open issue lacks an exact remaining gate');
 assert.equal(action.id,delivery.issueEvidenceActionId,'Verification comment action differs from this delivery receipt');
 assert.equal(action.kind,'communication');assert.equal(action.status,'succeeded');assert.equal(action.productId,productId);assert.equal(action.content?.kind,'issue_comment');assert.equal(action.content?.number,delivery.issueNumber);
 assert.equal(action.dedupeKey,`delivery-evidence:${projectId}:${artifactIdentity}`,'Verification comment belongs to a different delivered artifact');
 assert.ok(issue.url&&action.remoteRef,'Provider issue/comment references are missing');
 assert.equal(comment.id,action.result?.id,'Provider comment ID differs from the observed action receipt');assert.equal(comment.html_url,action.remoteRef,'Provider comment URL differs from the action receipt');assert.equal(comment.issue_url,issue.url,'Provider comment belongs to a different issue');
 assert.equal(typeof comment.body,'string','Provider verification comment body is missing');
 for(const [label,value] of [['action marker',`<!-- opencorp-action:${action.id} -->`],['remaining issue gate',delivery.remainingGate],['pull request',prUrl],['artifact identity',artifactIdentity],['merge commit',mergeCommit]])assert.ok(value&&comment.body.includes(value),`Provider verification comment lacks the exact ${label}`);
}
