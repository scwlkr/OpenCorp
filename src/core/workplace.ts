import { DomainError, type Actor, type CorporateCommand, type Message, type RecordBase } from './types.js';
import type { CompanyStore } from '../storage/store.js';

export interface WorkplaceChannel extends RecordBase { kind: 'workplace.channel'; name: string; departmentId: string | null }
export interface WorkplaceEvent extends RecordBase {
  kind: 'workplace.event'; title: string; purpose: string; channelId: string; hostId: string; participantIds: string[];
  eventType: 'welcome'|'formation_anniversary'|'fictional_birthday'|'office_party'|'gathering';
  scheduledAt: string; status: 'scheduled'|'active'|'paused'|'completed'|'cancelled';
  durationMinutes: number; maxTurnsPerParticipant: number; recurrence: 'none'|'annual'|'weekly';
  occurrence: number; subjectEmployeeId: string | null; fictional: boolean;
}
const settingsId='workplace.settings';
const text=(value:unknown,label:string,max=2000)=>{
  if(typeof value!=='string'||!value.trim()||value.length>max)throw new DomainError('invalid_input',`${label} must contain 1–${max} characters`);
  return value.trim();
};
const integer=(value:unknown,fallback:number,min:number,max:number)=>{
  if(value===undefined)return fallback;
  if(typeof value!=='number'||!Number.isInteger(value)||value<min||value>max)throw new DomainError('invalid_input',`Value must be an integer from ${min} to ${max}`);
  return value;
};
const date=(value:unknown)=>{const parsed=Date.parse(text(value,'Schedule',40));if(!Number.isFinite(parsed))throw new DomainError('invalid_input','Schedule must be a valid date');return new Date(parsed).toISOString();};
function validateFormationAnniversary(formedAt:string,scheduledAt:string){
  const formed=new Date(formedAt),scheduled=new Date(scheduledAt),year=scheduled.getUTCFullYear();
  const day=Math.min(formed.getUTCDate(),new Date(Date.UTC(year,formed.getUTCMonth()+1,0)).getUTCDate());
  if(year<=formed.getUTCFullYear()||scheduled.getUTCMonth()!==formed.getUTCMonth()||scheduled.getUTCDate()!==day)throw new DomainError('invalid_anniversary_date',`Formation anniversaries use the subject employee's actual formation date ${formedAt}, not a department date, in a later year (first anniversary no earlier than ${formed.getUTCFullYear()+1}). Match its UTC month/day; February 29 is observed February 28 in non-leap years. Use welcome or gathering for a formation-day demonstration. Choose and submit the intended date; no event was created or rescheduled.`);
}
const activeEmployee=(store:CompanyStore,id:string)=>{const employee=store.need('employees',id);if(employee.status!=='active')throw new DomainError('inactive_employee','Workplace participants must be active employees');return employee;};
export function workplaceSettings(store:CompanyStore){
  const saved=store.get('experiences',settingsId);
  return {enabled:saved?.enabled??true,maxConcurrentSocial:saved?.maxConcurrentSocial??1,reservedProductiveSlots:saved?.reservedProductiveSlots??1,minEventIntervalMinutes:saved?.minEventIntervalMinutes??60,microModelId:saved?.microModelId??store.list('models').find(m=>m.local&&m.available&&m.artifactIdentity&&m.sizeClass==='micro')?.name??null};
}
export function workplaceSnapshot(store:CompanyStore){
  const records=store.list('experiences');
  return {settings:workplaceSettings(store),channels:records.filter(r=>r.kind==='workplace.channel') as WorkplaceChannel[],events:records.filter(r=>r.kind==='workplace.event') as WorkplaceEvent[],messages:store.list('messages').filter(m=>m.channelId)};
}
function channel(store:CompanyStore,id:string){const result=store.get('experiences',id);if(result?.kind!=='workplace.channel')throw new DomainError('invalid_channel','channelId must identify a retained workplace.channel in experiences, not a department or event. Read company_read {collection:"experiences"} for workplace records, or use company_command {command:{type:"workplace.channel.create",name:your chosen name,departmentId:optional department ID}} and use its returned id. No workplace action was applied.');return result as WorkplaceChannel;}
function event(store:CompanyStore,id:string){const result=store.need('experiences',id);if(result.kind!=='workplace.event')throw new DomainError('invalid_event','Expected a workplace event');return result as WorkplaceEvent;}
function canHost(store:CompanyStore,actor:Actor,value:WorkplaceEvent){
  if(actor.kind!=='owner'&&actor.employeeId!==value.hostId&&!store.canManage(actor,value.hostId))throw new DomainError('forbidden','Only the host or responsible management can change this event',403);
}
function cancelTurns(store:CompanyStore,value:WorkplaceEvent,reason:string){
  for(const assignment of store.list('assignments').filter(a=>a.kind==='social'&&a.payload?.eventId===value.id&&!['completed','cancelled'].includes(a.status))){
    store.update('assignments',assignment.id,{status:'cancelled',blockedReason:reason});
    for(const run of store.list('runs').filter(r=>r.assignmentId===assignment.id&&['running','queued','cancelling'].includes(r.status)))store.revokeRun(run.id,reason);
  }
}
/** Called by CompanyStore.command inside its validated, audited transaction. */
export function workplaceCommand(store:CompanyStore,actor:Actor,c:CorporateCommand):unknown {
  store.validateActor(actor);
  switch(c.type){
    case 'workplace.configure': {
      if(actor.kind!=='owner')throw new DomainError('forbidden','Only the Owner may change social compute allocation',403);
      const prior=workplaceSettings(store);
      if(c.enabled!==undefined&&typeof c.enabled!=='boolean')throw new DomainError('invalid_input','Enabled must be boolean');
      let microModelId=prior.microModelId;
      if(c.microModelId!==undefined){const id=text(c.microModelId,'Social model',200),model=store.list('models').find(m=>m.id===id||m.name===id);if(!model?.local||!model.available||!model.artifactIdentity||!['micro','small'].includes(model.sizeClass))throw new DomainError('unavailable_model','Social model must be an available local micro or small model');microModelId=model.name;}
      const saved=store.put('experiences',{id:settingsId,kind:'workplace.settings',...prior,microModelId,enabled:c.enabled??prior.enabled,maxConcurrentSocial:integer(c.maxConcurrentSocial,prior.maxConcurrentSocial,0,10),reservedProductiveSlots:integer(c.reservedProductiveSlots,prior.reservedProductiveSlots,1,10),minEventIntervalMinutes:integer(c.minEventIntervalMinutes,prior.minEventIntervalMinutes,1,10080)});
      if(!saved.enabled)for(const value of workplaceSnapshot(store).events.filter(e=>e.status==='active')){cancelTurns(store,value,'Workplace events paused by Owner');store.update('experiences',value.id,{status:'paused'});}
      return saved;
    }
    case 'workplace.channel.create': {
      const departmentId=c.departmentId??null;if(departmentId)store.need('departments',departmentId);
      const name=text(c.name,'Channel name',120);
      const prior=workplaceSnapshot(store).channels.find(ch=>ch.name===name&&ch.departmentId===departmentId);if(prior)return prior;
      return store.put('experiences',{kind:'workplace.channel',name,departmentId,authorId:actor.kind==='owner'?'owner':actor.employeeId});
    }
    case 'workplace.event.create': {
      const hostId=actor.kind==='employee'?actor.employeeId:text(c.hostId,'Host');activeEmployee(store,hostId);
      const channelId=text(c.channelId,'Channel');channel(store,channelId);
      if(!Array.isArray(c.participantIds)||c.participantIds.some((id:unknown)=>typeof id!=='string'))throw new DomainError('invalid_input','Participants must be employee IDs');
      const participantIds=[...new Set<string>([hostId,...c.participantIds])];
      if(participantIds.length>10)throw new DomainError('invalid_input','An event supports at most ten participants');
      participantIds.forEach(id=>activeEmployee(store,id));
      const eventType=c.eventType??'gathering';if(!['welcome','formation_anniversary','fictional_birthday','office_party','gathering'].includes(eventType))throw new DomainError('invalid_input','Unknown event type');
      const recurrence=c.recurrence??(['formation_anniversary','fictional_birthday'].includes(eventType)?'annual':'none');if(!['none','annual','weekly'].includes(recurrence))throw new DomainError('invalid_input','Unknown event recurrence');
      const subjectEmployeeId=c.subjectEmployeeId??null;
      if(['welcome','formation_anniversary','fictional_birthday'].includes(eventType)&&!subjectEmployeeId)throw new DomainError('invalid_input','This event requires its subject employee');
      const subject=subjectEmployeeId?activeEmployee(store,subjectEmployeeId):undefined;
      const scheduledAt=date(c.scheduledAt);
      if(eventType==='formation_anniversary'&&subject)validateFormationAnniversary(subject.createdAt,scheduledAt);
      return store.put('experiences',{kind:'workplace.event',title:text(c.title,'Event title',160),purpose:text(c.purpose,'Event purpose'),channelId,hostId,participantIds,eventType,scheduledAt,status:'scheduled',durationMinutes:integer(c.durationMinutes,15,1,60),maxTurnsPerParticipant:integer(c.maxTurnsPerParticipant,1,1,2),recurrence,occurrence:0,subjectEmployeeId,fictional:eventType==='fictional_birthday',formationDate:eventType==='formation_anniversary'?subject?.createdAt:undefined,createdByRunId:actor.kind==='employee'?actor.runId:null});
    }
    case 'workplace.event.update': {
      const value=event(store,text(c.eventId,'Event'));canHost(store,actor,value);
      if(!['paused','cancelled','scheduled'].includes(c.status))throw new DomainError('invalid_input','Event status must be paused, cancelled, or scheduled');
      if(c.status==='scheduled'&&!['paused','scheduled'].includes(value.status))throw new DomainError('invalid_event_state','Only a paused or scheduled event can be rescheduled');
      const scheduledAt=c.scheduledAt?date(c.scheduledAt):value.scheduledAt;
      if(value.eventType==='formation_anniversary'&&(c.scheduledAt||c.status==='scheduled'))validateFormationAnniversary(store.need('employees',value.subjectEmployeeId!).createdAt,scheduledAt);
      cancelTurns(store,value,`Event ${c.status}`);
      return store.update('experiences',value.id,{status:c.status,...(c.scheduledAt?{scheduledAt}:{}),activeUntil:null});
    }
    case 'workplace.message.send': {
      if(!workplaceSettings(store).enabled)throw new DomainError('workplace_paused','Workplace conversation is paused');
      if(actor.kind!=='employee')throw new DomainError('forbidden','Social messages must be authored by an actual employee run',403);
      const run=store.need('runs',actor.runId),assignment=store.need('assignments',run.assignmentId);
      if(assignment.kind==='social')return recordSocialResponse(store,run.id,text(c.content,'Message',4000));
      const channelId=text(c.channelId,'Channel');channel(store,channelId);
      if(store.list('messages').some(m=>m.runId===run.id&&m.channelId))throw new DomainError('social_turn_limit','One spontaneous social message is allowed per productive run');
      return store.put('messages',{senderId:actor.employeeId,recipientId:null,projectId:null,content:text(c.content,'Message',4000),runId:actor.runId,channelId,eventId:null});
    }
    default: throw new DomainError('invalid_command',`Unknown workplace command ${c.type}`);
  }
}
/** The final text of a real active employee turn, never a builder transcript. Idempotent across completion retries. */
export function recordSocialResponse(store:CompanyStore,runId:string,content:string):Message {
  return store.db.transaction(()=>{
    const run=store.need('runs',runId);store.validateActor({kind:'employee',employeeId:run.employeeId,runId,policyRevision:run.policyRevision});
    const assignment=store.need('assignments',run.assignmentId);
    if(assignment.kind!=='social'||assignment.status!=='running')throw new DomainError('invalid_social_turn','Message requires an active scheduled social turn');
    const prior=store.list('messages').find(m=>m.runId===runId&&m.eventId===assignment.payload?.eventId);if(prior)return prior;
    const value=event(store,assignment.payload?.eventId);
    if(value.status!=='active'||value.occurrence!==assignment.payload?.occurrence||Date.parse(value.activeUntil)<=Date.now()||!value.participantIds.includes(run.employeeId))throw new DomainError('event_inactive','Event session is no longer active');
    const message=store.put('messages',{senderId:run.employeeId,recipientId:null,projectId:null,content:text(content,'Message',4000),runId,channelId:value.channelId,eventId:value.id,occurrence:value.occurrence,fictionalContext:value.fictional});
    store.emit('workplace.message',{id:message.id,eventId:value.id,employeeId:run.employeeId,runId});return message;
  })();
}
function nextSchedule(value:WorkplaceEvent,now:number){
  const next=new Date(value.scheduledAt);
  if(value.recurrence==='weekly'){const week=7*86400_000;return new Date(next.getTime()+Math.max(1,Math.floor((now-next.getTime())/week)+1)*week).toISOString();}
  const anchor=value.eventType==='formation_anniversary'&&value.formationDate?new Date(value.formationDate):next;
  const month=anchor.getUTCMonth(),day=anchor.getUTCDate();
  next.setUTCDate(1);next.setUTCMonth(month);
  next.setUTCFullYear(Math.max(next.getUTCFullYear()+1,new Date(now).getUTCFullYear()));
  next.setUTCDate(Math.min(day,new Date(Date.UTC(next.getUTCFullYear(),month+1,0)).getUTCDate()));
  if(next.getTime()<=now){next.setUTCDate(1);next.setUTCFullYear(next.getUTCFullYear()+1);next.setUTCDate(Math.min(day,new Date(Date.UTC(next.getUTCFullYear(),month+1,0)).getUTCDate()));}
  return next.toISOString();
}
/** Scheduler maintenance: no model calls, finite assignments, one coalesced occurrence after sleep. */
export function reconcileWorkplace(store:CompanyStore,now=Date.now()):void {
  store.db.transaction(()=>{
    if(store.company.state!=='running')return;
    const settings=workplaceSettings(store);if(!settings.enabled)return;
    const events=store.list('experiences').filter(r=>r.kind==='workplace.event') as WorkplaceEvent[];
    let messages:Message[]|undefined;
    for(const value of events.filter(e=>e.status==='active')){
      const turns=store.list('assignments').filter(a=>a.kind==='social'&&a.payload?.eventId===value.id&&a.payload?.occurrence===value.occurrence);
      if(Date.parse(value.activeUntil)>now&&turns.some(a=>!['completed','cancelled','blocked'].includes(a.status)))continue;
      cancelTurns(store,value,'Bounded workplace session ended');
      messages??=store.list('messages').filter(m=>m.channelId);
      store.update('experiences',value.id,{status:value.recurrence==='none'?'completed':'scheduled',...(value.recurrence==='none'?{}:{scheduledAt:nextSchedule(value,now)}),endedAt:new Date(now).toISOString(),actualMessageCount:messages.filter(m=>m.eventId===value.id&&m.occurrence===value.occurrence).length});
    }
    const current=store.list('experiences').filter(r=>r.kind==='workplace.event') as WorkplaceEvent[];
    if(current.some(e=>e.status==='active'))return;
    const lastStarted=Math.max(0,...events.map(e=>Date.parse(e.startedAt??'')||0));
    if(now-lastStarted<settings.minEventIntervalMinutes*60_000)return;
    const due=current.filter(e=>e.status==='scheduled'&&Date.parse(e.scheduledAt)<=now).sort((a,b)=>b.scheduledAt.localeCompare(a.scheduledAt));
    // Old one-shot parties do not become a replay queue after sleep. Retain honest cancelled records.
    for(const stale of due.slice(1))store.update('experiences',stale.id,stale.recurrence==='none'?{status:'cancelled',endedAt:new Date(now).toISOString(),cancellationReason:'Missed event coalesced after inactivity'}:{scheduledAt:nextSchedule(stale,now),coalescedAt:new Date(now).toISOString()});
    const value=due[0];if(!value)return;
    const socialModel=store.list('models').find(m=>m.name===settings.microModelId||m.id===settings.microModelId);
    if(!socialModel?.local||!socialModel.available||!socialModel.artifactIdentity)return;
    const participants=value.participantIds.filter(id=>store.get('employees',id)?.status==='active');
    if(!participants.includes(value.hostId)){store.update('experiences',value.id,{status:'paused',pauseReason:'Event host unavailable'});return;}
    const occurrence=value.occurrence+1,at=new Date(now).toISOString();
    store.update('experiences',value.id,{status:'active',occurrence,startedAt:at,activeUntil:new Date(now+value.durationMinutes*60_000).toISOString(),coalescedFrom:Date.parse(value.scheduledAt)<now-60_000?value.scheduledAt:null});
    let previousRound:string[]=[];
    for(let turn=1;turn<=value.maxTurnsPerParticipant;turn++){
      const thisRound:string[]=[];
      for(const employeeId of participants){
        const employee=store.need('employees',employeeId);
        const assignment=store.put('assignments',{projectId:null,employeeId,supervisorId:employee.homeManagerId??value.hostId,title:`${value.title} — social turn ${turn}`,instructions:`Participate in the internal ${value.eventType.replaceAll('_',' ')}: ${value.purpose}. Channel: ${channel(store,value.channelId).name}. ${value.fictional?'Birthday/persona details are fictional AI character details, not human biography. ':''}Write one brief, natural message in your own voice; respectful disagreement or opting out is fine. Do not invent work, memories, or event activity. Your final response is posted as your attributed chat message. No artifact or tool action is required. Read the supplied recent conversation before replying. Do not create more assignments or request replies.`,acceptance:[],dependencies:previousRound,status:'queued',priority:-100,attempts:0,corrections:0,kind:'social',availableAt:at,schedulerKey:`workplace:${value.id}:${occurrence}:${employeeId}:${turn}`,payload:{eventId:value.id,channelId:value.channelId,occurrence,turn,modelId:socialModel.name}});
        thisRound.push(assignment.id);
      }
      previousRound=thisRound;
    }
    store.emit('workplace.event.started',{eventId:value.id,occurrence,participantIds:participants});
  })();
}
/** Scheduler must apply this alongside its measured host capacity and normal authority checks. */
export function socialDispatchAllowed(store:CompanyStore,assignmentId:string):boolean {
  const assignment=store.need('assignments',assignmentId);if(assignment.kind!=='social')return true;
  const settings=workplaceSettings(store),value=store.get('experiences',assignment.payload?.eventId);
  if(!settings.enabled||!value||value.status!=='active'||value.occurrence!==assignment.payload?.occurrence||Date.parse(value.activeUntil)<=Date.now())return false;
  const active=store.list('runs').filter(r=>['running','cancelling'].includes(r.status));
  const social=active.filter(r=>store.need('assignments',r.assignmentId).kind==='social').length;
  const slots=store.policy.maxInference===1?1:Math.max(0,store.policy.maxInference-settings.reservedProductiveSlots);
  return social<Math.min(settings.maxConcurrentSocial,slots);
}
export function socialContext(store:CompanyStore,assignmentId:string):string {
  const assignment=store.need('assignments',assignmentId);if(assignment.kind!=='social')return '';
  return store.list('messages').filter(m=>m.channelId===assignment.payload?.channelId&&m.eventId===assignment.payload?.eventId&&m.occurrence===assignment.payload?.occurrence).slice(-12).map(m=>`${store.get('employees',m.senderId)?.name??m.senderId}: ${m.content}`).join('\n').slice(-12000);
}

