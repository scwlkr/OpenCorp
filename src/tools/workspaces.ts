import { existsSync, mkdirSync, readFileSync, realpathSync, lstatSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Product, Project, Artifact, Assignment, SourcePullRequest, PullRequestCandidate } from '../core/types.js';
import { DomainError } from '../core/types.js';
import { checked, brokerEnvironment } from './process.js';
import { CompanyStore } from '../storage/store.js';

export function safeChild(root:string, path:string) {const base=realpathSync(root), resolved=realpathSync(path), rel=relative(base,resolved);if(rel.startsWith('..')||isAbsolute(rel))throw new DomainError('path_denied','Path is outside the assigned workspace.',403);return resolved;}
export function parseRepository(remote:string) {const match=remote.match(/(?:github\.com[:/])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/);if(!match)throw new Error('Only configured GitHub repositories are supported for credentialed delivery.');return match[1]!;}
/** Physical review/check location; logical project ownership never changes. */
export function artifactProject(project:Project,artifact:Artifact):Project {
 if(!Object.hasOwn(artifact,'sourcePullRequest')&&!Object.hasOwn(artifact,'reviewWorkspace'))return project;
 const source=artifact.sourcePullRequest,workspace=artifact.reviewWorkspace;
 if(!source||!workspace||artifact.projectId!==project.id||artifact.identity!==source.headSha||artifact.baseCommit!==source.baseSha||workspace.baseCommit!==source.baseSha)throw new DomainError('pull_request_provenance','Imported artifact source and workspace identity are incomplete or inconsistent',403);
 return {...project,...workspace};
}
export class WorkspaceManager {
 constructor(public store:CompanyStore,public dataRoot:string){}
 async readPullRequest(product:Product,number:number,options:{signal?:AbortSignal}={}){
  if(!Number.isSafeInteger(number)||number<1)throw new DomainError('invalid_pull_request','A positive PR number is required');
  if(!this.store.policy.allowedRepositories.includes(product.repository)||!product.binding?.repository)throw new DomainError('repository_denied','Inspect this registered product before reading its PR',403);
  const repository=product.binding.repository,pr=JSON.parse(await checked('gh',['api',`repos/${repository}/pulls/${number}`],{signal:options.signal}));
  if(pr.number!==number||pr.base?.repo?.full_name!==repository||pr.base?.ref!==product.binding.defaultBranch||!/^https:\/\/github\.com\//.test(pr.html_url??'')||pr.html_url!==`https://github.com/${repository}/pull/${number}`||![pr.base?.sha,pr.head?.sha].every(sha=>typeof sha==='string'&&/^[a-f0-9]{40,64}$/.test(sha))||typeof pr.head?.repo?.full_name!=='string'||typeof pr.head?.ref!=='string'||typeof pr.user?.login!=='string')throw new DomainError('pull_request_identity','Provider response does not identify the selected product PR and default base',409);
  const source:SourcePullRequest={repository,number,url:pr.html_url,authorLogin:pr.user.login,baseRef:pr.base.ref,baseSha:pr.base.sha,headRepository:pr.head.repo.full_name,headRef:pr.head.ref,headSha:pr.head.sha,observedAt:new Date().toISOString()};
  return {source,title:String(pr.title??''),body:String(pr.body??''),state:pr.state,merged:pr.merged===true,mergeable:pr.mergeable,draft:pr.draft===true};
 }
 async assertPullRequest(project:Project,source:SourcePullRequest,options:{signal?:AbortSignal}={}){
  const product=this.store.need('products',project.productId!),live=await this.readPullRequest(product,source.number,options);
  for(const key of ['repository','number','url','authorLogin','baseRef','baseSha','headRepository','headRef','headSha'] as const)if(live.source[key]!==source[key])throw new DomainError('pull_request_changed',`Selected PR ${source.number} ${key} changed; preserve this candidate and have management select/review the new exact source`,409);
  if(live.state!=='open'||live.merged||live.draft)throw new DomainError('pull_request_not_open','Selected PR is closed, merged or draft; management must disposition this exact candidate',409);
  return live;
 }
 pullRequestWorkspace(assignment:Assignment){
  const selected=assignment.payload?.pullRequest;if(!selected||!Number.isSafeInteger(selected.number)||selected.number<1||typeof selected.headSha!=='string'||!/^[a-f0-9]{40,64}$/.test(selected.headSha)||!/^[a-zA-Z0-9-]+$/.test(assignment.id))throw new DomainError('pull_request_scope','Select an exact finite PR assignment before preparing its workspace',403);
  return join(this.dataRoot,'workspaces',`pr-${assignment.id}-${selected.headSha}`);
 }
 forAssignment(assignment:Assignment):Project {
  const project=this.store.need('projects',assignment.projectId!);
  if(assignment.payload?.artifactId){const artifact=this.store.need('artifacts',assignment.payload.artifactId);if(artifact.projectId!==project.id)throw new DomainError('wrong_project','Assigned artifact belongs to another project',403);return this.artifact(project,artifact);}
  const candidate=assignment.pullRequestCandidate as PullRequestCandidate|undefined;
  if(Object.hasOwn(assignment,'pullRequestCandidate')){const product=this.store.need('products',project.productId!);if(!candidate||candidate.assignmentId!==assignment.id||candidate.source?.repository!==product.binding?.repository||candidate.source?.number!==assignment.payload?.pullRequest?.number||candidate.source?.headSha!==assignment.payload?.pullRequest?.headSha||candidate.workspace?.workspace!==this.pullRequestWorkspace(assignment)||candidate.workspace.mirror!==product.binding?.mirror)throw new DomainError('pull_request_scope','Prepared candidate no longer matches its explicit assignment',403);const resolved={...project,...candidate.workspace};this.validate(resolved);safeChild(candidate.workspace.mirror,candidate.workspace.gitDir);return resolved;}
  return project;
 }
 artifact(project:Project,artifact:Artifact):Project {
  const resolved=artifactProject(project,artifact);
  if(Object.hasOwn(artifact,'sourcePullRequest')||Object.hasOwn(artifact,'reviewWorkspace')){
   const assignment=this.store.need('assignments',artifact.assignmentId),candidate=assignment.pullRequestCandidate as PullRequestCandidate|undefined,product=this.store.need('products',project.productId!);
   if(!candidate||assignment.projectId!==project.id||this.store.need('runs',artifact.runId).assignmentId!==assignment.id||candidate.source.repository!==product.binding?.repository||candidate.workspace.mirror!==product.binding?.mirror||candidate.source.number!==assignment.payload?.pullRequest?.number||candidate.source.headSha!==assignment.payload?.pullRequest?.headSha||candidate.assignmentId!==assignment.id||JSON.stringify(candidate.source)!==JSON.stringify(artifact.sourcePullRequest)||JSON.stringify(candidate.workspace)!==JSON.stringify(artifact.reviewWorkspace)||candidate.workspace.workspace!==this.pullRequestWorkspace(assignment))throw new DomainError('pull_request_provenance','Artifact does not retain its actual assigned provider candidate',403);
   this.validate(resolved);safeChild(candidate.workspace.mirror,candidate.workspace.gitDir);
  }
  return resolved;
 }
 async preparePullRequest(assignment:Assignment,options:{assertActive:()=>void;signal?:AbortSignal}):Promise<Project>{
  options.assertActive();const project=this.store.need('projects',assignment.projectId!),product=this.store.need('products',project.productId!),selected=assignment.payload?.pullRequest,workspace=this.pullRequestWorkspace(assignment);
  if(assignment.kind!=='implementation')throw new DomainError('pull_request_scope','Only the explicitly selected implementation assignment prepares a PR candidate',403);
  if(!product.binding)throw new DomainError('product_not_inspected','Management must repo_inspect the registered product before selecting an exact existing PR',409);options.assertActive();
  const currentProduct=this.store.need('products',product.id),live=await this.readPullRequest(currentProduct,selected.number,options);options.assertActive();
  if(live.source.headSha!==selected.headSha)throw new DomainError('pull_request_changed','Selected PR head moved; management must select the new exact head in a new finite assignment',409);
  const prior=this.store.need('assignments',assignment.id).pullRequestCandidate as PullRequestCandidate|undefined;
  if(prior){await this.assertPullRequest(project,prior.source,options);const resolved=this.forAssignment(this.store.need('assignments',assignment.id));this.validate(resolved);if(await this.head(resolved,options)!==prior.source.headSha||!await this.clean(resolved,options))throw new DomainError('candidate_changed','Preserved PR candidate contains changes; no automatic reset is permitted',409);options.assertActive();return resolved;}
  await this.assertPullRequest(project,live.source,options);options.assertActive();
  const mirror=currentProduct.binding.mirror,branch=`opencorp-pr-${assignment.id}-${selected.headSha}`,env={...brokerEnvironment(),GIT_CONFIG_GLOBAL:'/dev/null'},git=(args:string[])=>checked('git',['--git-dir',mirror,'-c','core.hooksPath=/dev/null','-c','credential.helper=',...args],{env,signal:options.signal,timeoutMs:120000});
  safeChild(join(this.dataRoot,'repositories'),mirror);
  await git(['fetch','--no-tags',`https://github.com/${live.source.repository}.git`,`refs/pull/${selected.number}/head`]);options.assertActive();
  if(await git(['rev-parse','FETCH_HEAD'])!==selected.headSha)throw new DomainError('pull_request_changed','Fetched PR ref no longer matches the explicitly selected head',409);
  await git(['fetch','--no-tags',`https://github.com/${live.source.repository}.git`,live.source.baseSha]);options.assertActive();
  try{await git(['merge-base','--is-ancestor',live.source.baseSha,selected.headSha]);}catch{throw new DomainError('pull_request_behind','PR must include its current default base before canonical review; management may request a provider rebase and select the resulting new head',409);}
  await this.assertPullRequest(project,live.source,options);options.assertActive();mkdirSync(join(this.dataRoot,'workspaces'),{recursive:true});
  if(!existsSync(workspace))await git(['worktree','add','-b',branch,workspace,selected.headSha]);
  options.assertActive();if(lstatSync(workspace).isSymbolicLink())throw new DomainError('candidate_changed','Candidate workspace is a symlink',403);safeChild(join(this.dataRoot,'workspaces'),workspace);
  const gitDir=await checked('git',['-C',workspace,'rev-parse','--absolute-git-dir'],{env,signal:options.signal}),candidate:PullRequestCandidate={assignmentId:assignment.id,source:live.source,workspace:{workspace,gitDir,mirror,branch,baseCommit:live.source.baseSha}};
  const resolved={...project,...candidate.workspace};this.validate(resolved);safeChild(mirror,gitDir);if(await this.head(resolved,options)!==selected.headSha||!await this.clean(resolved,options))throw new DomainError('candidate_changed','Existing candidate workspace differs from the selected clean PR; preserved without reset',409);
  await this.assertPullRequest(project,live.source,options);options.assertActive();this.store.update('assignments',assignment.id,{pullRequestCandidate:candidate});return resolved;
 }
 private async readBlob(mirror:string,commit:string,file:string):Promise<string>{
  if(!/^[a-f0-9]{40,64}$/i.test(commit))throw new DomainError('source_identity_required','Source reads require the recorded immutable baseline commit.',409);
  safeChild(join(this.dataRoot,'repositories'),mirror);
  const object=`${commit}:${file}`,env={...brokerEnvironment(),GIT_CONFIG_GLOBAL:'/dev/null'},maximum=2_000_000;
  const size=Number(await checked('git',['--git-dir',mirror,'cat-file','-s',object],{env}));
  if(!Number.isSafeInteger(size)||size<0||size>maximum)throw new DomainError('source_too_large',`Source exceeds the ${maximum}-byte read limit; select a smaller source file or inspect it in the assigned workspace.`,413);
  // checked() intentionally trims/redacts bounded process logs. Source text needs
  // the complete immutable blob, otherwise later character pages can lose data.
  const raw=await promisify(execFile)('/usr/bin/git',['--git-dir',mirror,'cat-file','blob',object],{env,encoding:'buffer',maxBuffer:maximum,timeout:30_000});
  if(raw.stdout.length!==size)throw new DomainError('source_incomplete','Git returned incomplete source content; no partial file is presented.',409);
  const content=raw.stdout.toString('utf8');
  if(!Buffer.from(content,'utf8').equals(raw.stdout)||content.includes('\0'))throw new DomainError('source_not_text','This source is not a UTF-8 text file; use the product workspace for binary artifacts.',415);
  return content;
 }
 async inspect(product:Product) {
  if(!this.store.snapshot().policy.allowedRepositories.includes(product.repository))throw new DomainError('repository_denied','Repository outside Owner envelope.',403);
  const remote=await checked('git',['-C',product.repository,'remote','get-url','origin']);const repo=parseRepository(remote);
  const details=JSON.parse(await checked('gh',['repo','view',repo,'--json','nameWithOwner,url,isPrivate,defaultBranchRef']));
  const issues=JSON.parse(await checked('gh',['issue','list','--repo',repo,'--state','open','--limit','40','--json','number,title,body,url,labels']));
  const pulls=JSON.parse(await checked('gh',['pr','list','--repo',repo,'--state','open','--limit','20','--json','number,title,headRefName,url']));
  const localStatus=await checked('git',['-C',product.repository,'status','--short']);
  const originalHead=await checked('git',['-C',product.repository,'rev-parse','HEAD']);
  const mirror=join(this.dataRoot,'repositories',`${product.id}.git`);mkdirSync(join(this.dataRoot,'repositories'),{recursive:true});
  const env={...brokerEnvironment(),GIT_CONFIG_GLOBAL:'/dev/null'};
  if(!existsSync(mirror))await checked('git',['-c','credential.helper=','clone','--bare',`https://github.com/${repo}.git`,mirror],{env,timeoutMs:120_000});
  await checked('git',['--git-dir',mirror,'-c','core.hooksPath=/dev/null','-c','credential.helper=','fetch',`https://github.com/${repo}.git`,`+refs/heads/${details.defaultBranchRef.name}:refs/remotes/origin/${details.defaultBranchRef.name}`],{env,timeoutMs:120_000});
  const baseCommit=await checked('git',['--git-dir',mirror,'rev-parse',`refs/remotes/origin/${details.defaultBranchRef.name}`],{env});
  const files:Record<string,string>={},fileMetadata:Record<string,{totalCharacters:number;storedCharacters:number;truncated:boolean}>={};for(const file of ['AGENTS.md','README.md','docs/STATUS.md','docs/ROADMAP.md','docs/CONTRIBUTING.md','docs/agents/issue-tracker.md','package.json','Makefile','.ruby-version','.github/workflows/ci.yml']) {
   try{const content=await this.readBlob(mirror,baseCommit,file);files[file]=content.slice(0,file==='docs/STATUS.md'?9000:14000);fileMetadata[file]={totalCharacters:content.length,storedCharacters:files[file].length,truncated:files[file].length<content.length};}catch{/* Not every product uses every convention. Read an individual file for explicit errors. */}
  }
  const binding={repository:repo,url:details.url,defaultBranch:details.defaultBranchRef.name,public:!details.isPrivate,mirror,baseCommit,originalHead,localStatus,issues,pulls,files,fileMetadata,refreshedAt:new Date().toISOString()};
  this.store.update('products',product.id,{binding});this.store.emit('product.inspected',{productId:product.id,baseCommit,openIssues:issues.length});return binding;
 }
 async ensure(project:Project) {
  if(project.workspace){this.validate(project);return project;}
  if(!project.productId){const workspace=join(this.dataRoot,'workspaces',project.id);mkdirSync(workspace,{recursive:true});return this.store.update('projects',project.id,{workspace});}
  const product=this.store.get('products',project.productId)!;let binding=product.binding;if(!binding)binding=await this.inspect(product);
  const branch=`opencorp/${project.id}`,workspace=join(this.dataRoot,'workspaces',project.id);mkdirSync(join(this.dataRoot,'workspaces'),{recursive:true});
  const env={...brokerEnvironment(),GIT_CONFIG_GLOBAL:'/dev/null'};
  if(!existsSync(workspace))await checked('git',['--git-dir',binding.mirror,'-c','core.hooksPath=/dev/null','worktree','add','-b',branch,workspace,binding.baseCommit],{env,timeoutMs:30_000});
  const gitDir=await checked('git',['-C',workspace,'rev-parse','--absolute-git-dir'],{env});
  return this.store.update('projects',project.id,{workspace,branch,baseCommit:binding.baseCommit,gitDir,mirror:binding.mirror});
 }
 validate(project:Project){if(!project.workspace)throw new Error('Project workspace not created.');const root=join(this.dataRoot,'workspaces');safeChild(root,project.workspace);if(lstatSync(project.workspace).isSymbolicLink())throw new Error('Project workspace symlink is forbidden.');if(project.productId){if(!project.gitDir||!existsSync(project.gitDir))throw new Error('Project git metadata missing.');safeChild(join(this.dataRoot,'repositories'),project.gitDir);const pointer=readFileSync(join(project.workspace,'.git'),'utf8').trim();if(pointer!==`gitdir: ${project.gitDir}`)throw new Error('Project git pointer changed; refusing credentialed operation.');}return project.workspace;}
 async git(project:Project,args:string[],options:{timeoutMs?:number;input?:string;signal?:AbortSignal}={}) {this.validate(project);return checked('git',['--git-dir',project.gitDir,'--work-tree',project.workspace!,'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.sshCommand=false','-c','core.pager=cat','-c','diff.external=','-c','core.attributesFile=/dev/null',...args],{cwd:project.workspace,env:{...brokerEnvironment(),GIT_CONFIG_GLOBAL:'/dev/null'},...options});}
 async readDiff(project:Project,base:string,head:string):Promise<string>{
  this.validate(project);if(![base,head].every(id=>typeof id==='string'&&/^[a-f0-9]{40,64}$/i.test(id)))throw new DomainError('artifact_identity_required','Diff inspection requires immutable base and head commit identities.',409);
  const maximum=2_000_000;let raw:Buffer;
  try{raw=(await promisify(execFile)('/usr/bin/git',['--git-dir',project.gitDir,'--work-tree',project.workspace!,'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.sshCommand=false','-c','core.pager=cat','-c','diff.external=','-c','core.attributesFile=/dev/null','diff','--stat','--patch','--full-index','--no-ext-diff','--no-textconv',base,head,'--'],{cwd:project.workspace,env:{...brokerEnvironment(),GIT_CONFIG_GLOBAL:'/dev/null'},encoding:'buffer',maxBuffer:maximum,timeout:30_000})).stdout;}catch(error:any){if(error.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER')throw new DomainError('diff_too_large',`Complete diff exceeds the ${maximum}-byte inspection limit. Split the product work into smaller reviewable artifacts; no partial inspection was recorded.`,413);throw error;}
  const content=raw.toString('utf8');if(!Buffer.from(content,'utf8').equals(raw)||content.includes('\0'))throw new DomainError('diff_not_text','Complete diff is not UTF-8 text; no partial inspection was recorded.',415);return content;
 }
 async head(project:Project,options:{signal?:AbortSignal}={}){return this.git(project,['rev-parse','HEAD'],options);}
 async clean(project:Project,options:{signal?:AbortSignal}={}){return (await this.git(project,['status','--porcelain'],options)).length===0;}
 async readProduct(productId:string,file:string){if(file.startsWith('/')||file.includes('..')||file.includes('\0')||file.startsWith('-'))throw new DomainError('path_denied','Use a repository-relative source path.',403);const product=this.store.get('products',productId);if(!product)throw new Error('Unknown product.');if(!this.store.policy.allowedRepositories.includes(product.repository))throw new DomainError('repository_denied','Repository outside Owner envelope.',403);const b=product.binding??await this.inspect(product);return this.readBlob(b.mirror,b.baseCommit,file);}
}
