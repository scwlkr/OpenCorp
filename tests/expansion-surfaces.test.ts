import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CompanyStore } from '../src/storage/store.js';
import { employeeActivity, hierarchyDepth, Hierarchy, RecruitmentView, ResponsibilitiesView, WorkplaceView } from '../src/web/expansion.js';
import { tuiRecords } from '../src/tui/index.js';
import { createProgram } from '../src/cli/index.js';
import { OwnerClient } from '../src/cli/client.js';
let root:string,store:CompanyStore;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'opencorp-expansion-surfaces-'));store=new CompanyStore(root);store.bootstrap();});
afterEach(()=>{vi.restoreAllMocks();store.close();rmSync(root,{recursive:true,force:true});});
describe('foundational expansion interface evidence',()=>{
 it('distinguishes idle, unavailable, queued, and actually active employees without model-name assumptions',()=>{
  const employee=store.list('employees')[0];expect(employeeActivity(store.snapshot(),employee)).toBe('unavailable');
  store.put('models',{name:employee.modelId,available:true,local:true,artifactIdentity:'fixture'});expect(employeeActivity(store.snapshot(),employee)).toBe('idle');
  store.put('assignments',{employeeId:employee.id,status:'queued'});expect(employeeActivity(store.snapshot(),employee)).toBe('queued');
  store.put('runs',{employeeId:employee.id,status:'running',modelId:'micro-override'});store.update('models',store.list('models')[0].id,{available:false});expect(employeeActivity(store.snapshot(),employee)).toBe('active');
 });
 it('renders real hierarchy, role source identity, and pending onboarding rather than a decorative roster',()=>{
  const ceo=store.list('employees').find(e=>store.level(e.id)==='ceo')!;
  store.put('departments',{id:'department',name:'Fixture research',managerId:ceo.id,responsibilities:'Actual responsibility',charter:'Retained charter',standingDuties:[{name:'Monitor constraints',intervalHours:24,instructions:'Inspect actual project constraints'}]});
  store.put('experiences',{id:'req',kind:'requisition',positionId:ceo.positionId,homeManagerId:ceo.id,recruiterId:ceo.id,status:'open',brief:'Useful missing specialization',firstWork:'Review one existing project constraint'});
  store.put('experiences',{id:'source',kind:'skill-source',upstreamPath:'engineering/research.md',repository:'agency-agents',commit:'pinned-sha',license:'MIT'});
  store.put('experiences',{kind:'candidate',name:'Fixture proposal',requisitionId:'req',status:'proposed',role:'Tailored role',sourceIds:['source'],authorship:{authorId:ceo.id,runId:'actual-fixture-run'},adaptation:'Adapted to company authority'});
  const state=store.snapshot(),markup=renderToStaticMarkup(createElement(Fragment,null,createElement(Hierarchy,{state}),createElement(RecruitmentView,{state})));
  expect(markup).toContain('Retained charter');expect(markup).toContain('Monitor constraints');expect(markup).toContain('pinned-sha');expect(markup).toContain('actual-fixture-run');
  expect(tuiRecords(state,7)[0].detail).toContain('Retained charter');expect(tuiRecords(state,8).some(r=>r.detail.includes('pinned-sha'))).toBe(true);
  const mutated={...state,employees:state.employees.map(e=>({...e,homeManagerId:e.id}))};expect(hierarchyDepth(mutated,mutated.employees[0])).toBe(0);
 });
 it('shows only retained social messages, fictional context and zero messages when an event has no run',()=>{
  const employee=store.list('employees')[0];store.put('experiences',{id:'channel',kind:'workplace.channel',name:'Common'});store.put('experiences',{id:'birthday',kind:'workplace.event',title:'AI birthday',purpose:'Fictional persona gathering',status:'scheduled',channelId:'channel',hostId:employee.id,participantIds:[employee.id],fictional:true});
  const mutate=vi.fn(async()=>{}),empty=renderToStaticMarkup(createElement(WorkplaceView,{state:store.snapshot(),mutate,pending:false}));expect(empty).toContain('No employee messages');expect(empty).toContain('0 actual messages');expect(empty).toContain('not human biography');expect(mutate).not.toHaveBeenCalled();
  store.put('messages',{senderId:employee.id,recipientId:null,projectId:null,channelId:'channel',eventId:'birthday',runId:'retained-run',content:'An actual retained greeting',fictionalContext:true});
  const populated=renderToStaticMarkup(createElement(WorkplaceView,{state:store.snapshot(),mutate,pending:false}));expect(populated).toContain('retained-run');expect(populated).toContain('An actual retained greeting');expect(tuiRecords(store.snapshot(),9)[0].detail).toContain('retained-run');
 });
 it('forwards Owner JSON controls through the same command API and rejects malformed command shapes',async()=>{
  const request=vi.spyOn(OwnerClient.prototype,'request').mockResolvedValue({id:'saved-setting'});vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
  await createProgram().parseAsync(['--data-dir',root,'command','{"type":"workplace.configure","enabled":false}'],{from:'user'});
  expect(request).toHaveBeenCalledWith('command',{type:'workplace.configure',enabled:false});
  await expect(createProgram().parseAsync(['command','[]'],{from:'user'})).rejects.toThrow(/JSON object/);expect(request).toHaveBeenCalledTimes(1);
 });
 it('keeps blocked work and accountable next action visible, with generic command parity',()=>{
  const employee=store.list('employees')[0];store.put('assignments',{employeeId:employee.id,supervisorId:employee.id,title:'Unresolved original outcome',kind:'implementation',status:'blocked',blockedReason:'Provider access missing',continuation:{ownerId:employee.id,action:'Connect existing account',nextCheckAt:'2027-01-01T00:00:00Z'},acceptance:['Original acceptance'],dependencies:[]});
  const state=store.snapshot(),markup=renderToStaticMarkup(createElement(ResponsibilitiesView,{state}));expect(markup).toContain('Connect existing account');expect(markup).toContain('Original acceptance');expect(tuiRecords(state,10)[0].detail).toContain('Connect existing account');
  const names=createProgram().commands.map(c=>c.name());for(const name of ['command','departments','workplace','recruitment'])expect(names).toContain(name);
 });
});
