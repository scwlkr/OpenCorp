import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyStore } from '../src/storage/store.js';
import { CorporateBroker, brokerTools, corporateGuide } from '../src/tools/broker.js';
import { prepareProductDependencies } from '../src/tools/dependencies.js';
import { executeSandboxed } from '../src/runtime/index.js';
import type { Actor, Artifact, Employee, Project } from '../src/core/types.js';

vi.mock('../src/tools/dependencies.js',async original=>({...await original<typeof import('../src/tools/dependencies.js')>(),prepareProductDependencies:vi.fn()}));
vi.mock('../src/runtime/index.js',async original=>({...await original<typeof import('../src/runtime/index.js')>(),executeSandboxed:vi.fn()}));
const owner={kind:'owner'} as const,model='wlkr-management-qwen3.8-27b-q4-k-m:latest';
let root:string,store:CompanyStore,broker:CorporateBroker,project:Project,worker:Employee,actor:Extract<Actor,{kind:'employee'}>,artifact:Artifact,logPath:string;
function hire(name:string,managerId:string){const position=store.command(owner,{type:'position.create',title:name,level:'worker',responsibilities:'Inspect scoped fixture evidence'});return store.command(owner,{type:'employee.hire',name,positionId:position.id,homeManagerId:managerId,modelId:model});}
function actorFor(employee:Employee,target=project,kind='implementation'){
 const assignment=store.command(owner,{type:'assignment.create',employeeId:employee.id,projectId:target.id,title:'Fixture evidence',instructions:'Inspect retained verification',acceptance:['Actual diagnosis'],kind,payload:kind==='review'?{artifactId:artifact.id}:{}});
 const run=store.put('runs',{employeeId:employee.id,assignmentId:assignment.id,modelId:model,workspace:target.workspace,sessionId:randomUUID(),policyRevision:store.policy.revision,status:'running',attempt:1,tokenRevoked:false,createdAt:new Date(Date.now()-10000).toISOString()});
 return {kind:'employee',employeeId:employee.id,runId:run.id,policyRevision:store.policy.revision} as const;
}
function retain(content='Canonical failure: fixture test failed.\n',source='canonical-verifier',hashed=true){
 writeFileSync(logPath,content);const time=Date.now()-1000;utimesSync(logPath,(time+.8)/1000,(time+.8)/1000);
 const binding=hashed?{logSha256:createHash('sha256').update(content).digest('hex'),logBytes:Buffer.byteLength(content)}:{},check={source,identity:artifact.identity,command:'fixture canonical command',status:'failed',exitCode:source==='canonical-verifier'?2:null,logPath,finishedAt:new Date(time).toISOString(),...binding};
 artifact=store.update('artifacts',artifact.id,{checks:[check],verification:{runId:actor.runId,identity:artifact.identity,receiptId:randomUUID(),passed:false,command:check.command,exitCode:check.exitCode,completedAt:check.finishedAt,logPath,...binding}});return content;
}
const read=(who:Actor=actor,args:Record<string,unknown>={})=>broker.call(who,'company_detail',{collection:'artifacts',id:artifact.id,view:'verification',...args});
beforeEach(()=>{
 vi.mocked(prepareProductDependencies).mockReset();vi.mocked(executeSandboxed).mockReset();
 root=mkdtempSync(join(tmpdir(),'opencorp-verification-output-'));store=new CompanyStore(root);store.bootstrap();store.put('models',{name:model,artifactIdentity:'fixture-local',local:true,available:true,capabilities:['tools']});store.command(owner,{type:'control',action:'start'});broker=new CorporateBroker(store,root);
 const ceo=store.list('employees').find(e=>store.level(e.id)==='ceo')!;worker=hire('Fixture author',ceo.id);
 project=store.command(owner,{type:'project.create',name:'Fixture project',productId:store.list('products').find(p=>p.name==='paletteWOW')!.id,supervisorId:ceo.id,outcome:'Retained evidence',acceptance:['Verified result'],rationale:'Read boundary fixture'});
 const workspace=join(root,'workspaces',project.id);mkdirSync(workspace,{recursive:true});project=store.update('projects',project.id,{workspace});actor=actorFor(worker);
 artifact=store.put('artifacts',{kind:'commit',identity:'a'.repeat(40),assignmentId:store.need('runs',actor.runId).assignmentId,projectId:project.id,employeeId:worker.id,runId:actor.runId,uri:'fixture-source',summary:'Fixture artifact',checks:[]});
 mkdirSync(join(root,'logs','verification'),{recursive:true});logPath=join(root,'logs','verification',`${artifact.id}.log`);retain();
 vi.spyOn(broker.workspaces,'head').mockResolvedValue(artifact.identity);vi.spyOn(broker.workspaces,'clean').mockResolvedValue(true);
 vi.mocked(prepareProductDependencies).mockResolvedValue({installed:true,receiptPath:join(root,'fixture-dependencies.json'),checks:[],incrementalCost:0,environment:{binPaths:[],readPaths:[],writePaths:[],variables:{}}} as any);
 vi.mocked(executeSandboxed).mockResolvedValue({code:2,stdout:'New canonical output',stderr:'Actual fixture failure'});
});
afterEach(async()=>{await broker.cancel();store.close();rmSync(root,{recursive:true,force:true});vi.restoreAllMocks();});

