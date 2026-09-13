import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyStore } from '../src/storage/store.js';
import { workplaceCommand, workplaceSnapshot, reconcileWorkplace, recordSocialResponse, socialContext, socialSystemPrompt, socialDispatchAllowed, type WorkplaceEvent, type WorkplaceChannel } from '../src/core/workplace.js';
import type { CorporateCommand } from '../src/core/types.js';
let root:string,store:CompanyStore,channel:WorkplaceChannel,hostId:string,peerId:string;
const owner={kind:'owner'} as const;
function command(c:CorporateCommand){return workplaceCommand(store,owner,c);}
function create(extra:Record<string,unknown>={}){return command({type:'workplace.event.create',title:'Office gathering',purpose:'Say hello or share a thought',channelId:channel.id,hostId,participantIds:[peerId],scheduledAt:new Date(Date.now()-1000).toISOString(),...extra}) as WorkplaceEvent;}
function turn(eventId:string){reconcileWorkplace(store);const assignment=store.list('assignments').find(a=>a.kind==='social'&&a.payload.eventId===eventId)!;store.update('assignments',assignment.id,{status:'running'});return store.put('runs',{employeeId:assignment.employeeId,assignmentId:assignment.id,modelId:'fixture-local-model',policyRevision:store.policy.revision,status:'running',tokenRevoked:false});}
beforeEach(()=>{
 root=mkdtempSync(join(tmpdir(),'opencorp-workplace-'));store=new CompanyStore(root);store.bootstrap();store.command(owner,{type:'control',action:'start'});store.update('policy',store.policy.id,{maxInference:6});
 store.put('models',{name:'fixture-local-model',local:true,available:true,artifactIdentity:'fixture-sha256',sizeClass:'micro'});
 [hostId,peerId]=store.list('employees').slice(0,2).map(e=>e.id);
 channel=command({type:'workplace.channel.create',name:'Common room'}) as WorkplaceChannel;
});
afterEach(()=>{store.close();rmSync(root,{recursive:true,force:true});});
describe('bounded persistent workplace events',()=>{
 it('rejects missing, department and wrong-kind channel IDs with recovery guidance and no side effects',()=>{
  const department=store.put('departments',{name:'Culture',managerId:hostId}),other=store.put('experiences',{kind:'retained-note',summary:'Not a channel'});
  const before={experiences:store.list('experiences'),assignments:store.list('assignments'),messages:store.list('messages')};
  for(const channelId of ['missing-channel',department.id,other.id]){
   expect(()=>create({channelId})).toThrow(expect.objectContaining({code:'invalid_channel',message:expect.stringMatching(/workplace.channel.create.*returned id/)}));
   expect({experiences:store.list('experiences'),assignments:store.list('assignments'),messages:store.list('messages')}).toEqual(before);
  }
  const chosen=command({type:'workplace.channel.create',name:'Chosen room',departmentId:department.id}) as WorkplaceChannel;
  expect(create({channelId:chosen.id}).channelId).toBe(chosen.id);
 });
 it('creates no synthetic conversation, persists a real attributed turn once, and survives restart',()=>{
  const value=create(),run=turn(value.id);expect(workplaceSnapshot(store).messages).toEqual([]);
  const message=recordSocialResponse(store,run.id,'Hello from an actual fixture employee turn.');
  expect(message).toMatchObject({runId:run.id,senderId:hostId,eventId:value.id,channelId:channel.id});
  expect(recordSocialResponse(store,run.id,'Retry cannot replace original content').id).toBe(message.id);
  expect(store.list('assignments').filter(a=>a.kind==='social')).toHaveLength(2);
  store.close();store=new CompanyStore(root);expect(workplaceSnapshot(store).messages).toEqual([message]);
 });
 it('rejects builder messages, revoked runs, and writing after event cancellation',()=>{
  expect(()=>command({type:'workplace.message.send',channelId:channel.id,content:'Staged greeting'})).toThrow(/actual employee run/);
  const first=create(),run=turn(first.id);store.revokeRun(run.id,'Test revocation');expect(()=>recordSocialResponse(store,run.id,'Cannot post')).toThrow(/revoked/);
  command({type:'workplace.event.update',eventId:first.id,status:'cancelled'});expect(store.need('experiences',first.id).status).toBe('cancelled');
  expect(store.list('assignments').filter(a=>a.payload?.eventId===first.id).every(a=>a.status==='cancelled')).toBe(true);
 });
 it('coalesces missed events once and advances recurrence beyond now',()=>{
  const old=create({scheduledAt:'2020-01-01T10:00:00Z'}),recurring=create({scheduledAt:'2021-01-01T10:00:00Z',recurrence:'annual'}),newest=create({scheduledAt:'2022-01-01T10:00:00Z'});
  reconcileWorkplace(store);expect(store.need('experiences',old.id).status).toBe('cancelled');expect(Date.parse(store.need('experiences',recurring.id).scheduledAt)).toBeGreaterThan(Date.now());expect(store.need('experiences',newest.id).status).toBe('active');
  reconcileWorkplace(store);expect(store.list('assignments')).toHaveLength(2);expect(store.list('messages')).toHaveLength(0);
 });
 it('reserves productive capacity and obeys adjustable social parallelism',()=>{
  command({type:'workplace.configure',maxConcurrentSocial:10});const value=create(),run=turn(value.id),next=store.list('assignments').find(a=>a.employeeId===peerId)!;
  expect(socialDispatchAllowed(store,next.id)).toBe(true);store.update('policy',store.policy.id,{maxInference:2});expect(socialDispatchAllowed(store,next.id)).toBe(false);
  command({type:'workplace.configure',enabled:false});expect(store.need('experiences',value.id).status).toBe('paused');expect(store.need('runs',run.id).tokenRevoked).toBe(true);expect(socialDispatchAllowed(store,next.id)).toBe(false);
 });
 it('permits one bounded social turn on a serial host when scheduler grants idle capacity',()=>{
  const value=create();reconcileWorkplace(store);store.update('policy',store.policy.id,{maxInference:1});
  const assignment=store.list('assignments').find(a=>a.payload?.eventId===value.id)!;
  expect(socialDispatchAllowed(store,assignment.id)).toBe(true);
 });
 it('labels fictional birthdays while preserving factual employee formation dates',()=>{
  const birthday=create({eventType:'fictional_birthday',subjectEmployeeId:hostId});expect(birthday.fictional).toBe(true);expect(birthday.recurrence).toBe('annual');
  store.put('employees',{...store.need('employees',hostId),createdAt:'2024-03-20T12:00:00Z'});
  const employee=store.need('employees',hostId),anniversary=create({eventType:'formation_anniversary',subjectEmployeeId:hostId,scheduledAt:'2027-03-20T10:00:00Z'});
  expect(anniversary.fictional).toBe(false);expect(anniversary.formationDate).toBe(employee.createdAt);expect(new Date(anniversary.scheduledAt).getUTCMonth()).toBe(new Date(employee.createdAt).getUTCMonth());
 });
 it('bounds participant turns, stops expired sessions, and never labels missing chat as actual messages',()=>{
  expect(()=>create({maxTurnsPerParticipant:3})).toThrow(/integer/);
  const value=create({maxTurnsPerParticipant:2});reconcileWorkplace(store);const assignments=store.list('assignments');expect(assignments).toHaveLength(4);expect(assignments.filter(a=>a.payload.turn===2).every(a=>a.dependencies.length===2)).toBe(true);
  reconcileWorkplace(store,Date.now()+61*60_000);expect(store.need('experiences',value.id)).toMatchObject({status:'completed',actualMessageCount:0});expect(store.list('assignments').every(a=>a.status==='cancelled')).toBe(true);
 });
 it('does not queue events while company is paused',()=>{
  const value=create();store.update('company',store.company.id,{state:'paused'});reconcileWorkplace(store);expect(store.list('assignments')).toHaveLength(0);expect(store.need('experiences',value.id).status).toBe('scheduled');
 });
});

