import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyStore } from '../src/storage/store.js';
import { TelegramTransport, reconcileTelegram, type TelegramApi } from '../src/server/telegram.js';
let root:string,store:CompanyStore;
const config={token:'123456:SYNTHETIC_TEST_TOKEN',ownerUserId:123,chatId:123};
const incoming=(id=1,user=123,chat=123,type='private')=>({update_id:id,message:{message_id:id,from:{id:user},chat:{id:chat,type},text:'What has the company delivered?'}});
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'opencorp-telegram-'));store=new CompanyStore(root);store.bootstrap();store.update('company',store.company.id,{state:'running'});});
afterEach(()=>{if(store.db.open)store.close();rmSync(root,{recursive:true,force:true});});
function outgoing(){
 const employee=store.list('employees').find(e=>store.level(e.id)==='ceo')!;
 const run=store.put('runs',{employeeId:employee.id,assignmentId:'synthetic-assignment',status:'succeeded',policyRevision:store.policy.revision});
 return store.put('messages',{senderId:employee.id,recipientId:'owner',projectId:null,content:'Actual result ready.',runId:run.id});
}
it('authenticates numeric sender AND private chat, durably deduplicates replay, and preserves policy',async()=>{
 const policy=store.policy;
 const api=vi.fn<TelegramApi>().mockResolvedValue({ok:true,result:[incoming(1,999),incoming(2,123,999),incoming(3,123,123,'group'),incoming(4)]});
 await new TelegramTransport(store,config,api).tick();
 expect(store.list('messages')).toHaveLength(1);expect(store.list('assignments')).toHaveLength(1);
 expect(store.list('assignments')[0]).toMatchObject({kind:'conversation',dataClass:'confidential',payload:{messageId:store.list('messages')[0]!.id}});
 store.close();store=new CompanyStore(root);
 await new TelegramTransport(store,config,api).tick();
 expect(api.mock.calls[1]![1].offset).toBe(5);expect(store.list('assignments')).toHaveLength(1);expect(store.policy).toEqual(policy);
});
it('retains incoming text without a CEO and queues it when that same identity becomes available',async()=>{
 const ceo=store.list('employees').find(e=>store.level(e.id)==='ceo')!;store.update('employees',ceo.id,{status:'dismissed'});
 const api=vi.fn<TelegramApi>().mockResolvedValue({ok:true,result:[incoming()]});
 const transport=new TelegramTransport(store,config,api);await transport.tick();expect(store.list('messages')).toHaveLength(1);expect(store.list('assignments')).toHaveLength(0);
 store.update('employees',ceo.id,{status:'active'});await transport.tick();expect(store.list('assignments')[0]?.employeeId).toBe(ceo.id);
});
it('persists send intent before dispatch and holds uncertain outcomes across restart; only one absence retry',async()=>{
 const api=vi.fn<TelegramApi>().mockImplementation(async(method)=>{
  if(method==='getUpdates')return {ok:true,result:[]};
  expect(store.list('actions')[0]?.status).toBe('dispatched');throw new Error('synthetic connection lost');
 });
 let transport=new TelegramTransport(store,config,api);outgoing();await transport.tick();
 const action=store.list('actions')[0]!;expect(action.status).toBe('uncertain');
 store.close();store=new CompanyStore(root);transport=new TelegramTransport(store,config,api);await transport.tick();
 expect(api.mock.calls.filter(c=>c[0]==='sendMessage')).toHaveLength(1);
 reconcileTelegram(store,action.id,'absent','Owner inspected the private chat; no message present.');await transport.tick();
 expect(api.mock.calls.filter(c=>c[0]==='sendMessage')).toHaveLength(2);
 expect(()=>reconcileTelegram(store,action.id,'absent','Absent again')).toThrow('One confirmed-absence retry');
 reconcileTelegram(store,action.id,'delivered','Owner found the delivered message.');await transport.tick();expect(api.mock.calls.filter(c=>c[0]==='sendMessage')).toHaveLength(2);
});
it('reconciles a crash after dispatch without resending and waits while company execution is stopped',async()=>{
 const api=vi.fn<TelegramApi>().mockImplementation(async(method)=>({ok:true,result:method==='getUpdates'?[]:{message_id:12}}));
 const transport=new TelegramTransport(store,config,api);outgoing();store.update('company',store.company.id,{state:'stopped'});await transport.tick();
 const action=store.list('actions')[0]!;expect(action.status).toBe('prepared');expect(api.mock.calls.filter(c=>c[0]==='sendMessage')).toHaveLength(0);
 store.update('actions',action.id,{status:'dispatched'});store.close();store=new CompanyStore(root);store.update('company',store.company.id,{state:'running'});
 await new TelegramTransport(store,config,api).tick();expect(store.need('actions',action.id).status).toBe('uncertain');expect(api.mock.calls.filter(c=>c[0]==='sendMessage')).toHaveLength(0);
});
it('retains newer Telegram intake and send receipts across a backup restore',async()=>{
 const api=vi.fn<TelegramApi>().mockImplementation(async(method)=>({ok:true,result:method==='getUpdates'?[incoming()]:{message_id:12}}));
 const transport=new TelegramTransport(store,config,api);const backup=store.backup();outgoing();await transport.tick();
 const action=store.list('actions')[0]!;expect(action.status).toBe('succeeded');
 store.update('company',store.company.id,{state:'paused'});store.restore(backup.path);store.update('company',store.company.id,{state:'running'});
 await transport.tick();expect(store.list('messages').filter(m=>m.telegram)).toHaveLength(1);expect(store.list('assignments')).toHaveLength(1);expect(store.need('actions',action.id).status).toBe('succeeded');expect(api.mock.calls.filter(c=>c[0]==='sendMessage')).toHaveLength(1);
});
it('preserves a completed but not yet dispatched reply through restore',async()=>{
 const api=vi.fn<TelegramApi>().mockImplementation(async(method)=>({ok:true,result:method==='getUpdates'?[incoming()]:{message_id:12}}));
 const transport=new TelegramTransport(store,config,api);const backup=store.backup();await transport.tick();
 const assignment=store.list('assignments')[0]!;
 const message=outgoing();store.update('runs',message.runId!,{assignmentId:assignment.id});store.update('assignments',assignment.id,{status:'completed'});
 store.update('company',store.company.id,{state:'paused'});store.restore(backup.path);store.update('company',store.company.id,{state:'running'});
 await transport.tick();expect(store.get('messages',message.id)?.content).toBe('Actual result ready.');expect(store.list('actions')[0]?.status).toBe('succeeded');
});

