import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, renameSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CompanyStore } from '../src/storage/store.js';
import { WorkspaceManager } from '../src/tools/workspaces.js';
import * as dependencies from '../src/tools/dependencies.js';
import { InternalToolManager } from '../src/tools/internal-tools.js';
import { executeSandboxed } from '../src/runtime/index.js';
import type { Actor, Project } from '../src/core/types.js';
vi.mock('../src/runtime/index.js',()=>({executeSandboxed:vi.fn(async()=>({code:0,stdout:'useful result',stderr:''}))}));
let root:string,store:CompanyStore,workspaces:WorkspaceManager,tools:InternalToolManager,project:Project,artifactId:string,actor:Actor;
beforeEach(async()=>{
 root=realpathSync(mkdtempSync(join(tmpdir(),'opencorp-tool-')));store=new CompanyStore(root);store.bootstrap();store.update('company',store.company.id,{state:'running'});workspaces=new WorkspaceManager(store,root);tools=new InternalToolManager(store,root,workspaces);
 const employees=store.list('employees'),author=employees[0]!,consumer=employees[1]!;
 const product=store.put('products',{id:'helper',name:'Helper',kind:'internal-tool',managerId:consumer.id,repository:join(root,'repositories','helper.git')});await workspaces.inspect(product);
 project=await workspaces.ensure(store.put('projects',{name:'Helper',productId:product.id,supervisorId:consumer.id}));
 writeFileSync(join(project.workspace!,'helper.mjs'),"console.log('useful result');\n");await workspaces.git(project,['add','--all']);await workspaces.git(project,['-c','user.name=Fixture','-c','user.email=fixture@localhost','-c','commit.gpgsign=false','commit','-m','Implement helper']);
 const assignment=store.put('assignments',{projectId:project.id,kind:'implementation'}),run=store.put('runs',{employeeId:author.id,assignmentId:assignment.id}),identity=await workspaces.head(project);
 const artifact=store.put('artifacts',{assignmentId:assignment.id,projectId:project.id,employeeId:author.id,runId:run.id,kind:'commit',identity,checks:[{source:'canonical-verifier',status:'passed',identity}],verification:{passed:true,identity}});artifactId=artifact.id;
 store.put('reviews',{artifactId,artifactIdentity:identity,employeeId:consumer.id,runId:'review-run',verdict:'approved'});
 const useRun=store.put('runs',{employeeId:consumer.id,status:'running',tokenRevoked:false,policyRevision:store.policy.revision});actor={kind:'employee',employeeId:consumer.id,runId:useRun.id,policyRevision:store.policy.revision};vi.clearAllMocks();
});
afterEach(()=>{store.close();rmSync(root,{recursive:true,force:true});});
test('adopts independently reviewed source and executes exact version in fresh isolation with an attributed receipt',async()=>{
 const adoption=await tools.adopt({kind:'owner'},{artifactId,entrypoint:'helper.mjs',employeeIds:[(actor as any).employeeId]});
 const receipt=await tools.execute(actor,{productId:'helper',args:['literal; no shell']});
 expect(receipt.status).toBe('succeeded');expect(receipt.identity).toBe(adoption.identity);expect(receipt.employeeId).toBe((actor as any).employeeId);
 const options=vi.mocked(executeSandboxed).mock.calls[0]![0];expect(options.workspace).not.toBe(project.workspace);expect(options.command).toEqual([process.execPath,'helper.mjs','literal; no shell']);expect(options.gatewayPort).toBeUndefined();expect(options.localTestNetwork).toBeUndefined();
 expect(tools.rollback({kind:'owner'},{productId:'helper',identity:adoption.identity})).toEqual(adoption);
});
test('rejects self-review, unverified changes, unscoped execution and unknown rollback versions',async()=>{
 const artifact=store.need('artifacts',artifactId),review=store.list('reviews')[0]!;store.update('reviews',review.id,{employeeId:artifact.employeeId});
 await expect(tools.adopt({kind:'owner'},{artifactId,entrypoint:'helper.mjs',employeeIds:[(actor as any).employeeId]})).rejects.toThrow(/independent approval/);
 store.update('reviews',review.id,{employeeId:(actor as any).employeeId});store.update('artifacts',artifactId,{verification:{passed:false,identity:artifact.identity}});
 await expect(tools.adopt({kind:'owner'},{artifactId,entrypoint:'helper.mjs',employeeIds:[(actor as any).employeeId]})).rejects.toThrow(/passing canonical/);
 await expect(tools.execute(actor,{productId:'helper'})).rejects.toThrow(/not been adopted/);expect(()=>tools.rollback({kind:'owner'},{productId:'helper',identity:'missing'})).toThrow(/previously adopted/);
});
test('refuses source changes after review and traversal entrypoints',async()=>{
 await expect(tools.adopt({kind:'owner'},{artifactId,entrypoint:'../helper.mjs',employeeIds:[(actor as any).employeeId]})).rejects.toThrow(/relative JavaScript/);
 writeFileSync(join(project.workspace!,'helper.mjs'),'changed');await expect(tools.adopt({kind:'owner'},{artifactId,entrypoint:'helper.mjs',employeeIds:[(actor as any).employeeId]})).rejects.toThrow(/exact clean reviewed/);
});

