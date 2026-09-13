import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CompanyStore } from '../storage/store.js';
const execute=promisify(execFile);
export interface NotificationResult { status:'submitted'|'unavailable'; detail:string }
export type OwnerNotifier=(title:string,body:string)=>Promise<NotificationResult>;
/** Nonmodal local notification. OS acceptance does not prove presentation or user acknowledgement. */
export const macOSOwnerNotifier:OwnerNotifier=async(title,body)=>{
 if(process.platform!=='darwin')return {status:'unavailable',detail:'macOS local notification adapter is unavailable on this host'};
 const quote=(s:string)=>`"${s.replaceAll('\\','\\\\').replaceAll('"','\\"').replace(/[\r\n]/g,' ')}"`;
 try{
  await execute('/usr/bin/osascript',['-e',`display notification ${quote(body.slice(0,1200))} with title ${quote(title.slice(0,160))}`],{timeout:20_000,maxBuffer:4096});
  return {status:'submitted',detail:'macOS accepted the notification command. Presentation and user acknowledgement are unconfirmed and may require Notification settings consent.'};
 }catch(error){return {status:'unavailable',detail:error instanceof Error?error.message.slice(0,500):'Local notification failed'};}
};
/** One bounded local request at a time, with intent persisted before display and four-hour reminders. */
const pending=new WeakSet<CompanyStore>();
export async function notifyOwnerRequests(store:CompanyStore,notify:OwnerNotifier=macOSOwnerNotifier,now=Date.now()):Promise<void>{
 if(store.company.state!=='running'||pending.has(store))return;
 const request=store.list('attention').find(a=>a.status==='open'&&a.kind==='owner_decision'&&a.explicitRequest===true&&a.requiredAction&&(!a.notification?.attemptedAt||Date.parse(a.notification.attemptedAt)+4*3600_000<=now));
 if(!request)return;
 const attemptedAt=new Date(now).toISOString(),attempt=(request.notification?.attempt??0)+1;
 store.update('attention',request.id,{notification:{status:'dispatching',attemptedAt,attempt}});
 pending.add(store);
 let result:NotificationResult;try{result=await notify(request.title,`${request.requiredAction}\nRecommendation: ${request.recommendation??request.detail}`);}catch(error){result={status:'unavailable',detail:error instanceof Error?error.message.slice(0,500):'Notification adapter failed'};}finally{pending.delete(store);}
 if(!store.db.open)return;
 const retained=store.get('attention',request.id);
 if(!retained)return;
 if(retained.notification?.attempt!==attempt)return;
 store.update('attention',request.id,{notification:{...result,attemptedAt,attempt,finishedAt:new Date().toISOString()},notificationHistory:[...(retained.notificationHistory??[]),{...result,attemptedAt,attempt}]});
 store.emit('owner.notification',{attentionId:request.id,status:result.status,attempt});
}
