import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CompanyStore } from '../src/storage/store.js';
import { CorporateBroker } from '../src/tools/broker.js';
import { prepareProductDependencies, type DependencyResult } from '../src/tools/dependencies.js';
import { executeSandboxed } from '../src/runtime/index.js';
import type { Actor, Artifact, Project } from '../src/core/types.js';

vi.mock('../src/tools/dependencies.js',async original=>({...await original<typeof import('../src/tools/dependencies.js')>(),prepareProductDependencies:vi.fn()}));
vi.mock('../src/runtime/index.js',async original=>({...await original<typeof import('../src/runtime/index.js')>(),executeSandboxed:vi.fn()}));
const prepare=vi.mocked(prepareProductDependencies),execute=vi.mocked(executeSandboxed),owner={kind:'owner'} as const,model='wlkr-management-qwen3.8-27b-q4-k-m:latest';
let root:string,store:CompanyStore,broker:CorporateBroker,actor:Actor,project:Project,artifact:Artifact,prepared:DependencyResult;
beforeEach(()=>{
 root=mkdtempSync(join(tmpdir(),'opencorp-verifier-'));store=new CompanyStore(root);store.bootstrap();store.put('models',{name:model,artifactIdentity:'fixture-digest',local:true,available:true,capabilities:['tools']});store.command(owner,{type:'control',action:'start'});broker=new CorporateBroker(store,root);
 const ceo=store.list('employees').find(e=>store.level(e.id)==='ceo')!,product=store.list('products').find(p=>p.name==='OpenJob')!;
 project=store.command(owner,{type:'project.create',name:'Actual merge verification',productId:product.id,outcome:'Check complete product outcome',acceptance:['Canonical merge check'],supervisorId:ceo.id,rationale:'Fixture'});
 project=store.update('projects',project.id,{workspace:join(root,'workspaces',project.id),baseCommit:'a'.repeat(40)});mkdirSync(project.workspace!,{recursive:true});
 const assignment=store.command(owner,{type:'assignment.create',employeeId:ceo.id,projectId:project.id,title:'Verify',instructions:'Run actual checks',acceptance:['Canonical merge verification']});
 const run=store.put('runs',{employeeId:ceo.id,assignmentId:assignment.id,modelId:model,workspace:project.workspace,sessionId:'fixture-session',policyRevision:store.policy.revision,status:'running',attempt:1,heartbeatAt:new Date().toISOString(),leaseUntil:new Date(Date.now()+60000).toISOString(),tokenRevoked:false});actor={kind:'employee',employeeId:ceo.id,runId:run.id,policyRevision:store.policy.revision};
 artifact=store.put('artifacts',{assignmentId:assignment.id,projectId:project.id,employeeId:ceo.id,runId:run.id,identity:'b'.repeat(40),kind:'commit',uri:'fixture-commit',summary:'Actual authored fix',checks:[]});
 vi.spyOn(broker.workspaces,'head').mockResolvedValue(artifact.identity);vi.spyOn(broker.workspaces,'clean').mockResolvedValue(true);
 prepared={workspace:project.workspace!,productName:'OpenJob',lockDigest:'lock',environment:{binPaths:['/owned/node/bin'],readPaths:['/owned/cache'],writePaths:['/owned/cache'],variables:{npm_config_offline:'true'}},installed:true,checks:[],receiptPath:join(root,'dependency-receipt.json'),artifacts:2,downloaded:0,reused:2,incrementalCost:0};prepare.mockReset();prepare.mockResolvedValue(prepared);execute.mockReset();execute.mockResolvedValue({code:0,stdout:'Canonical verification passed',stderr:''});
});
afterEach(async()=>{await broker.cancel();store.close();rmSync(root,{recursive:true,force:true});vi.restoreAllMocks();});

describe('verification dependency and dispatch boundary',()=>{
 it('uses the prepared owned environment and the recorded OpenJob merge base',async()=>{
  const result=await broker.call(actor,'verify_product',{artifactId:artifact.id});expect(result.status).toBe('passed');expect(prepare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({productName:'OpenJob',workspace:project.workspace,dataRoot:root,signal:expect.any(AbortSignal)}));
  expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({command:`npm run verify -- merge --base '${project.baseCommit}'`,toolEnvironment:prepared.environment}));expect(store.need('artifacts',artifact.id).checks[0].dependencyReceipt).toBe(prepared.receiptPath);expect(readFileSync(result.logPath,'utf8')).toContain(prepared.receiptPath);
 });
 it('records precise preparation failure without claiming or starting canonical verification',async()=>{
  prepare.mockResolvedValue({...prepared,installed:false,checks:[{command:'npm ci --offline',code:1,stdout:'',stderr:'Required immutable dependency unavailable'}]});
  await expect(broker.call(actor,'verify_product',{artifactId:artifact.id})).rejects.toThrow(prepared.receiptPath);expect(execute).not.toHaveBeenCalled();
  const saved=store.need('artifacts',artifact.id);expect(saved.verification.passed).toBe(false);expect(saved.checks[0].source).toBe('dependency-preparation');expect(readFileSync(saved.verification.logPath,'utf8')).toContain('Required immutable dependency unavailable');
 });
 it('rechecks live authority after dependency preparation before canonical execution',async()=>{
  prepare.mockImplementation(async()=>{store.command(owner,{type:'control',action:'pause'});return prepared;});
  await expect(broker.call(actor,'verify_product',{artifactId:artifact.id})).rejects.toThrow(/inactive|revoked|paused/);expect(execute).not.toHaveBeenCalled();expect(store.need('artifacts',artifact.id).verification.passed).toBe(false);
 });
 it('rechecks the exact source identity after dependency preparation',async()=>{
  vi.mocked(broker.workspaces.head).mockResolvedValueOnce(artifact.identity).mockResolvedValue('changed-during-prepare');
  await expect(broker.call(actor,'verify_product',{artifactId:artifact.id})).rejects.toThrow(/changed during dependency preparation/);expect(execute).not.toHaveBeenCalled();
 });
 it('holds the native slot through dependency preparation and cancellation',async()=>{
  let started!:()=>void;const startedPromise=new Promise<void>(resolve=>{started=resolve;});
  prepare.mockImplementation(options=>new Promise(resolve=>{started();options.signal!.addEventListener('abort',()=>resolve(prepared),{once:true});}));
  const pending=broker.call(actor,'verify_product',{artifactId:artifact.id});const observed=pending.catch(error=>error);await startedPromise;
  await expect(broker.call(actor,'verify_product',{artifactId:artifact.id})).rejects.toThrow(/native build|native.*slot|canonical build slot/);
  await broker.cancel();expect(await observed).toBeInstanceOf(Error);expect(execute).not.toHaveBeenCalled();
 });
});