test('execution reads the adopted commit even after author source changes; pause prevents invocation',async()=>{
 await tools.adopt({kind:'owner'},{artifactId,entrypoint:'helper.mjs',employeeIds:[(actor as any).employeeId]});
 writeFileSync(join(project.workspace!,'helper.mjs'),'throw new Error("unreviewed");');
 const receipt=await tools.execute(actor,{productId:'helper'});const {readFileSync}=await import('node:fs');
 expect(readFileSync(join(receipt.workspace,'helper.mjs'),'utf8')).toBe("console.log('useful result');\n");
 store.update('company',store.company.id,{state:'paused'});await expect(tools.execute(actor,{productId:'helper'})).rejects.toThrow(/paused/);expect(executeSandboxed).toHaveBeenCalledTimes(1);
});

test('rejects repository symlink substitution before executing adopted software',async()=>{
 await tools.adopt({kind:'owner'},{artifactId,entrypoint:'helper.mjs',employeeIds:[(actor as any).employeeId]});
 const repository=store.need('products','helper').repository;renameSync(repository,`${repository}.moved`);symlinkSync(`${repository}.moved`,repository);
 await expect(tools.execute(actor,{productId:'helper'})).rejects.toThrow(/owned directory/);expect(executeSandboxed).not.toHaveBeenCalled();
});
test('rechecks adoption authority after asynchronous source inspection',async()=>{
 const original=workspaces.git.bind(workspaces);vi.spyOn(workspaces,'git').mockImplementation(async(project,args,options)=>{const result=await original(project,args,options);if(args[0]==='ls-tree')store.update('products','helper',{managerId:store.list('employees')[0]!.id});return result;});
 await expect(tools.adopt(actor,{artifactId,entrypoint:'helper.mjs',employeeIds:[(actor as any).employeeId]})).rejects.toThrow(/home manager/);expect(store.need('products','helper').adoption).toBeUndefined();
});

test('adopted npm software uses the runtime that prepared its dependencies',async()=>{
 await tools.adopt({kind:'owner'},{artifactId,entrypoint:'helper.mjs',employeeIds:[(actor as any).employeeId]});
 const preparation=vi.spyOn(dependencies,'prepareProductDependencies').mockResolvedValue({workspace:'isolated',productName:'Helper',lockDigest:'synthetic',environment:{binPaths:['/synthetic/prepared-node/bin'],readPaths:[],writePaths:[],variables:{}},installed:true,checks:[],receiptPath:'synthetic',artifacts:0,downloaded:0,reused:0,incrementalCost:0});
 try{await tools.execute(actor,{productId:'helper',args:['literal; argument']});expect(vi.mocked(executeSandboxed).mock.calls[0][0]).toMatchObject({command:['node','helper.mjs','literal; argument'],toolEnvironment:{binPaths:['/synthetic/prepared-node/bin']}});}finally{preparation.mockRestore();}
});