describe('scoped retained verification output',()=>{
 it('advertises explicit artifact output and receipt-bound continuation',()=>{const schema=brokerTools.find(t=>t.name==='company_detail')!.inputSchema;expect(schema.properties.view.enum).toContain('verification');expect(schema.properties.receiptId.type).toBe('string');expect(schema.properties).not.toHaveProperty('path');expect(corporateGuide).toContain('Protected logPath is provenance');});
 it.each(['current','recovery','reviewer'])('allows %s artifact readers without granting independent inspection credit',async role=>{
  const who=role==='current'?actor:actorFor(role==='recovery'?worker:hire('Fixture reviewer',project.supervisorId),project,role==='reviewer'?'review':'implementation');const before=structuredClone(artifact);
  const result=await read(who);expect(result).toMatchObject({content:'Canonical failure: fixture test failed.\n',receiptId:artifact.verification.receiptId,status:'failed',binding:{kind:'sha256-and-bytes'}});expect(store.need('artifacts',artifact.id)).toEqual(before);expect(store.need('runs',who.runId).artifactInspections).toBeUndefined();
 });
 it.each(['canonical-verifier','dependency-preparation','verification-boundary'])('labels a retained legacy %s failure without rewriting its weaker receipt',async source=>{retain('Actual retained failure\n',source,false);const before=structuredClone(artifact),result=await read();expect(result.binding.kind).toBe('legacy-file-time');expect(result.binding.limitation).toContain('no stored content hash');expect(store.need('artifacts',artifact.id)).toEqual(before);});
 it('pages complete large output and redacts secrets before splitting across page boundaries',async()=>{
  const secret='ghp_'+('x'.repeat(50)),raw='x'.repeat(7984)+'\n'+secret+'\nauthorization: Bearer secret-value\n'+'z'.repeat(130000),expected=raw.replace(secret,'[REDACTED]').replace('secret-value','[REDACTED]');retain(raw);
  let page=await read(),content=page.content;expect(page.content.length).toBe(8000);expect(page.nextCall.receiptId).toBe(artifact.verification.receiptId);
  while(page.nextCall){page=await broker.call(actor,'company_detail',page.nextCall);expect(page.content.length).toBeLessThanOrEqual(8000);content+=page.content;}
  expect(createHash('sha256').update(content).digest('hex')).toBe(createHash('sha256').update(expected).digest('hex'));expect(content).not.toContain(secret);expect(page.totalCharacters).toBe(expected.length);expect(page.nextOffset).toBeNull();
 });
 it('rejects missing or superseded continuation receipts',async()=>{retain('x'.repeat(9000));const first=await read();await expect(read(actor,{offset:8000})).rejects.toThrow(/receipt changed or is missing/);retain('y'.repeat(9000));await expect(broker.call(actor,'company_detail',first.nextCall)).rejects.toThrow(/receipt changed/);});
 it('rejects unrelated employee/project scope and unknown artifact IDs',async()=>{
  const ceo=store.list('employees').find(e=>store.level(e.id)==='ceo')!,outsider=hire('Other fixture author',ceo.id),other=store.command(owner,{type:'project.create',name:'Other fixture',productId:store.list('products')[0].id,supervisorId:ceo.id,outcome:'Other work',acceptance:['Other evidence'],rationale:'Isolation fixture'}),who=actorFor(outsider,other);
  await expect(read(who)).rejects.toMatchObject({code:'evidence_forbidden'});await expect(read(actor,{id:'../../private-host-file'})).rejects.toMatchObject({code:'evidence_forbidden'});
 });
 it.each([{path:'/etc/hosts'},{logPath:'/etc/hosts'},{filename:'unknown.log'}])('rejects caller-supplied paths %j',async args=>{await expect(read(actor,args)).rejects.toMatchObject({code:'verification_arguments'});});
 it('rejects a retained FIFO without blocking the company event loop',()=>{
  rmSync(logPath);execFileSync('mkfifo',[logPath],{timeout:2000});
  const source=`import {CompanyStore} from ${JSON.stringify(new URL('../src/storage/store.ts',import.meta.url).href)}; import {CorporateBroker} from ${JSON.stringify(new URL('../src/tools/broker.ts',import.meta.url).href)}; const store=new CompanyStore(process.argv[1]),broker=new CorporateBroker(store,process.argv[1]); try { await broker.call(JSON.parse(process.argv[2]),'company_detail',JSON.parse(process.argv[3])); throw new Error('FIFO was accepted'); } catch(error) { if(error.code!=='verification_evidence_unavailable')throw error; process.stdout.write('rejected special file'); } finally {store.close();}`;
  expect(execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',source,root,JSON.stringify(actor),JSON.stringify({collection:'artifacts',id:artifact.id,view:'verification'})],{timeout:4000,encoding:'utf8'})).toBe('rejected special file');
 });
 it.each(['missing checks','wrong identity','wrong receipt path','wrong check path','wrong command','wrong timestamp','wrong run project','hash changed','size changed','missing file','file symlink','directory symlink','oversize','stale legacy file'] as const)('rejects %s',async fault=>{
  const value=structuredClone(artifact);
  if(fault==='missing checks')value.checks=[];if(fault==='wrong identity')value.verification.identity='b'.repeat(40);if(fault==='wrong receipt path')value.verification.logPath='/etc/hosts';if(fault==='wrong check path')value.checks[0].logPath='/etc/hosts';if(fault==='wrong command')value.checks[0].command='unrelated';if(fault==='wrong timestamp')value.checks[0].finishedAt=new Date(0).toISOString();if(fault==='wrong run project')store.update('assignments',store.need('runs',actor.runId).assignmentId,{projectId:null});
  if(fault==='hash changed')writeFileSync(logPath,'Changed retained contents');if(fault==='size changed')value.verification.logBytes++;if(fault==='missing file')rmSync(logPath);
  if(fault==='file symlink'){rmSync(logPath);symlinkSync('/etc/hosts',logPath);}if(fault==='directory symlink'){const target=join(root,'other-logs');mkdirSync(target);rmSync(join(root,'logs','verification'),{recursive:true});symlinkSync(target,join(root,'logs','verification'));}
  if(fault==='oversize')writeFileSync(logPath,'x'.repeat(2_000_001));
  if(fault==='stale legacy file'){retain('Legacy output','canonical-verifier',false);utimesSync(logPath,new Date(),new Date());}else store.update('artifacts',artifact.id,value);
  await expect(read()).rejects.toMatchObject({code:'verification_evidence_unavailable'});
 });
 it('preserves default diff/metadata behavior and lifecycle authority',async()=>{vi.spyOn(broker.workspaces,'readDiff').mockResolvedValue('Retained exact diff');expect((await broker.call(actor,'company_detail',{collection:'artifacts',id:artifact.id})).content).toBe('Retained exact diff');const record=await broker.call(actor,'company_detail',{collection:'artifacts',id:artifact.id,view:'record'});expect(JSON.parse(record.content).verification.receiptId).toBe(artifact.verification.receiptId);store.command(owner,{type:'control',action:'pause'});await expect(read()).rejects.toMatchObject({code:'revoked_authority'});});
 it.each(['canonical','dependency','boundary'])('binds newly written %s failures to actual hash/bytes and exposes only the completed output',async stage=>{
  if(stage==='dependency')vi.mocked(prepareProductDependencies).mockResolvedValue({installed:false,receiptPath:join(root,'fixture-dependencies.json'),checks:[],incrementalCost:0} as any);
  if(stage==='boundary')vi.mocked(executeSandboxed).mockRejectedValueOnce(new Error('Fixture native boundary failure'));
  const verified=broker.verify(actor,artifact.id);if(stage==='canonical')await verified;else await expect(verified).rejects.toThrow();
  const bytes=readFileSync(logPath),current=store.need('artifacts',artifact.id);expect(current.verification).toMatchObject({logSha256:createHash('sha256').update(bytes).digest('hex'),logBytes:bytes.length});expect((await read()).content).toBe(bytes.toString());expect((await read()).binding.kind).toBe('sha256-and-bytes');
 });
 it('holds reads during active replacement and makes the new completed receipt readable afterward',async()=>{
  let resolve!:()=>void;const pending=new Promise<void>(done=>{resolve=done;}),prepared={installed:true,receiptPath:join(root,'fixture-dependencies.json'),checks:[],incrementalCost:0,environment:{binPaths:[],readPaths:[],writePaths:[],variables:{}}};
  vi.mocked(prepareProductDependencies).mockImplementationOnce(async()=>{await pending;return prepared as any;});const verification=broker.verify(actor,artifact.id);
  await vi.waitFor(()=>expect(prepareProductDependencies).toHaveBeenCalled());await expect(read()).rejects.toThrow(/verification is active/);resolve();await verification;expect((await read()).content).toContain('New canonical output');
 });
});