it('shares bounded event context across ordinary and qualification social turns without operational role prose',()=>{
 const value=create({eventType:'office_party',title:'Common room gathering',purpose:'Discuss a favorite imaginary place to relax'}),run=turn(value.id);
 store.update('employees',hostId,{role:'OPERATIONAL_ROLE_SENTINEL: prioritize the backlog and produce work reports'});
 const prompt=socialSystemPrompt(store,run.assignmentId);
 expect(prompt).toContain('"eventType":"office_party"');expect(prompt).toContain(value.title);expect(prompt).toContain(value.purpose);
 expect(prompt).toContain(store.need('employees',hostId).name);expect(prompt).toContain(store.need('positions',store.need('employees',hostId).positionId).title);
 expect(prompt).not.toMatch(/birthday|fictional AI character|OPERATIONAL_ROLE_SENTINEL/i);
 expect(prompt).toContain('No tools, artifacts, extra assignments');
 expect(prompt).toContain('No personal work history is supplied.');
 expect(prompt).toContain('Do not claim actual use of a tool or habit, or work you have done, unless supplied evidence establishes it.');
 expect(prompt).toContain('a tentative preference or opting out is fine');
 store.update('assignments',run.assignmentId,{qualification:true});
 const qualification=socialSystemPrompt(store,run.assignmentId);
 expect(qualification).toContain('isolated qualification copy');
 expect(qualification.split('Current event context:')[1]).toBe(prompt.split('Current event context:')[1]);
});
it('names the actual fictional birthday subject without confusing the speaker with the subject',()=>{
 const value=create({eventType:'fictional_birthday',subjectEmployeeId:peerId}),run=turn(value.id);
 const prompt=socialSystemPrompt(store,run.assignmentId);
 expect(prompt).toContain('"eventType":"fictional_birthday"');
 expect(prompt).toContain(JSON.stringify({id:peerId,name:store.need('employees',peerId).name}));
 expect(prompt).toContain('fictional AI character details, not human biography');
 expect(prompt).toContain(`persistent AI employee ${hostId}`);
});

