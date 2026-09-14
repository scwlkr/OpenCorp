import { resolveOwnerProposal, ownerDirectedProposal } from '../core/owner-proposals.js';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../core/types.js';
import type { CompanyStore } from '../storage/store.js';
import { queueOwnerConversation } from './owner-conversation.js';

const configSchema=z.object({ownerUserId:z.number().int().positive().safe(),chatId:z.number().int().positive().safe()}).strict();
export type TelegramConfig=z.infer<typeof configSchema>&{token:string};
type Update={update_id:number;message?:{message_id:number;from?:{id:number;is_bot?:boolean};chat:{id:number;type:string};text?:string;reply_to_message?:{message_id:number}}};
type ApiResult={ok:boolean;result?:any;error_code?:number};
export type TelegramApi=(method:'getUpdates'|'sendMessage',body:Record<string,unknown>,signal:AbortSignal)=>Promise<ApiResult>;
const integrationId='owner-telegram';
export function telegramConfig(root:string):TelegramConfig|undefined{
 const settings=join(root,'credentials/telegram.json'),key=join(root,'credentials/telegram.key');
 if(!existsSync(settings)&&!existsSync(key))return;
 try{
  for(const path of [settings,key])if((statSync(path).mode&0o077)!==0)throw new Error();
  const config=configSchema.parse(JSON.parse(readFileSync(settings,'utf8'))),token=readFileSync(key,'utf8').trim();
  if(!/^\d+:[A-Za-z0-9_-]+$/.test(token)||config.chatId!==config.ownerUserId)throw new Error();
  return {...config,token};
 }catch{throw new Error('Telegram requires private mode-600 credentials/telegram.json (verified ownerUserId and matching private chatId) and telegram.key.');}
}
/** Official HTTPS Bot API; never persist or log URLs, raw errors, or token-bearing responses. */
export function telegramApi(config:TelegramConfig):TelegramApi{
 return async(method,body,signal)=>{
  const response=await fetch(`https://api.telegram.org/bot${config.token}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal,redirect:'error'});
  return await response.json() as ApiResult;
 };
}

/** Single daemon-owned poller. SQLite commits intake before acknowledging Telegram's offset. */
export class TelegramTransport{
 private stopped=false;
 private active=false;
 private controller=new AbortController();
 private timer?:ReturnType<typeof setTimeout>;
 private readonly binding:string;
 constructor(private store:CompanyStore,private config:TelegramConfig,private api:TelegramApi=telegramApi(config)){
  this.binding=createHash('sha256').update(`${config.token.split(':')[0]}:${config.ownerUserId}:${config.chatId}`).digest('hex');
  const prior=store.get('integrations',integrationId);
  if(prior&&prior.binding!==this.binding)throw new Error('Telegram identity changed. Reconcile retained integration before changing the bot or Owner chat.');
  if(!prior)store.put('integrations',{id:integrationId,name:'Owner Telegram',status:'ready',detail:'Configured; real Owner exchange not yet observed.',binding:this.binding,offset:0,enabledAt:new Date().toISOString()});
  for(const action of store.list('actions').filter(a=>a.kind==='telegram.send'&&a.status==='dispatched'))store.update('actions',action.id,{status:'uncertain',uncertainReason:'Service interrupted during Telegram send; inspect the private chat before reconciliation.'});
 }
 start(){void this.cycle();}
 async stop(){this.stopped=true;clearTimeout(this.timer);this.controller.abort();while(this.active)await new Promise(resolve=>setTimeout(resolve,20));}
 private async cycle(){try{await this.tick();}catch{if(this.store.db.open)this.store.update('integrations',integrationId,{detail:'Telegram unavailable; credentials, network, webhook or another poller may need attention. No uncertain send is retried.'});}finally{if(!this.stopped)this.timer=setTimeout(()=>void this.cycle(),3000);}}
 async tick(){
  if(this.active||this.stopped)return;
  this.active=true;
  const restore=this.store.company.restoreTransactionId;
  const current=()=>!this.stopped&&this.store.db.open&&this.store.company.restoreTransactionId===restore;
  try{
   const integration=this.store.need('integrations',integrationId);
   if(integration.status==='blocked')return;
   // Send before long polling so a completed reply does not wait an extra polling cycle.
   this.queueOutgoing();
   const actions=this.store.list('actions');
   const action=actions.find(a=>a.kind==='telegram.send'&&a.status==='prepared'&&a.target===this.binding&&actions.filter(previous=>previous.kind==='telegram.send'&&previous.content.messageId===a.content.messageId&&previous.content.part<a.content.part).every(previous=>previous.status==='succeeded'));
   if(action&&this.store.company.state==='running'){
    // An unresolved earlier part holds this message, not unrelated conversations.
    {
     this.store.update('actions',action.id,{status:'dispatched'});
     try{
      const response=await this.api('sendMessage',{chat_id:this.config.chatId,text:action.content.text},AbortSignal.any([this.controller.signal,AbortSignal.timeout(15000)]));
      if(!current())return;
      if(response.ok===true&&Number.isSafeInteger(response.result?.message_id))this.store.update('actions',action.id,{status:'succeeded',remoteRef:String(response.result.message_id),result:{messageId:response.result.message_id}});
      else this.store.update('actions',action.id,{status:response.ok===false&&[400,401,403,429].includes(response.error_code??0)?'failed':'uncertain',result:{detail:'Telegram send did not return a confirmed receipt.',code:response.error_code}});
     }catch{if(current())this.store.update('actions',action.id,{status:'uncertain',uncertainReason:'No confirmed Telegram receipt. Inspect the chat; do not resend blindly.'});}
    }
   }
   if(!current())return;
   const response=await this.api('getUpdates',{offset:integration.offset,timeout:20,limit:100,allowed_updates:['message']},AbortSignal.any([this.controller.signal,AbortSignal.timeout(25000)]));
   if(!current())return;
   if(response.ok!==true||!Array.isArray(response.result))throw new Error('Telegram polling unavailable');
   for(const update of response.result as Update[])this.accept(update);
   for(const message of this.store.list('messages').filter(m=>m.telegram?.direction==='incoming')){
    if(!this.store.list('assignments').some(a=>a.payload?.messageId===message.id)){
     try{const response=resolveOwnerProposal(this.store,message,message.telegram.parentActionId);queueOwnerConversation(this.store,{content:response?`${message.content}\nVerified proposal response: ${JSON.stringify(response)}. Report this recorded outcome; do not reinterpret it or change permissions.`:message.content},message.id);}catch(error){if(!(error instanceof DomainError&&error.code==='recipient_unavailable'))throw error;}
    }
   }
  }finally{this.active=false;}
 }
 private accept(update:Update){
  if(!Number.isSafeInteger(update.update_id)||update.update_id<0)return;
  this.store.db.transaction(()=>{
   const integration=this.store.need('integrations',integrationId);
   if(update.update_id<integration.offset)return;
   const message=update.message;
   if(message?.from?.id===this.config.ownerUserId&&message.from.is_bot!==true&&message.chat.id===this.config.chatId&&message.chat.type==='private'&&typeof message.text==='string'&&message.text.trim()&&message.text.length<=20000){
    const id=`telegram:${this.binding}:${update.update_id}`;
    if(!this.store.get('messages',id))this.store.put('messages',{id,senderId:'owner',recipientId:null,projectId:null,content:message.text,runId:null,telegram:{direction:'incoming',updateId:update.update_id,messageId:message.message_id,binding:this.binding,parentActionId:this.store.list('actions').find(a=>a.kind==='telegram.send'&&a.target===this.binding&&a.remoteRef===String(message.reply_to_message?.message_id))?.id}});
    this.store.emit('telegram.received',{messageId:id});
   }
   this.store.update('integrations',integrationId,{offset:update.update_id+1,detail:'Polling active; verified text messages retained in the shared conversation.'});
  })();
 }
 private queueOutgoing(){
  const integration=this.store.need('integrations',integrationId);
  for(const message of this.store.list('messages')){
   if(message.channel==='email'||message.recipientId!=='owner'||message.senderId==='owner'||message.createdAt<integration.enabledAt)continue;
   const run=message.runId?this.store.get('runs',message.runId):undefined;
   if((!run||run.status!=='succeeded')&&!ownerDirectedProposal(this.store,message))continue;
   // Plain text, bounded chunks; no Markdown parser or silent truncation.
   const characters=Array.from(`${this.store.get('employees',message.senderId)?.name??message.senderId}: ${message.content}`);
   this.store.db.transaction(()=>{
    for(let offset=0;offset<characters.length;offset+=2000){
     const part=offset/2000,dedupeKey=`telegram:${this.binding}:${message.id}:${part}`;
     if(this.store.list('actions').some(a=>a.dedupeKey===dedupeKey))continue;
     this.store.put('actions',{employeeId:message.senderId,runId:run?.id??'',productId:'',kind:'telegram.send',target:this.binding,content:{messageId:message.id,part,text:characters.slice(offset,offset+2000).join('')},dedupeKey,status:'prepared',policyRevision:run?.policyRevision??this.store.policy.revision,cost:0,costEvidence:'Telegram Bot API ordinary message; paid broadcast disabled.'});
    }
   })();
  }
 }
}

export function reconcileTelegram(store:CompanyStore,id:string,outcome:'delivered'|'absent',evidence:string){
 const action=store.need('actions',id);
 if(action.kind!=='telegram.send'||!['uncertain','failed'].includes(action.status))throw new DomainError('telegram_reconcile_denied','Only held Telegram sends can be reconciled.',409);
 if(!evidence.trim())throw new DomainError('evidence_required','Record what you observed in the private chat.');
 if(outcome==='absent'&&(action.retryCount??0)>=1)throw new DomainError('retry_exhausted','One confirmed-absence retry already used; keep this send held.',409);
 return store.update('actions',id,{status:outcome==='delivered'?'succeeded':'prepared',reconciliation:{outcome,evidence,at:new Date().toISOString(),actor:'owner'},...(outcome==='absent'?{retryCount:1}:{})});
}
