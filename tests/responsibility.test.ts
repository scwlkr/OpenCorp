import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyStore } from '../src/storage/store.js';
import { reconcileResponsibilities, responsibilityCommand } from '../src/core/responsibility.js';
import { notifyOwnerRequests, type NotificationResult } from '../src/server/owner-notifications.js';
let root:string,store:CompanyStore,ceoId:string;
const owner={kind:'owner'} as const;
const original=()=>store.put('assignments',{employeeId:ceoId,supervisorId:ceoId,title:'Original outcome',instructions:'Real implementation',acceptance:['Preserve acceptance'],dependencies:[],status:'blocked',priority:1,attempts:1,corrections:0,kind:'implementation',availableAt:new Date().toISOString(),projectId:null,blockedReason:'Observed missing prerequisite'});
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'opencorp-responsibility-'));store=new CompanyStore(root);store.bootstrap();store.command(owner,{type:'control',action:'start'});ceoId=store.list('employees').find(e=>store.level(e.id)==='ceo')!.id;});
afterEach(()=>{store.close();rmSync(root,{recursive:true,force:true});});
describe('accountable bounded continuations',()=>{
 it('carries failed diagnosis back to the original obligation without recursive diagnoses or duplicate turns',()=>{
  const work=original();store.put('assignments',{...work,id:'failed-diagnosis',kind:'management',schedulerKey:'fault:failed-run',payload:{failedAssignmentId:work.id},status:'blocked'});
  reconcileResponsibilities(store);reconcileResponsibilities(store);
  const followups=store.list('assignments').filter(a=>a.schedulerKey?.startsWith('responsibility:'));expect(followups).toHaveLength(1);expect(followups[0].payload.sourceAssignmentId).toBe(work.id);expect(store.need('assignments',work.id)).toMatchObject({status:'blocked',acceptance:['Preserve acceptance'],continuation:{ownerId:ceoId,followupAssignmentId:followups[0].id}});
  store.update('assignments',followups[0].id,{status:'blocked'});reconcileResponsibilities(store,Date.now()+5*3600_000);reconcileResponsibilities(store,Date.now()+6*3600_000);
  expect(store.list('assignments').filter(a=>a.schedulerKey?.startsWith('responsibility:'))).toHaveLength(1);expect(store.list('attention').filter(a=>a.responsibilityKey===work.id)).toHaveLength(1);expect(store.need('assignments',work.id).status).toBe('blocked');
 });
 it('retains explicit followup history and rejects invalid or past rechecks',()=>{
  const work=original();expect(()=>responsibilityCommand(store,owner,{type:'responsibility.update',assignmentId:work.id,kind:'scheduled_recheck',action:'Check prerequisite',nextCheckAt:'2000-01-01'})).toThrow(/future/);
  responsibilityCommand(store,owner,{type:'responsibility.update',assignmentId:work.id,kind:'scheduled_recheck',action:'Check named provider prerequisite',nextCheckAt:new Date(Date.now()+3600_000).toISOString()});reconcileResponsibilities(store);
  expect(store.list('assignments')).toHaveLength(1);expect(store.need('assignments',work.id).continuationHistory).toHaveLength(1);
 });
 it('does not expose adverse review responses before all independent votes are retained',()=>{
  const decision=store.put('decisions',{kind:'executive.review',authorId:'system',subject:'Delivery judgment',rationale:'Independent review',payload:{employeeId:ceoId},status:'rejected',policyRevision:store.policy.revision});
  const elders=store.list('employees').filter(e=>store.level(e.id)==='elder');for(const elder of elders.slice(0,2))store.put('votes',{decisionId:decision.id,employeeId:elder.id,approve:false,rationale:'Observed concern',runId:'fixture',phase:'initial'});
  reconcileResponsibilities(store);expect(store.list('assignments')).toHaveLength(0);store.put('votes',{decisionId:decision.id,employeeId:elders[2].id,approve:true,rationale:'Independent dissent',runId:'fixture',phase:'initial'});reconcileResponsibilities(store);reconcileResponsibilities(store);
  expect(store.list('assignments')).toHaveLength(1);expect(store.list('employees').every(e=>e.status==='active')).toBe(true);
  responsibilityCommand(store,owner,{type:'review.respond',decisionId:decision.id,kind:'justified_closure',rationale:'Concrete review concern already resolved by linked observed delivery'});expect(store.need('decisions',decision.id).responses).toHaveLength(1);expect(store.list('votes')).toHaveLength(3);
 });
 it('persists precise Owner requests and deduplicates actual notification submissions with no invented delivery',async()=>{
  const work=original(),input={type:'owner.request',assignmentId:work.id,title:'Provider credential needed',detail:'Provider rejected the absent credential',requiredAction:'Connect the existing provider account',recommendation:'Use the existing account; no new spending'};
  const request=responsibilityCommand(store,owner,input) as {id:string};expect((responsibilityCommand(store,owner,input) as {id:string}).id).toBe(request.id);
  let calls=0;const notifier=async()=>{calls++;return {status:'submitted',detail:'Accepted only; display unconfirmed'} as NotificationResult;};
  await notifyOwnerRequests(store,notifier);await notifyOwnerRequests(store,notifier);expect(calls).toBe(1);expect(store.need('attention',request.id)).toMatchObject({status:'open',notification:{status:'submitted'}});
  await notifyOwnerRequests(store,notifier,Date.now()+5*3600_000);expect(calls).toBe(2);store.close();store=new CompanyStore(root);expect(store.need('attention',request.id).notificationHistory).toHaveLength(2);
 });
 it('never presents legacy passive attention and records adapter failure honestly',async()=>{
  store.put('attention',{kind:'runtime',status:'open',title:'Old runtime note',detail:'Historical',requiredAction:'Read notes'});let calls=0;
  await notifyOwnerRequests(store,async()=>{calls++;return {status:'submitted',detail:'accepted'};});expect(calls).toBe(0);
  const request=responsibilityCommand(store,owner,{type:'owner.request',ownerId:ceoId,title:'Consent',detail:'Observed OS restriction',requiredAction:'Enable local notification consent',recommendation:'Approve only this application'}) as {id:string};
  await notifyOwnerRequests(store,async()=>{throw new Error('OS permission denied');});expect(store.need('attention',request.id).notification).toMatchObject({status:'unavailable',detail:'OS permission denied'});
 });
});

it('ignores a notification result when restore removes its request',async()=>{
 const backup=store.backup();
 const request=responsibilityCommand(store,owner,{type:'owner.request',ownerId:ceoId,title:'Consent',detail:'Observed restriction',requiredAction:'Enable consent',recommendation:'Approve this application'}) as {id:string};
 let complete!:(result:NotificationResult)=>void;const pending=notifyOwnerRequests(store,()=>new Promise(resolve=>{complete=resolve;}));
 store.command(owner,{type:'control',action:'pause'});store.restore(backup.path);expect(store.get('attention',request.id)).toBeUndefined();
 complete({status:'submitted',detail:'OS accepted'});await expect(pending).resolves.toBeUndefined();expect(store.get('attention',request.id)).toBeUndefined();
});