/** Narrow shared context for attributed social turns; operational role prose is intentionally omitted. */
export function socialSystemPrompt(store:CompanyStore,assignmentId:string):string {
  const assignment=store.need('assignments',assignmentId);
  if(assignment.kind!=='social')throw new DomainError('invalid_social_assignment','Social prompt requires a social assignment');
  const value=event(store,assignment.payload?.eventId),employee=store.need('employees',assignment.employeeId),position=store.need('positions',employee.positionId);
  const subject=value.subjectEmployeeId?store.need('employees',value.subjectEmployeeId):undefined;
  const context={eventType:value.eventType,title:value.title.slice(0,300),purpose:value.purpose.slice(0,1200),
    ...(subject?{subject:{id:subject.id,name:subject.name.slice(0,160)}}:{})};
  return [
    `You are ${employee.name.slice(0,160)}, persistent AI employee ${employee.id}, position ${position.title.slice(0,200)}.`,
    assignment.qualification===true?'This is an isolated qualification copy of an event scenario, not an event in the production company.': 'This is an internal social conversation.',
    `Current event context: ${JSON.stringify(context)}`,
    value.eventType==='fictional_birthday'?'This birthday and its persona details are fictional AI character details, not human biography.':undefined,
    'No personal work history is supplied. Do not claim actual use of a tool or habit, or work you have done, unless supplied evidence establishes it. When evidence is absent, a tentative preference or opting out is fine.',
    'Write one brief natural social message in your own voice relevant to this event and the supplied recent conversation. Respectful disagreement or opting out is fine. Do not invent completed work, shared memories, or event activity. No tools, artifacts, extra assignments, or requests for more replies. Answer only with your chat message.',
  ].filter(Boolean).join('\n');
}