it('binds an explicit Owner approval to the delivered proposal and never replays its disposition',async()=>{
 const api=vi.fn<TelegramApi>().mockImplementation(async method=>({ok:true,result:method==='getUpdates'?[]:{message_id:42}}));
 const transport=new TelegramTransport(store,config,api),message=outgoing();store.update('messages',message.id,{recipientId:message.senderId});
 store.update('runs',message.runId!,{status:'running',tokenRevoked:false});
 const actor={kind:'employee' as const,employeeId:message.senderId,runId:message.runId!,policyRevision:store.policy.revision};
 const proposal=store.command(actor,{type:'owner.propose',title:'Local validation only',content:'Record a non-executing approval.',proposalScope:'No spending, access changes or external actions.',expiresAt:new Date(Date.now()+3600000).toISOString(),channel:'telegram'});
 store.update('runs',message.runId!,{status:'succeeded'});await transport.tick();await transport.tick();
 const reply=(id:number,text:string,user=123)=>({update_id:id,message:{message_id:id,from:{id:user},chat:{id:123,type:'private'},text,reply_to_message:{message_id:42}}});
 api.mockResolvedValue({ok:true,result:[reply(1,`APPROVE ${proposal.id}`,999),reply(2,'yes'),reply(3,`APPROVE ${proposal.id}`)]});await transport.tick();
 expect(store.need('attention',proposal.id).disposition).toMatchObject({decision:'approved',channel:'telegram'});
 const disposition=store.need('attention',proposal.id).disposition;
 store.close();store=new CompanyStore(root);
 api.mockResolvedValue({ok:true,result:[reply(3,`APPROVE ${proposal.id}`),reply(4,`DENY ${proposal.id}`)]});await new TelegramTransport(store,config,api).tick();
 expect(store.need('attention',proposal.id).disposition).toEqual(disposition);expect(store.policy.spendingLimit).toBe(0);
});
