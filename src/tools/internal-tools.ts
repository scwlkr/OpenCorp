import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Actor, Artifact, Product } from '../core/types.js';
import { DomainError } from '../core/types.js';
import { CompanyStore } from '../storage/store.js';
import { executeSandboxed } from '../runtime/index.js';
import { brokerEnvironment, checked } from './process.js';
import { prepareProductDependencies } from './dependencies.js';
import { safeChild, WorkspaceManager } from './workspaces.js';

interface Adoption { identity:string; artifactId:string; entrypoint:string; employeeIds:string[]; reviewId:string; adoptedBy:string; adoptedAt:string; runId:string|null }
/** Executables remain untrusted: every use gets fresh disposable source and no network/credentials. */
export class InternalToolManager {
 constructor(private store:CompanyStore,private dataRoot:string,private workspaces:WorkspaceManager){}
 private product(id:string){const product=this.store.need('products',id),repository=this.workspaces.internalRepository(product);if(lstatSync(repository).isSymbolicLink()||!lstatSync(repository).isDirectory())throw new DomainError('repository_denied','Internal repository must remain an owned directory.',403);safeChild(this.dataRoot,repository);return product;}
 private authority(actor:Actor,product:Product){
  this.store.validateActor(actor,true);
  if(actor.kind!=='owner'&&(actor.employeeId!==product.managerId&&!this.store.canManage(actor,product.managerId)))throw new DomainError('tool_authority','Only the tool home manager or supervising management can adopt or roll back software.',403);
 }
 private approved(artifact:Artifact){
  const author=this.store.need('runs',artifact.runId),assignment=this.store.need('assignments',artifact.assignmentId);
  if(artifact.kind!=='commit'||artifact.sourcePullRequest||assignment.kind!=='implementation'||author.employeeId!==artifact.employeeId||author.assignmentId!==assignment.id||assignment.projectId!==artifact.projectId)throw new DomainError('tool_authorship','Tool must retain its actual employee implementation source.',403);
  if(!artifact.verification?.passed||artifact.verification.identity!==artifact.identity||!artifact.checks.length||artifact.checks.some(c=>c.status!=='passed'||c.source!=='canonical-verifier'||c.identity!==artifact.identity))throw new DomainError('tool_checks','Exact tool source requires passing canonical verification.',409);
  const reviews=this.store.list('reviews').filter(r=>r.artifactId===artifact.id&&r.artifactIdentity===artifact.identity);
  const review=reviews.at(-1);
  if(!review||review.verdict!=='approved'||review.employeeId===artifact.employeeId||review.runId===artifact.runId)throw new DomainError('tool_review','The latest exact-source review must be an independent approval.',409);
  return review;
 }
 async adopt(actor:Actor,input:{artifactId:string;entrypoint:string;employeeIds:string[]}){
  const artifact=this.store.need('artifacts',input.artifactId),project=this.store.need('projects',artifact.projectId!),product=this.product(project.productId!);this.authority(actor,product);
  const review=this.approved(artifact);
  if(!/^[A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:js|mjs|cjs|sh|py)$/.test(input.entrypoint)||input.entrypoint.split('/').some(p=>p==='..'||p==='.'||!p))throw new DomainError('tool_entrypoint','Use a repository-relative JavaScript, shell or Python entrypoint.');
  if(!Array.isArray(input.employeeIds)||!input.employeeIds.length||input.employeeIds.length>200||input.employeeIds.some(id=>typeof id!=='string'||this.store.need('employees',id).status!=='active'))throw new DomainError('tool_scope','Select active intended employees.');
  if(await this.workspaces.head(project)!==artifact.identity||!await this.workspaces.clean(project))throw new DomainError('artifact_changed','Tool workspace must retain its exact clean reviewed source.',409);
  const path=safeChild(project.workspace!,join(project.workspace!,input.entrypoint));if(!lstatSync(path).isFile()||lstatSync(join(project.workspace!,input.entrypoint)).isSymbolicLink())throw new DomainError('tool_entrypoint','Entrypoint must be a regular source file.');
  const tracked=await this.workspaces.git(project,['ls-tree','-r',artifact.identity]);if(!tracked.split('\n').some(line=>line.endsWith(`\t${input.entrypoint}`)))throw new DomainError('tool_entrypoint','Entrypoint must be tracked in the exact reviewed commit.');if(tracked.split('\n').some(line=>/^(120000|160000) /.test(line)))throw new DomainError('tool_source','Executable snapshots cannot contain symlinks or submodules.',403);
  this.authority(actor,this.product(product.id));const currentArtifact=this.store.need('artifacts',artifact.id),currentReview=this.approved(currentArtifact);if(currentArtifact.identity!==artifact.identity||currentArtifact.projectId!==artifact.projectId||currentReview.id!==review.id)throw new DomainError('artifact_changed','Reviewed tool source changed during adoption; retry the current version.',409);
  const adoption:Adoption={identity:artifact.identity,artifactId:artifact.id,entrypoint:input.entrypoint,employeeIds:[...new Set(input.employeeIds)],reviewId:review.id,adoptedBy:actor.kind==='owner'?'owner':actor.employeeId,adoptedAt:new Date().toISOString(),runId:actor.kind==='employee'?actor.runId:null};
  const current=this.product(product.id);this.store.update('products',product.id,{adoption,binding:{...current.binding,baseCommit:adoption.identity},adoptionHistory:[...(current.adoptionHistory??[]),adoption]});this.store.emit('internal-tool.adopted',{productId:product.id,...adoption});return adoption;
 }
 rollback(actor:Actor,input:{productId:string;identity:string}){
  const product=this.product(input.productId);this.authority(actor,product);
  const adoption=(product.adoptionHistory??[]).findLast((a:Adoption)=>a.identity===input.identity) as Adoption|undefined;
  if(!adoption)throw new DomainError('tool_version','Rollback requires a previously adopted version.',404);
  this.approved(this.store.need('artifacts',adoption.artifactId));this.store.update('products',product.id,{adoption,binding:{...product.binding,baseCommit:adoption.identity}});this.store.emit('internal-tool.rolled-back',{productId:product.id,identity:adoption.identity,actor});return adoption;
 }
 async execute(actor:Actor,input:{productId:string;args?:string[]},options:{signal?:AbortSignal}={}){
  this.store.validateActor(actor,true);if(actor.kind!=='employee')throw new DomainError('employee_required','Tool use must be attributed to an active employee run.',403);
  const product=this.product(input.productId),adoption=product.adoption as Adoption|undefined;
  if(!adoption||!adoption.employeeIds.includes(actor.employeeId))throw new DomainError('tool_scope','This executable has not been adopted for this employee.',403);
  this.approved(this.store.need('artifacts',adoption.artifactId));
  const args=input.args??[];if(!Array.isArray(args)||args.length>40||args.some(a=>typeof a!=='string'||a.length>16000||a.includes('\0')))throw new DomainError('tool_arguments','Use at most forty bounded text arguments.');
  const id=randomUUID(),workspace=join(this.dataRoot,'workspaces',`tool-${id}`),env={...brokerEnvironment(),GIT_CONFIG_GLOBAL:'/dev/null'};
  mkdirSync(workspace,{mode:0o700});
  // A private index checks out only immutable source; metadata never enters the execution workspace.
  const index=join(this.dataRoot,'runtime',`tool-${id}.index`),git=(args:string[])=>checked('git',['--git-dir',product.repository,'--work-tree',workspace,'-c','core.hooksPath=/dev/null',...args],{env:{...env,GIT_INDEX_FILE:index},signal:options.signal});
  await git(['read-tree',adoption.identity]);await git(['checkout-index','--all','--force']);
  if(!existsSync(safeChild(workspace,join(workspace,adoption.entrypoint))))throw new DomainError('tool_entrypoint','Adopted entrypoint missing.');
  this.store.validateActor(actor,true);this.approved(this.store.need('artifacts',adoption.artifactId));if(JSON.stringify(this.product(product.id).adoption)!==JSON.stringify(adoption))throw new DomainError('tool_version','Adopted version changed during preparation; retry the current version.',409);
  const receipt=this.store.put('experiences',{kind:'internal-tool-use',productId:product.id,artifactId:adoption.artifactId,identity:adoption.identity,employeeId:actor.employeeId,runId:actor.runId,workspace,status:'prepared'});
  this.store.update('experiences',receipt.id,{status:'dispatched'});
  try{
   const prepared=await prepareProductDependencies({productName:product.name,workspace,dataRoot:this.dataRoot,signal:options.signal});
   if(!prepared.installed)throw new DomainError('tool_dependencies','Reviewed dependencies could not be prepared.',409);
   this.store.validateActor(actor,true);this.approved(this.store.need('artifacts',adoption.artifactId));if(JSON.stringify(this.product(product.id).adoption)!==JSON.stringify(adoption))throw new DomainError('tool_version','Adopted version changed during dependency preparation.',409);
   const result=await executeSandboxed({workspace,toolEnvironment:prepared.environment,command:[adoption.entrypoint.endsWith('.sh')?'/bin/sh':adoption.entrypoint.endsWith('.py')?'python3':prepared.environment.binPaths.length?'node':process.execPath,adoption.entrypoint,...args],dataRoot:this.dataRoot,runId:`tool-${id}`,signal:options.signal,timeoutMs:60000});
   const final=this.store.update('experiences',receipt.id,{status:result.code===0?'succeeded':'failed',exitCode:result.code,stdout:result.stdout.slice(-16000),stderr:result.stderr.slice(-8000),completedAt:new Date().toISOString()});this.store.emit('internal-tool.used',{receiptId:receipt.id,productId:product.id,identity:adoption.identity,employeeId:actor.employeeId,status:final.status});return final;
  }catch(error){this.store.update('experiences',receipt.id,{status:'uncertain',detail:String(error)});throw error;}
 }
}
