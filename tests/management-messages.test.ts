import {afterEach,beforeEach,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CompanyStore} from '../src/storage/store.js';
import {managementOutcome} from '../src/scheduler/scheduler.js';
import {reconcileStandingDuties} from '../src/core/formation.js';

let root:string,store:CompanyStore;
const owner={kind:'owner'} as const;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'opencorp-messages-'));store=new CompanyStore(root);store.bootstrap();const model=store.list('employees')[0].modelId;store.put('models',{id:model,name:model,artifactIdentity:'synthetic-local-digest',local:true,available:true,capabilities:['tools']});});
afterEach(()=>{store.close();rmSync(root,{recursive:true,force:true});});
it('persists a direct message wake across reopen without assigning project access or changing reporting',()=>{
 const recipient=store.list('employees').find(e=>store.level(e.id)==='ceo')!;
 const message=store.command(owner,{type:'message.send',recipientId:recipient.id,content:'Review the useful employee result.'});
 const task=store.assignmentBySchedulerKey(`message:${message.id}`)!;
 expect(task).toMatchObject({employeeId:recipient.id,projectId:null,kind:'management',status:'queued',accepted:true});
 expect(store.need('employees',recipient.id)).toEqual(recipient);
 const policy=store.policy;
 store.close();store=new CompanyStore(root);
 expect(store.assignmentBySchedulerKey(`message:${message.id}`)?.id).toBe(task.id);
 expect(store.policy).toEqual(policy);
 expect(store.list('assignments').filter(a=>a.schedulerKey===`message:${message.id}`)).toHaveLength(1);
});
it('does not wake informational or self messages and rolls back invalid wake input',()=>{
 const recipient=store.list('employees').find(e=>store.level(e.id)==='ceo')!;
 const before=store.list('assignments').length,messages=store.list('messages').length;
 store.command(owner,{type:'message.send',recipientId:recipient.id,content:'No action needed.',wake:false});
 expect(store.list('assignments')).toHaveLength(before);
 expect(()=>store.command(owner,{type:'message.send',recipientId:recipient.id,content:'Bad wake',wake:'false'})).toThrow('wake must be a boolean');
 expect(store.list('messages')).toHaveLength(messages+1);
 store.command(owner,{type:'control',action:'start'});
 const assignment=store.command(owner,{type:'assignment.create',employeeId:recipient.id,title:'Self note',instructions:'Record a note',acceptance:['A note'],kind:'management'});
 const run=store.claimNext({assignmentId:assignment.id,workspace:root})!;
 store.command({kind:'employee',employeeId:recipient.id,runId:run.id,policyRevision:run.policyRevision},{type:'message.send',recipientId:recipient.id,content:'Remember this.'});
 expect(store.list('assignments')).toHaveLength(before+1);
});
it('accepts message dispositions only for the exact recipient and retained message, without claiming implementation completion',()=>{
 const recipient=store.list('employees').find(e=>store.level(e.id)==='ceo')!;
 const message=store.command(owner,{type:'message.send',recipientId:recipient.id,content:'Consider this finding.'});
 const task=store.assignmentBySchedulerKey(`message:${message.id}`)!;
 store.command(owner,{type:'control',action:'start'});
 const run=store.claimNext({assignmentId:task.id,workspace:root})!;
 expect(managementOutcome(store,task,{...run,text:'No further work is justified.'}).passed).toBe(true);
 expect(managementOutcome(store,task,{...run,text:''}).passed).toBe(false);
 expect(managementOutcome(store,{...task,kind:'implementation'},{...run,text:'Done'}).passed).toBe(false);
 expect(managementOutcome(store,task,{...run,employeeId:'another-employee',text:'Done'}).passed).toBe(false);
});
it('wakes due department responsibilities in factory companies without a legacy expansion flag',()=>{
 const manager=store.list('employees').find(e=>store.level(e.id)==='ceo')!;
 store.command(owner,{type:'control',action:'start'});
 const department=store.command(owner,{type:'department.create',name:'Useful support',managerId:manager.id,responsibilities:'Maintain useful work'});
 store.command(owner,{type:'department.update',departmentId:department.id,standingDuties:[{name:'Review feedback',instructions:'Inspect actual user feedback',intervalHours:24}],rationale:'Keep product support owned'});
 reconcileStandingDuties(store);reconcileStandingDuties(store);
 expect(store.list('assignments').filter(a=>a.schedulerKey?.startsWith(`duty:${department.id}:`))).toHaveLength(1);
});