it('rejects invented or same-year employee anniversaries without rewriting records',()=>{
 store.put('employees',{...store.need('employees',hostId),createdAt:'2026-09-10T12:00:00Z'});
 const before=store.list('experiences');
 for(const scheduledAt of ['2026-09-12T10:00:00Z','2026-09-10T10:00:00Z','2027-09-12T10:00:00Z']){
  expect(()=>create({eventType:'formation_anniversary',subjectEmployeeId:hostId,scheduledAt})).toThrow(/welcome or gathering/);expect(store.list('experiences')).toEqual(before);
 }
 const value=create({eventType:'formation_anniversary',subjectEmployeeId:hostId,scheduledAt:'2027-09-10T10:00:00Z'});expect(value.scheduledAt).toBe('2027-09-10T10:00:00.000Z');
 expect(()=>command({type:'workplace.event.update',eventId:value.id,status:'scheduled',scheduledAt:'2026-09-10T10:00:00Z'})).toThrow(/invalid|later year/);expect(store.need('experiences',value.id)).toEqual(value);
 const old=store.put('experiences',{...value,id:'retained-invalid-anniversary',scheduledAt:'2026-09-10T10:00:00Z',status:'paused'});
 expect(()=>command({type:'workplace.event.update',eventId:old.id,status:'scheduled'})).toThrow(/later year/);expect(store.need('experiences',old.id)).toEqual(old);
 command({type:'workplace.event.update',eventId:old.id,status:'cancelled'});expect(store.need('experiences',old.id)).toMatchObject({status:'cancelled',scheduledAt:old.scheduledAt});
 expect(()=>create({eventType:'formation_anniversary',subjectEmployeeId:'not-an-employee',scheduledAt:'2027-09-10T10:00:00Z'})).toThrow();
});
it('observes leap formation anniversaries on February 28 and returns to February 29',()=>{
 store.put('employees',{...store.need('employees',hostId),createdAt:'2024-02-29T12:00:00Z'});
 expect(()=>create({eventType:'formation_anniversary',subjectEmployeeId:hostId,scheduledAt:'2025-03-01T10:00:00Z'})).toThrow(/February 28/);
 const value=create({eventType:'formation_anniversary',subjectEmployeeId:hostId,scheduledAt:'2027-02-28T10:00:00Z'});
 reconcileWorkplace(store,Date.parse('2027-02-28T10:00:00Z'));reconcileWorkplace(store,Date.parse('2027-02-28T11:00:00Z'));
 expect(store.need('experiences',value.id).scheduledAt).toBe('2028-02-29T10:00:00.000Z');
 expect(()=>create({eventType:'formation_anniversary',subjectEmployeeId:hostId,scheduledAt:'2028-02-28T10:00:00Z'})).toThrow(/UTC month/);
});

it('scopes social prompt history to the current event occurrence without deleting channel history',()=>{
 const value=create({eventType:'gathering'}),run=turn(value.id),assignment=store.need('assignments',run.assignmentId);
 const base={senderId:hostId,channelId:channel.id,eventId:value.id,occurrence:assignment.payload.occurrence};
 store.put('messages',{...base,eventId:'previous-anniversary',content:'OLD_EVENT_GREETING'});
 store.put('messages',{...base,occurrence:assignment.payload.occurrence-1,content:'OLD_OCCURRENCE_GREETING'});
 store.put('messages',{...base,channelId:'another-channel',content:'OTHER_CHANNEL_GREETING'});
 for(let index=0;index<14;index++)store.put('messages',{...base,content:`Current idea ${index}`});
 const prompt=socialContext(store,assignment.id);
 expect(prompt).not.toMatch(/OLD_EVENT|OLD_OCCURRENCE|OTHER_CHANNEL/);
 expect(prompt.split('\n')).toHaveLength(12);expect(prompt).not.toContain('Current idea 0\n');
 expect(prompt).toContain(`${store.need('employees',hostId).name}: Current idea 13`);
 expect(store.list('messages')).toHaveLength(17);
 expect(workplaceSnapshot(store).messages.some(m=>m.content==='OLD_EVENT_GREETING')).toBe(true);
});
