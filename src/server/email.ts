import { createHash, createHmac } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { CompanyStore } from '../storage/store.js';
import { DomainError } from '../core/types.js';
import { queueOwnerConversation } from './owner-conversation.js';
import { sourceRoot } from './paths.js';

const schema=z.object({mailbox:z.email().refine(value=>/^[a-zA-Z0-9._-]{1,7}@/.test(value)),owner:z.email(),endpoint:z.url().refine(value=>new URL(value).protocol==='https:'),token:z.string().min(32),replyKey:z.string().regex(/^[a-f0-9]{64}$/),dailyHourUtc:z.number().int().min(0).max(23)}).strict();
export type EmailConfig=z.infer<typeof schema>;
export type EmailApi=(path:string,body?:unknown)=>Promise<any>;
const integrationId='owner-email';
export function emailConfig(root:string):EmailConfig|undefined{
 const path=join(root,'credentials/email.json');if(!existsSync(path))return;
 try{if((statSync(path).mode&0o077)!==0)throw new Error();return schema.parse(JSON.parse(readFileSync(path,'utf8')));}catch{throw new Error('Email requires valid private mode-600 credentials/email.json.');}
}
/** Authenticated private relay; the daemon never needs the Owner's personal inbox. */
export function emailApi(config:EmailConfig):EmailApi{
 return async(path,body)=>{
  const response=await fetch(`${config.endpoint.replace(/\/$/,'')}/${path}`,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${config.token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(path==='send'?60000:15000),redirect:'error'});
  if(!response.ok)throw new Error('Email request has no confirmed receipt');return response.json();
 };
}
/** One daemon poller; prepared effects survive interruption and uncertain sends never replay. */
export class EmailTransport{
 private active=false;
 private stopped=false;
 private timer?:ReturnType<typeof setTimeout>;
 private verified=false;
 private binding:string;
 constructor(private store:CompanyStore,private config:EmailConfig,private api:EmailApi=emailApi(config)){
  this.binding=createHash('sha256').update(`${config.mailbox.toLowerCase()}:${config.owner.toLowerCase()}:${config.replyKey}`).digest('hex');
  const prior=store.get('integrations',integrationId);
  if(prior&&prior.binding!==this.binding)throw new Error('Reconcile retained email identity before changing configuration.');
  if(!prior)store.put('integrations',{id:integrationId,name:'Owner email',status:'ready',detail:'Configured; delivery not yet observed.',binding:this.binding,enabledAt:new Date().toISOString()});
  for(const action of store.list('actions').filter(a=>a.kind==='email.send'&&a.status==='dispatched'))store.update('actions',action.id,{status:'uncertain',uncertainReason:'Interrupted email send; inspect provider delivery records before reconciliation.'});
 }
 start(){void this.cycle();}
 async stop(){this.stopped=true;clearTimeout(this.timer);while(this.active)await new Promise(resolve=>setTimeout(resolve,20));}
 private async cycle(){try{await this.tick();}catch{if(this.store.db.open)this.store.update('integrations',integrationId,{detail:'Email unavailable; check private configuration, relay settings or network. Uncertain sends remain held.'});}finally{if(!this.stopped)this.timer=setTimeout(()=>void this.cycle(),60000);}}
 private reference(id:string){const [local,domain]=this.config.mailbox.split('@');return `${local}+${id.replaceAll('-','')}${createHmac('sha256',this.config.replyKey).update(id).digest('hex').slice(0,24)}@${domain}`;}
 async tick(now=new Date()){
  if(this.active||this.stopped)return;this.active=true;
  const restore=this.store.company.restoreTransactionId,current=()=>!this.stopped&&this.store.db.open&&this.store.company.restoreTransactionId===restore;
  try{
   if(this.store.need('integrations',integrationId).status==='blocked')return;
   if(!this.verified){const profile=await this.api('profile');if(!current())return;if(profile.mailbox?.toLowerCase()!==this.config.mailbox.toLowerCase()||profile.owner?.toLowerCase()!==this.config.owner.toLowerCase())throw new Error('Email mailbox mismatch');this.verified=true;}
   if(this.store.company.state==='running'){
    this.queueDaily(now);this.queueOutgoing();
    const action=this.store.list('actions').find(a=>a.kind==='email.send'&&a.target===this.binding&&a.status==='prepared');
    if(action){
     const parent=action.content.parentActionId?this.store.get('actions',action.content.parentActionId):undefined;
     this.store.update('actions',action.id,{status:'dispatched'});
     try{const receipt=await this.api('send',{text:action.content.text,replyTo:this.reference(action.id),...(parent?.remoteRef?{inReplyTo:parent.remoteRef}:{})});if(!current())return;if(typeof receipt.id!=='string')throw new Error();this.store.update('actions',action.id,{status:'succeeded',remoteRef:receipt.id});}catch{if(current())this.store.update('actions',action.id,{status:'uncertain',uncertainReason:'No confirmed email receipt; inspect provider delivery records. Never resend blindly.'});}
    }
   }
   if(!current())return;
   const page=await this.api('inbox');
   if(!current())return;
   for(const item of page.messages??[]){
    const id=`email:${this.binding}:${item.id}`;
    if(!this.store.get('messages',id)){
     const parent=this.store.list('actions').find(a=>a.kind==='email.send'&&a.target===this.binding&&['succeeded','uncertain'].includes(a.status)&&item.to===this.reference(a.id));
     if(!parent||item.from?.toLowerCase()!==this.config.owner.toLowerCase()||typeof item.text!=='string'||!item.text.trim()||item.text.length>20000)continue;
     const safe=item.text.replace(/[a-zA-Z0-9._-]+\+[a-f0-9]{56}@[a-zA-Z0-9.-]+/g,'[private email reference]');
     this.store.db.transaction(()=>{this.store.put('messages',{id,senderId:'owner',recipientId:null,projectId:null,content:safe,runId:null,email:{direction:'incoming',parentActionId:parent.id,binding:this.binding}});this.store.emit('email.received',{messageId:id});})();
    }
    // Acknowledge only after durable intake. Replay after a lost ACK is harmless.
    await this.api('ack',{id:item.id});if(!current())return;
   }
   this.store.update('integrations',integrationId,{detail:'Polling active; authenticated replies enter the shared confidential conversation.'});
   for(const message of this.store.list('messages').filter(m=>m.email?.direction==='incoming')){
    if(!this.store.list('assignments').some(a=>a.payload?.messageId===message.id)){
     const parent=this.store.get('actions',message.email.parentActionId),original=parent?this.store.get('messages',parent.content.messageId):undefined;
     try{queueOwnerConversation(this.store,{content:`Owner email reply to shared message ${original?.id??'unavailable'}:\n${message.content}`,employeeId:original?.senderId&&this.store.get('employees',original.senderId)?.status==='active'?original.senderId:undefined},message.id);}catch(error){if(!(error instanceof DomainError&&error.code==='recipient_unavailable'))throw error;}
    }
   }
  }finally{this.active=false;}
 }
 private queueDaily(now:Date){
  if(now.getUTCHours()<this.config.dailyHourUtc)return;
  const key=`email:daily:${this.binding}:${now.toISOString().slice(0,10)}`;
  if(this.store.list('assignments').some(a=>a.schedulerKey===key))return;
  // Do not accumulate catch-up reports while an earlier report is unfinished.
  if(this.store.list('assignments').some(a=>a.payload?.emailReport&&!['completed','cancelled'].includes(a.status)))return;
  const ceo=this.store.list('employees').find(e=>e.status==='active'&&this.store.level(e.id)==='ceo');if(!ceo)return;
  this.store.put('assignments',{employeeId:ceo.id,supervisorId:ceo.id,projectId:null,title:'Daily Owner email',instructions:readFileSync(join(sourceRoot,'skills/executive-email.md'),'utf8'),acceptance:['Write an honest useful daily report from current company evidence.'],dependencies:[],status:'queued',priority:60,attempts:0,corrections:0,kind:'conversation',dataClass:'confidential',availableAt:now.toISOString(),accepted:true,schedulerKey:key,payload:{emailReport:true}});
 }
 private queueOutgoing(){
  for(const message of this.store.list('messages')){
   if(message.createdAt<this.store.need('integrations',integrationId).enabledAt||message.recipientId!=='owner'||message.channel!=='email')continue;
   const run=this.store.get('runs',message.runId??'');if(!run||run.status!=='succeeded')continue;
   const dedupeKey=`email:${this.binding}:${message.id}`;if(this.store.list('actions').some(a=>a.dedupeKey===dedupeKey))continue;
   const assignment=this.store.get('assignments',run.assignmentId),incoming=this.store.get('messages',assignment?.payload?.messageId??'');
   this.store.put('actions',{employeeId:message.senderId,runId:run.id,productId:'',kind:'email.send',target:this.binding,content:{messageId:message.id,text:`${this.store.get('employees',message.senderId)?.name??message.senderId}:\n\n${message.content}`,parentActionId:incoming?.email?.parentActionId},dedupeKey,status:'prepared',policyRevision:run.policyRevision,cost:0,costEvidence:'Cloudflare verified destination; no paid sending requested.'});
  }
 }
}
export function reconcileEmail(store:CompanyStore,id:string,outcome:'delivered'|'absent',evidence:string){
 const action=store.need('actions',id);if(action.kind!=='email.send'||!['uncertain','failed'].includes(action.status))throw new DomainError('email_reconcile_denied','Only held email sends can be reconciled.',409);
 if(!evidence.trim())throw new DomainError('evidence_required','Record what you observed in provider delivery records and the Owner mailbox.');
 if(outcome==='absent'&&(action.retryCount??0)>=1)throw new DomainError('retry_exhausted','One confirmed-absence retry already used.',409);
 return store.update('actions',id,{status:outcome==='delivered'?'succeeded':'prepared',reconciliation:{outcome,evidence,at:new Date().toISOString(),actor:'owner'},...(outcome==='absent'?{retryCount:1}:{})});
}
