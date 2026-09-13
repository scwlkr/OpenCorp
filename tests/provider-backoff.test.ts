import { reconcileWorkplace } from '../src/core/workplace.js';
import { expect, it } from 'vitest';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextProviderBackoff } from '../src/core/provider-backoff.js';
import { CompanyStore } from '../src/storage/store.js';
const id='vendor/model:free', now=Date.parse('2026-09-12T00:00:00Z');
it('uses labeled bounded estimates for absent/malformed headers without inventing a reset',()=>{
 for(const header of [undefined,'0','Fri, 11 Sep 2026 03:00:00 GMT','tomorrow','-1','1.5','9999999999999999999999999']){
  let state=nextProviderBackoff(id,header,undefined,now);expect(Date.parse(state.retryAt)-now).toBe(300000);expect(state.basis).toBe('estimated-backoff');
  for(let i=0;i<20;i++)state=nextProviderBackoff(id,header,state,now);
  expect(Date.parse(state.retryAt)-now).toBe(3600000);
 }
});
it('honors numeric and HTTP-date retry guidance without shortening existing cooldown',()=>{
 const long=nextProviderBackoff(id,'7200',undefined,now);expect(Date.parse(long.retryAt)).toBe(now+7200000);
 expect(nextProviderBackoff(id,'1',long,now).retryAt).toBe(long.retryAt);
 const dated=nextProviderBackoff(id,'Sat, 12 Sep 2026 03:00:00 GMT',undefined,now);
 expect(Date.parse(dated.retryAt)).toBe(now+10800000);expect(dated.basis).toBe('retry-after');
});
it('persists provider-wide admission across restart without consuming attempts and leaves local claims available',()=>{
 const root=mkdtempSync(join(tmpdir(),'opencorp-cooldown-'));let store=new CompanyStore(root);
 try{
  store.bootstrap();store.command({kind:'owner'},{type:'control',action:'start'});
  const ceo=store.list('employees').find(e=>store.level(e.id)==='ceo')!;
  const task=store.command({kind:'owner'},{type:'assignment.create',employeeId:ceo.id,supervisorId:ceo.id,title:'Fixture',instructions:'Fixture',acceptance:['Fixture'],kind:'management'});
  const local=ceo.modelId;store.put('models',{name:local,local:true,available:true,artifactIdentity:'fixture-local'});store.update('employees',ceo.id,{modelId:id});
  const backoff=nextProviderBackoff(id,undefined,undefined);store.recordProviderBackoff(backoff);
  expect(()=>store.recordProviderBackoff({...backoff,provider:'other'} as any)).toThrow();
  expect(store.claimNext({assignmentId:task.id})).toBeUndefined();expect(store.need('assignments',task.id).attempts).toBe(0);
  store.db.close();store=new CompanyStore(root);expect(store.providerBackoff()).toEqual(backoff);
  expect(store.modelDispatchAllowed('vendor/another:free')).toBe(false);expect(store.modelDispatchAllowed(local)).toBe(true);
  expect(store.claimNext({assignmentId:task.id})).toBeUndefined();
  store.update('employees',ceo.id,{modelId:local});expect(store.claimNext({assignmentId:task.id})).toBeDefined();
  store.update('company',store.company.id,{openRouterBackoff:{...backoff,retryAt:new Date(Date.now()-1).toISOString()}});
  expect(store.modelDispatchAllowed(id)).toBe(true);
 }finally{store.db.close();rmSync(root,{recursive:true,force:true});}
});

it('allows local micro social claims for an employee whose productive model is cooling down',()=>{
 const root=mkdtempSync(join(tmpdir(),'opencorp-social-cooldown-')),store=new CompanyStore(root);
 try{
  store.bootstrap();store.command({kind:'owner'},{type:'control',action:'start'});store.update('policy',store.policy.id,{maxInference:6});
  store.put('models',{name:'fixture-micro',local:true,available:true,artifactIdentity:'fixture-local',sizeClass:'micro'});
  const host=store.list('employees')[0]!;store.update('employees',host.id,{modelId:id});
  const channel=store.command({kind:'owner'},{type:'workplace.channel.create',name:'Fixture room'});
  const event=store.command({kind:'owner'},{type:'workplace.event.create',title:'Fixture event',purpose:'Fixture topic',channelId:channel.id,hostId:host.id,participantIds:[],scheduledAt:new Date(Date.now()-1000).toISOString()});
  reconcileWorkplace(store);const task=store.list('assignments').find(a=>a.kind==='social'&&a.payload.eventId===event.id)!;
  store.recordProviderBackoff(nextProviderBackoff(id,undefined,undefined));
  expect(store.claimNext({assignmentId:task.id})?.modelId).toBe('fixture-micro');
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

it('retains only bounded numeric rate-limit headers without interpreting reset or changing backoff',()=>{
 const baseline=nextProviderBackoff(id,'600',undefined,now);
 const observed=nextProviderBackoff(id,'600',undefined,now,{'x-ratelimit-limit':'20','x-ratelimit-remaining':'0','x-ratelimit-reset':'1789230000000','authorization':'PRIVATE','other':'123'});
 expect(observed).toEqual({...baseline,rateLimitHeaders:{'x-ratelimit-limit':20,'x-ratelimit-remaining':0,'x-ratelimit-reset':1789230000000}});
 expect(JSON.stringify(observed)).not.toContain('PRIVATE');
 for(const value of [undefined,null,[],['20'],'','-1','1.5','NaN','Infinity','1e3','0x10',' 20','20\r\nPRIVATE','9007199254740992','12345678901234567']){
  expect(nextProviderBackoff(id,'600',undefined,now,{'x-ratelimit-limit':value,'x-ratelimit-remaining':value,'x-ratelimit-reset':value})).toEqual(baseline);
 }
 expect(nextProviderBackoff(id,undefined,observed,now)).not.toHaveProperty('rateLimitHeaders');
 expect(nextProviderBackoff(id,undefined,undefined,now,{'x-ratelimit-reset':'1'}).retryAt).toBe(nextProviderBackoff(id,undefined,undefined,now).retryAt);
});
