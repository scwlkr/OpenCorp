import { DomainError, type Actor, type CorporateCommand, type Assignment, type Employee } from './types.js';
import type { CompanyStore } from '../storage/store.js';
const terminal=(a:Assignment)=>['completed','cancelled'].includes(a.status);
const text=(value:unknown,label:string)=>{if(typeof value!=='string'||!value.trim()||value.length>8000)throw new DomainError('invalid_input',`${label} must be nonempty text up to 8000 characters`);return value.trim();};
const date=(value:unknown,now:number)=>{const at=Date.parse(text(value,'Recheck date'));if(!Number.isFinite(at)||at<=now||at>now+30*86400_000)throw new DomainError('invalid_input','Recheck must be in the future within 30 days');return new Date(at).toISOString();};
function authority(store:CompanyStore,actor:Actor,employeeId:string){if(actor.kind!=='owner'&&actor.employeeId!==employeeId&&!store.canManage(actor,employeeId))throw new DomainError('forbidden','Only the accountable employee or responsible management can set this continuation',403);}
function active(store:CompanyStore,id:string):Employee|undefined{const e=store.get('employees',id);return e?.status==='active'?e:undefined;}
function managerFor(store:CompanyStore,assignment:Assignment,previous:string[],ceos:Employee[]){
 let manager=active(store,assignment.supervisorId);const seen=new Set<string>();
 while(manager&&!seen.has(manager.id)){seen.add(manager.id);if(!previous.includes(manager.id))return manager;manager=manager.homeManagerId?active(store,manager.homeManagerId):undefined;}
 return ceos.find(e=>!previous.includes(e.id));
}
/** Validated commands retain accountability without weakening acceptance or changing delivered status. */
export function responsibilityCommand(store:CompanyStore,actor:Actor,c:CorporateCommand):unknown {
 store.validateActor(actor);const now=Date.now(),authorId=actor.kind==='employee'?actor.employeeId:'owner';
 if(c.type==='owner.request'){
  const assignment=c.assignmentId?store.need('assignments',c.assignmentId):undefined;
  const ownerId=assignment?.supervisorId??(actor.kind==='employee'?actor.employeeId:text(c.ownerId,'Responsible employee'));authority(store,actor,ownerId);
  if(!active(store,ownerId))throw new DomainError('inactive_employee','Owner request needs an active accountable employee');
  const requiredAction=text(c.requiredAction,'Smallest required Owner action'),recommendation=text(c.recommendation,'Recommendation'),detail=text(c.detail,'Observed prerequisite'),title=text(c.title,'Request title'),nextCheckAt=date(c.nextCheckAt??new Date(now+4*3600_000).toISOString(),now);
  const prior=store.list('attention').find(a=>a.kind==='owner_decision'&&a.status==='open'&&a.ownerId===ownerId&&a.assignmentId===(assignment?.id??null)&&a.requiredAction===requiredAction);
  if(prior)return prior;
  const request=store.put('attention',{kind:'owner_decision',explicitRequest:true,title,detail,status:'open',ownerId,assignmentId:assignment?.id??null,requiredAction,recommendation,nextCheckAt,authorId,runId:actor.kind==='employee'?actor.runId:null,notification:{status:'pending'}});
  if(assignment)store.update('assignments',assignment.id,{continuation:{ownerId,kind:'owner_decision',action:requiredAction,nextCheckAt,attentionId:request.id,authorId,runId:actor.kind==='employee'?actor.runId:null,at:new Date(now).toISOString()}});
  return request;
 }
 if(c.type==='responsibility.update'){
  const assignment=store.need('assignments',text(c.assignmentId,'Assignment'));authority(store,actor,assignment.supervisorId);
  if(terminal(assignment))throw new DomainError('closed_assignment','Closed work cannot acquire a pending continuation');
  const kind=text(c.kind,'Continuation kind');if(!['changed_approach','specialist_help','reassignment','prerequisite_work','scheduled_recheck','owner_decision'].includes(kind))throw new DomainError('invalid_input','Unknown continuation kind. Use changed_approach, specialist_help, reassignment, prerequisite_work, scheduled_recheck or owner_decision; management is an assignment kind. No continuation was recorded.');
  const ownerId=c.ownerId??assignment.supervisorId;if(!active(store,ownerId))throw new DomainError('inactive_employee','Continuation owner must be active');
  if(ownerId!==assignment.supervisorId&&actor.kind!=='owner'&&!store.canManage(actor,ownerId))throw new DomainError('forbidden','Cannot assign accountability outside your management authority',403);
  const action=text(c.action,'Concrete next action'),nextCheckAt=date(c.nextCheckAt??new Date(now+3600_000).toISOString(),now);
  if(c.followupAssignmentId){const followup=store.need('assignments',c.followupAssignmentId);if(terminal(followup)||followup.id===assignment.id)throw new DomainError('invalid_followup','Followup must be distinct nonterminal work');authority(store,actor,followup.supervisorId);}
  if(kind==='owner_decision'){const request=store.need('attention',text(c.attentionId,'Owner request'));if(request.status!=='open'||request.kind!=='owner_decision'||request.assignmentId!==assignment.id)throw new DomainError('invalid_owner_request','Requires an open Owner request for this assignment');}
  const continuation={ownerId,kind,action,nextCheckAt,followupAssignmentId:c.followupAssignmentId??null,attentionId:c.attentionId??null,authorId,runId:actor.kind==='employee'?actor.runId:null,at:new Date(now).toISOString()};
  return store.update('assignments',assignment.id,{continuation,continuationHistory:[...(assignment.continuationHistory??[]),continuation]});
 }
 if(c.type==='review.respond'){
  const decision=store.need('decisions',text(c.decisionId,'Review'));
  if(decision.kind!=='executive.review'||decision.status!=='rejected'||store.list('votes').filter(v=>v.decisionId===decision.id&&v.phase==='initial').length!==3)throw new DomainError('review_not_final','Requires a finalized adverse independent executive review');
  authority(store,actor,decision.payload.employeeId);
  const rationale=text(c.rationale,'Accountable response'),kind=c.kind??'corrective_action';if(!['corrective_action','justified_closure'].includes(kind))throw new DomainError('invalid_input','Response must be corrective_action or justified_closure');
  let followupAssignmentId:string|null=null;
  if(kind==='corrective_action'){const followup=store.need('assignments',text(c.followupAssignmentId,'Corrective assignment'));if(terminal(followup))throw new DomainError('invalid_followup','Corrective assignment must remain actionable');authority(store,actor,followup.supervisorId);followupAssignmentId=followup.id;}
  const response={kind,rationale,followupAssignmentId,authorId,runId:actor.kind==='employee'?actor.runId:null,at:new Date(now).toISOString()};
  return store.update('decisions',decision.id,{response,responses:[...(decision.responses??[]),response]});
 }
 throw new DomainError('invalid_command',`Unknown responsibility command ${c.type}`);
}
function enqueue(store:CompanyStore,employee:Employee,input:{key:string;title:string;instructions:string;payload:Record<string,unknown>}){
 const existing=store.assignmentBySchedulerKey(input.key);if(existing)return existing;
 return store.put('assignments',{projectId:null,employeeId:employee.id,supervisorId:employee.homeManagerId??employee.id,title:input.title,instructions:input.instructions,acceptance:['Record an accountable continuation or justified disposition through company commands.'],dependencies:[],status:'queued',priority:12,attempts:0,corrections:0,kind:'management',availableAt:new Date().toISOString(),schedulerKey:input.key,payload:input.payload});
}
/** Finite management ladder; runtime faults never become an unbounded diagnosis-of-diagnosis tree. */
export function reconcileResponsibilities(store:CompanyStore,now=Date.now()):void {
 store.db.transaction(()=>{
  if(store.company.state!=='running')return;
  // This synchronous pass changes obligations, not employees or their positions.
  const ceos=store.list('employees').filter(e=>e.status==='active'&&store.level(e.id)==='ceo');
  const assignments=store.list('assignments'),at=new Date(now).toISOString(),held=new Set(store.activeRuns().map(r=>r.assignmentId));
  for(const original of assignments.filter(a=>a.status==='blocked'&&a.kind!=='social'&&!/^(fault:|dependency-wait:|responsibility:)/.test(a.schedulerKey??''))){
   if(held.has(original.id))continue;
   const related=assignments.filter(a=>(a.schedulerKey?.startsWith('fault:')&&a.payload?.failedAssignmentId===original.id)||a.schedulerKey?.startsWith(`responsibility:${original.id}:`));
   for(const followup of related)if(['queued','running'].includes(followup.status)&&!active(store,followup.employeeId)&&!held.has(followup.id)){
    const disposition={at,reason:'Assigned employee is no longer active; surviving management retains the original obligation',employeeId:followup.employeeId,priorStatus:followup.status};
    store.update('assignments',followup.id,{status:'cancelled',blockedReason:disposition.reason,responsibilityDisposition:disposition});followup.status='cancelled';store.emit('responsibility.orphaned-followup-cancelled',{assignmentId:followup.id,originalAssignmentId:original.id,...disposition});
   }
   const continuation=original.continuation;
   const resolved=continuation?.kind==='owner_decision'&&continuation.attentionId?store.get('attention',continuation.attentionId):undefined;
   if(resolved?.status==='resolved'&&resolved.assignmentId===original.id&&resolved.kind==='owner_decision'){
    const owner=active(store,resolved.ownerId)??managerFor(store,original,[],ceos);
    if(owner){
     const next=enqueue(store,owner,{key:`responsibility:${original.id}:${owner.id}:owner-resolution:${resolved.id}`,title:`Apply Owner resolution: ${original.title}`,payload:{sourceAssignmentId:original.id,ownerAttentionId:resolved.id},instructions:`Owner resolved request ${resolved.id} for original commitment ${original.id}. Read its complete retained resolution via company_detail attention. Recorded resolution: ${String(resolved.resolution??'Inspect the retained Owner response').slice(0,4000)}. Apply that actual direction through authorized company commands, preserve original acceptance and existing effects, and retain a concrete continuation until work is complete or deliberately cancelled. Do not issue the same unchanged request again. This followup does not itself complete the original work.`});
     store.update('assignments',original.id,{continuation:{ownerId:owner.id,kind:'management_followup',action:'Apply the actual Owner resolution',followupAssignmentId:next.id,nextCheckAt:new Date(now+4*3600_000).toISOString(),at},continuationHistory:[...(original.continuationHistory??[]),continuation]});continue;
    }
   }
   if(continuation&&active(store,continuation.ownerId)&&Date.parse(continuation.nextCheckAt)>now){
    const followup=continuation.followupAssignmentId?store.get('assignments',continuation.followupAssignmentId):undefined;
    const request=continuation.attentionId?store.get('attention',continuation.attentionId):undefined;
    if((!followup||active(store,followup.employeeId)&&!['blocked','completed','cancelled'].includes(followup.status))&&(!request||request.status==='open'))continue;
   }
   const fault=assignments.filter(a=>a.schedulerKey?.startsWith('fault:')&&a.payload?.failedAssignmentId===original.id);
   if(fault.some(a=>['queued','running'].includes(a.status)))continue;
   const followups=assignments.filter(a=>a.schedulerKey?.startsWith(`responsibility:${original.id}:`));
   if(followups.some(a=>['queued','running'].includes(a.status)))continue;
   const newest=followups.at(-1),waitUntil=Date.parse(newest?.updatedAt??original.updatedAt)+30*60_000;
   if(newest&&active(store,newest.employeeId)&&waitUntil>now)continue;
   const owner=managerFor(store,original,followups.map(a=>a.employeeId),ceos);
   if(owner){
    const next=enqueue(store,owner,{key:`responsibility:${original.id}:${owner.id}`,title:`Carry responsibility: ${original.title}`,payload:{sourceAssignmentId:original.id,priorDiagnosisIds:fault.map(a=>a.id)},instructions:`Original commitment ${original.id} remains blocked: ${String(original.blockedReason??'Inspect retained work').slice(0,2000)}. Inspect its acceptance and prior diagnosis records. You remain responsible for resolving it through a changed approach, specialist help, reassignment, prerequisite work, scheduled recheck, or a precise Owner decision. Do not retry unchanged work or create a diagnosis of this followup. Preserve original acceptance. Use responsibility.update with assignmentId ${original.id} (the original obligation), kind, concrete action, ownerId and nextCheckAt; reference a real nonterminal followupAssignmentId when useful. For indispensable Owner input use owner.request with assignmentId, title, observed detail, requiredAction and recommendation. Deliberate cancellation uses the existing authorized assignment.update with honest rationale. Completing this followup never completes the original obligation.`});
    store.update('assignments',original.id,{continuation:{ownerId:owner.id,kind:'management_followup',action:'Resolve original blocked obligation',followupAssignmentId:next.id,nextCheckAt:new Date(now+4*3600_000).toISOString(),at}});
   }else if(!store.list('attention').some(a=>a.status==='open'&&a.responsibilityKey===original.id)){
    const ownerId=active(store,original.supervisorId)?.id??ceos[0]?.id;
    const request=store.put('attention',{kind:'owner_decision',title:`Management needs direction: ${original.title}`,detail:`The available management chain exhausted its bounded recovery turns. Original obligation remains open. ${String(original.blockedReason??'Inspect preserved original work').slice(0,2000)}`,status:'open',ownerId:ownerId??null,assignmentId:original.id,responsibilityKey:original.id,requiredAction:'Choose a changed direction, assign additional help, or explicitly cancel this original commitment.',recommendation:'Review the retained management attempts and choose a narrower actionable next step while preserving the original outcome.',nextCheckAt:new Date(now+4*3600_000).toISOString(),notification:{status:'pending'}});
    store.update('assignments',original.id,{continuation:{ownerId:ownerId??null,kind:'owner_decision',action:request.requiredAction,attentionId:request.id,nextCheckAt:request.nextCheckAt,at}});
   }
  }
  for(const decision of store.list('decisions').filter(d=>d.kind==='executive.review'&&d.status==='rejected'&&!d.response)){
   if(store.list('votes').filter(v=>v.decisionId===decision.id&&v.phase==='initial').length!==3)continue;
   const executive=active(store,decision.payload.employeeId);if(!executive)continue;
   enqueue(store,executive,{key:`review-response:${decision.id}`,title:`Respond to Elder review: ${decision.subject}`,payload:{decisionId:decision.id},instructions:`All three independent initial judgments for executive review ${decision.id} are finalized and the majority is adverse. Read the decision and all retained judgments, including dissent. Record an accountable response using review.respond with decisionId, rationale, kind corrective_action plus a real followupAssignmentId, or kind justified_closure with a concrete evidence-based rationale. Address the substance; do not erase the review, manufacture delivery, or treat timeout as grounds for dismissal. Any replacement remains a separate independent Elder majority decision.`});
  }
 })();
}
