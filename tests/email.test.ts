import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyStore } from '../src/storage/store.js';
import { EmailTransport, reconcileEmail, type EmailApi } from '../src/server/email.js';
import worker from '../src/server/email-worker.js';
let root:string,store:CompanyStore;
const config={mailbox:'ceo@example.com',owner:'owner@example.net',endpoint:'https://synthetic.example.com',token:'SYNTHETIC_TEST_TOKEN_NOT_A_REAL_SECRET',replyKey:'a'.repeat(64),dailyHourUtc:23};
const now=new Date('2026-09-14T12:00:00Z');
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'opencorp-email-'));store=new CompanyStore(root);store.bootstrap();store.update('company',store.company.id,{state:'running'});});
afterEach(()=>{if(store.db.open)store.close();rmSync(root,{recursive:true,force:true});});
function outgoing(){const ceo=store.list('employees').find(e=>store.level(e.id)==='ceo')!;const run=store.put('runs',{employeeId:ceo.id,assignmentId:'synthetic',status:'succeeded',policyRevision:store.policy.revision});return store.put('messages',{senderId:ceo.id,recipientId:'owner',channel:'email',projectId:null,content:'Delivery observed; adoption still unknown.',runId:run.id});}
function apiWithSend(send:(body:any)=>Promise<any>){return vi.fn<EmailApi>().mockImplementation(async(path,body)=>path==='profile'?{mailbox:config.mailbox,owner:config.owner}:path==='send'?send(body):{messages:[]});}
it('holds uncertain sending across restart and permits only one confirmed-absence retry',async()=>{
 const api=apiWithSend(async()=>{expect(store.list('actions')[0]?.status).toBe('dispatched');throw new Error('synthetic interruption');});
 let transport=new EmailTransport(store,config,api);outgoing();await transport.tick(now);const action=store.list('actions')[0]!;expect(action.status).toBe('uncertain');
 store.close();store=new CompanyStore(root);transport=new EmailTransport(store,config,api);await transport.tick(now);expect(api.mock.calls.filter(c=>c[0]==='send')).toHaveLength(1);
 reconcileEmail(store,action.id,'absent','Owner verified absence in delivery records and inbox.');await transport.tick(now);expect(api.mock.calls.filter(c=>c[0]==='send')).toHaveLength(2);expect(()=>reconcileEmail(store,action.id,'absent','Absent again')).toThrow('One confirmed-absence retry');
});
it('rejects spoofed replies, retains contextual confidential work before ACK and deduplicates replay after restore',async()=>{
 let replyTo='';const api=apiWithSend(async body=>{replyTo=body.replyTo;return {id:'synthetic-provider-receipt'};});
 const transport=new EmailTransport(store,config,api),backup=store.backup(),original=outgoing();await transport.tick(now);
 const incoming={id:'b'.repeat(64),from:config.owner,to:replyTo,text:'Prioritize the obstacle in that report.'};
 api.mockImplementation(async(path)=>{
  if(path==='inbox')return {messages:[{...incoming,id:'c'.repeat(64),from:'intruder@example.net'},{...incoming,id:'d'.repeat(64),to:'ceo+forged@example.com'},incoming]};
  if(path==='ack'){expect(store.list('messages').some(m=>m.email?.direction==='incoming')).toBe(true);return {ok:true};}return {mailbox:config.mailbox,owner:config.owner};
 });
 await transport.tick(now);expect(store.list('assignments')).toHaveLength(1);expect(store.list('assignments')[0]).toMatchObject({dataClass:'confidential',employeeId:original.senderId});expect(store.list('assignments')[0]?.instructions).toContain(original.id);
 store.update('company',store.company.id,{state:'paused'});store.restore(backup.path);store.update('company',store.company.id,{state:'running'});await transport.tick(now);
 expect(store.list('assignments')).toHaveLength(1);expect(store.get('messages',original.id)).toBeDefined();expect(store.list('actions').filter(a=>a.kind==='email.send')).toHaveLength(1);
});
it('preserves completed undispatched email and pending daily work through restore without report catch-up duplication',async()=>{
 const api=apiWithSend(async()=>({id:'receipt'})),transport=new EmailTransport(store,config,api),backup=store.backup();
 await transport.tick(new Date('2026-09-14T23:00:00Z'));const assignment=store.list('assignments')[0]!;expect(assignment.payload?.emailReport).toBe(true);
 await transport.tick(new Date('2026-09-15T23:00:00Z'));expect(store.list('assignments')).toHaveLength(1);
 const message=outgoing();store.update('runs',message.runId!,{assignmentId:assignment.id});store.update('assignments',assignment.id,{status:'completed'});
 store.update('company',store.company.id,{state:'paused'});store.restore(backup.path);store.update('company',store.company.id,{state:'running'});await transport.tick(now);
 expect(store.get('messages',message.id)).toBeDefined();expect(store.list('actions')[0]?.status).toBe('succeeded');
});
it('does not dispatch while stopped or through a mismatched relay identity',async()=>{
 const api=apiWithSend(async()=>({id:'receipt'})),transport=new EmailTransport(store,config,api);outgoing();store.update('company',store.company.id,{state:'stopped'});await transport.tick(now);expect(api.mock.calls.some(c=>c[0]==='send')).toBe(false);
 api.mockResolvedValue({mailbox:'wrong@example.com',owner:config.owner});await expect(new EmailTransport(store,config,api).tick(now)).rejects.toThrow('mailbox mismatch');
});
it('relay rejects unauthenticated access and forged inbound reply capabilities without storing content',async()=>{
 const env={TOKEN:config.token,REPLY_KEY:config.replyKey,MAILBOX:config.mailbox,OWNER:config.owner,EMAIL:{send:vi.fn()},INBOX:{put:vi.fn(),get:vi.fn(),list:vi.fn(),delete:vi.fn()}};
 expect((await worker.fetch(new Request('https://example.com/inbox'),env)).status).toBe(401);
 const reject=vi.fn();await worker.email({from:config.owner,to:'ceo+'+'0'.repeat(56)+'@example.com',rawSize:10,raw:new ReadableStream(),setReject:reject},env);expect(reject).toHaveBeenCalledOnce();expect(env.INBOX.put).not.toHaveBeenCalled();
});
it('applies only the exact nonbillable action, rejects a changed scope and preserves decisions through restore',async()=>{
 let replyTo='';const api=apiWithSend(async body=>{replyTo=body.replyTo;return {id:'proposal-receipt'};});
 const transport=new EmailTransport(store,config,api),message=outgoing();store.update('messages',message.id,{recipientId:message.senderId});store.update('runs',message.runId!,{status:'running',tokenRevoked:false});
 const actor={kind:'employee' as const,employeeId:message.senderId,runId:message.runId!,policyRevision:store.policy.revision};
 const action=store.put('actions',{employeeId:actor.employeeId,runId:actor.runId,productId:store.list('products')[0]!.id,kind:'validation',target:'local-only',content:{operation:'record-only'},dedupeKey:'synthetic-validation',status:'prepared',policyRevision:store.policy.revision,cost:0,costEvidence:'Nonbillable local check'});
 const backup=store.backup();
 const proposal=store.command(actor,{type:'owner.propose',title:'Local check',content:'No real effect.',proposalScope:'Record one local validation only.',actionId:action.id,expiresAt:new Date(Date.now()+3600000).toISOString(),channel:'email'});
 expect(()=>store.dispatchAction(actor,action.id)).toThrow();
 store.update('runs',actor.runId,{status:'succeeded'});await transport.tick(now);
 api.mockImplementation(async path=>path==='inbox'?{messages:[{id:'e'.repeat(64),from:config.owner,to:replyTo,text:`APPROVE ${proposal.id}\n\nOn Monday, CEO wrote:\n> Earlier proposal` }]}:{ok:true});
 await transport.tick(now);expect(store.need('attention',proposal.id).disposition).toMatchObject({decision:'approved',channel:'email'});
 store.update('runs',actor.runId,{tokenRevoked:true});const successor=store.put('runs',{...store.need('runs',actor.runId),id:undefined,status:'running',tokenRevoked:false});const resumed={...actor,runId:successor.id};
 store.update('runs',successor.id,{assignmentId:'different-work'});expect(()=>store.dispatchAction(resumed,action.id)).toThrow('assignment');store.update('runs',successor.id,{assignmentId:store.need('runs',actor.runId).assignmentId});store.update('actions',action.id,{target:'changed-target'});expect(()=>store.dispatchAction(resumed,action.id)).toThrow('scope');
 store.update('actions',action.id,{target:'local-only'});store.update('attention',proposal.id,{expiresAt:new Date(0).toISOString()});expect(()=>store.dispatchAction(resumed,action.id)).toThrow('expiration');store.update('attention',proposal.id,{expiresAt:new Date(Date.now()+3600000).toISOString()});expect(store.dispatchAction(resumed,action.id).status).toBe('dispatched');expect(()=>store.dispatchAction(resumed,action.id)).toThrow();
 store.update('company',store.company.id,{state:'paused'});store.restore(backup.path);
 expect(store.need('attention',proposal.id).disposition.decision).toBe('approved');expect(store.need('actions',action.id).status).toBe('uncertain');
});
it.each(['denied','expired','wrong-thread','conditional','quoted','condition-after-quote'])('keeps %s replies from granting authority',async mode=>{
 let replyTo='';const api=apiWithSend(async body=>{replyTo=body.replyTo;return {id:'nonbillable-receipt'};});
 const transport=new EmailTransport(store,config,api);
 const proposal=store.command({kind:'owner'},{type:'owner.propose',title:'Harmless scope',content:'No external effect.',proposalScope:'Record only.',expiresAt:new Date(Date.now()+3600000).toISOString(),channel:'email'});
 await transport.tick(now);
 if(mode==='expired')store.update('attention',proposal.id,{expiresAt:new Date(0).toISOString()});
 if(mode==='wrong-thread'){const other=outgoing();await transport.tick(now);expect(other.id).not.toBe(proposal.messageId);}
 const content=mode==='denied'?`DENY ${proposal.id}`:mode==='condition-after-quote'?`APPROVE ${proposal.id}\n\nOn Monday, CEO wrote:\n> proposal\n\nOnly if price drops.`:mode==='conditional'?`APPROVE ${proposal.id} if the price changes`:mode==='quoted'?`> APPROVE ${proposal.id}`:`APPROVE ${proposal.id}`;
 api.mockImplementation(async path=>path==='inbox'?{messages:[{id:'f'.repeat(64),from:config.owner,to:replyTo,text:content}]}:{ok:true});
 await transport.tick(now);
 expect(store.need('attention',proposal.id).disposition?.decision).toBe(mode==='denied'?'denied':undefined);expect(store.policy.spendingLimit).toBe(0);
});
