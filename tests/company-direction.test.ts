import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyStore } from '../src/storage/store.js';
import { reconcileFormation } from '../src/core/formation.js';

let store:CompanyStore,root:string;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'opencorp-direction-'));store=new CompanyStore(root);store.bootstrap();});
afterEach(()=>{store.close();rmSync(root,{recursive:true,force:true});});
const owner={kind:'owner'} as const;

it('migrates once without changing access, identity, useful work or uncertain effects, and survives reopening',()=>{
 const employee=store.list('employees').find(e=>store.level(e.id)==='ceo')!;
 store.update('company',store.company.id,{direction:undefined,mandate:'Historical portfolio and local-only mandate',state:'paused',expansion:{contract:'legacy'}});
 store.update('policy',store.policy.id,{directFreeModels:['groq/example'],allowedRepositories:['/synthetic/registered']});
 const work=store.command(owner,{type:'assignment.create',employeeId:employee.id,title:'Keep useful work',instructions:'Preserve the existing result',acceptance:['Useful result'],kind:'management'});
 const old=store.put('assignments',{...work,id:'obsolete-formation',schedulerKey:'formation:department:Legacy',title:'Mandatory staffing'});
 store.put('actions',{id:'uncertain-effect',status:'uncertain',costApproval:{amount:0,actionId:'uncertain-effect'},dedupeKey:'existing-effect'});
 writeFileSync(join(root,'workspaces','retained.txt'),'unfinished useful work');
 const preserved=()=>({policy:store.policy,employees:store.list('employees'),appointments:store.list('appointments'),roles:store.list('roleVersions'),actions:store.list('actions'),work:store.need('assignments',work.id)});
 const before=preserved();
 store.command(owner,{type:'company.migrate'});
 expect(preserved()).toEqual(before);
 expect(store.need('assignments',old.id)).toMatchObject({status:'blocked',instructions:old.instructions,acceptance:old.acceptance,directionReview:{previousStatus:'queued'}});
 const migration=store.company.directionMigration,count=store.list('assignments').length;
 expect(migration.previousMandate).toBe('Historical portfolio and local-only mandate');
 store.command(owner,{type:'company.migrate'});
 expect(store.list('assignments')).toHaveLength(count);
 store.close();store=new CompanyStore(root);store.bootstrap();
 expect(store.company.directionMigration).toEqual(migration);expect(preserved()).toEqual(before);
 expect(readFileSync(join(root,'workspaces','retained.txt'),'utf8')).toBe('unfinished useful work');
 expect(store.vault.read(store.list('knowledge').find(k=>k.path==='company/mandate.md')!.id).content).toContain(store.company.mandate);
 store.command(owner,{type:'control',action:'start'});reconcileFormation(store);
 expect(store.list('assignments')).toHaveLength(count);
 expect(()=>store.command(owner,{type:'company.expand',mandate:'Restore quotas'})).toThrow(/already migrated/);
});

it('requires Owner authority and drained execution before migration',()=>{
 store.update('company',store.company.id,{direction:undefined});
 const employee=store.list('employees')[0];
 store.command(owner,{type:'control',action:'start'});
 expect(()=>store.command(owner,{type:'company.migrate'})).toThrow(/Pause or stop/);
 const work=store.command(owner,{type:'assignment.create',employeeId:employee.id,title:'Live work',instructions:'Inspect state',kind:'management',acceptance:['Inspect actual state']});
 store.update('assignments',work.id,{status:'running'});
 const run=store.put('runs',{employeeId:employee.id,assignmentId:work.id,status:'running',policyRevision:store.policy.revision,leaseUntil:new Date(Date.now()+60000).toISOString(),tokenRevoked:false});
 expect(()=>store.command({kind:'employee',employeeId:employee.id,runId:run.id,policyRevision:store.policy.revision},{type:'company.migrate'})).toThrow(/Only the Owner/);
 store.update('company',store.company.id,{state:'paused'});
 expect(()=>store.command(owner,{type:'company.migrate'})).toThrow(/drain/);
 expect(store.company.directionMigration).toBeUndefined();
});

it('new companies do not generate legacy required staffing even with a retained expansion marker',()=>{
 expect(store.company.direction).toBe('software-factory');
 store.update('company',store.company.id,{state:'running',expansion:{contract:'legacy'}});
 reconcileFormation(store);
 expect(store.list('assignments')).toEqual([]);
});

it('registers additional products only inside existing Owner repository authority',()=>{
 const ceo=store.list('employees').find(e=>store.level(e.id)==='ceo')!;
 const policy=store.policy;
 expect(()=>store.command(owner,{type:'product.register',name:'Outside',repository:'/synthetic/unapproved',managerId:ceo.id,rationale:'New need'})).toThrow(/Owner access envelope/);
 const repository=policy.allowedRepositories[0];const previous=store.list('products').find(p=>p.repository===repository)!;store.update('products',previous.id,{repository:'/synthetic/retained-other'});
 const result=store.command(owner,{type:'product.register',name:'Configured product',repository,managerId:ceo.id,rationale:'Existing permitted need'});
 expect(result.repository).toBe(repository);expect(store.policy).toEqual(policy);
 const worker=store.list('employees').find(e=>store.level(e.id)==='worker');
 if(worker){const run=store.put('runs',{employeeId:worker.id,status:'running',tokenRevoked:false,policyRevision:policy.revision});expect(()=>store.command({kind:'employee',employeeId:worker.id,runId:run.id,policyRevision:policy.revision},{type:'product.register',name:'Unauthorized',repository,rationale:'No authority'})).toThrow();}
});
