import { DomainError, POSITION_LEVEL_RANK, type PositionLevel, type Actor, type Assignment, type CorporateCommand } from './types.js';
import type { CompanyStore } from '../storage/store.js';
import { assertRetainedSourceLicense } from './source-license.js';

const text=(value:unknown,name:string)=>{if(typeof value!=='string'||!value.trim()||value.length>16000)throw new DomainError('invalid_input',`${name} requires bounded nonempty text`);return value.trim();};
const manager=(store:CompanyStore,actor:Actor,id:string)=>{const employee=store.need('employees',id);if(employee.status!=='active'||!['ceo','executive','lead','manager'].includes(store.level(id)))throw new DomainError('invalid_manager','Active management required');if(actor.kind!=='owner'&&actor.employeeId!==id&&!store.canManage(actor,id))throw new DomainError('forbidden','Responsible home management required',403);};
const record=(store:CompanyStore,id:string,kind:string)=>{const item=store.need('experiences',id);if(item.kind!==kind)throw new DomainError('invalid_record',`Expected ${kind}`);return item;};
const audit=(actor:Actor)=>({authorId:actor.kind==='owner'?'owner':actor.employeeId,runId:actor.kind==='employee'?actor.runId:null,at:new Date().toISOString()});

export function currentRequisition(store:CompanyStore,req:any) {
 const position=store.need('positions',req.positionId),department=store.need('departments',req.departmentId);
 if(position.status!=='active'||position.departmentId!==req.departmentId||['elder','ceo','executive'].includes(position.level)||department.status==='retired'||department.managerId!==req.departmentManagerId)throw new DomainError('stale_requisition','Department or position authority changed; current management must authorize a new requisition',409);
 const home=store.need('employees',req.homeManagerId);
 if(home.status!=='active'||!['ceo','executive','lead','manager'].includes(store.level(home.id)))throw new DomainError('stale_requisition','Home management changed; reauthorize staffing',409);
}

/** Only scheduler-owned staffing keys identify automatic recruitment continuations. */
export function staffingTarget(assignment:Assignment){
 if(assignment.kind!=='management'||assignment.projectId!==null||assignment.payload?.formation!==true)return;
 const match=/^formation:(request|candidate|approve|provision):([^:]+)(?::([^:]+))?$/.exec(assignment.schedulerKey??'');
 if(!match||match[1]==='provision'&&match[3]!==undefined||match[1]==='request'&&!match[3]||['candidate','approve'].includes(match[1])&&!/^\d+$/.test(match[3]??''))return;
 return {phase:match[1],id:match[2],suffix:match[3]};
}

export function candidateMembers(assignment:Assignment):string[]{
 const id=assignment.schedulerKey?.split(':')[2],batch=assignment.payload?.candidateRequisitionIds;
 if(!id)return [];
 if(staffingTarget(assignment)?.phase==='candidate'&&Array.isArray(batch)&&batch.length>=2&&batch.length<=3&&batch[0]===id&&batch.every(v=>typeof v==='string'&&v&&!v.includes(':'))&&new Set(batch).size===batch.length)return batch;
 return [id];
}

/** Recruitment carries scoped manager authorization, never executive appointment authority. */
export function organizationCommand(store:CompanyStore,actor:Actor,c:CorporateCommand):unknown {
 store.validateActor(actor);
 switch(c.type){
  case 'department.update': {
   const department=store.need('departments',c.departmentId);manager(store,actor,department.managerId);
   const patch:Record<string,unknown>={};
   for(const key of ['name','responsibilities','charter','helpPolicy'])if(c[key]!==undefined)patch[key]=text(c[key],key);
   if(c.standingDuties!==undefined){if(!Array.isArray(c.standingDuties)||c.standingDuties.length>12)throw new DomainError('invalid_duties','Use at most 12 standing duties');patch.standingDuties=c.standingDuties.map((d:any)=>({name:text(d.name,'Duty'),instructions:text(d.instructions,'Instructions'),intervalHours:Math.max(1,Math.min(720,Number(d.intervalHours)||24))}));}
   if(c.relatedDepartmentIds!==undefined){if(!Array.isArray(c.relatedDepartmentIds))throw new DomainError('invalid_departments','Related departments must be an array');patch.relatedDepartmentIds=c.relatedDepartmentIds.map((id:string)=>store.need('departments',id).id);}
   if(c.managerId){manager(store,actor,c.managerId);patch.managerId=c.managerId;}
   return store.update('departments',department.id,{...patch,history:[...(department.history??[]),{...audit(actor),prior:{name:department.name,responsibilities:department.responsibilities,managerId:department.managerId,charter:department.charter},rationale:text(c.rationale,'Rationale')}].slice(-50)});
  }
  case 'department.merge': {
   const from=store.need('departments',c.departmentId),to=store.need('departments',c.targetDepartmentId);
   if(from.id===to.id||from.status==='retired'||to.status==='retired')throw new DomainError('invalid_merge','Select distinct active departments');
   manager(store,actor,from.managerId);manager(store,actor,to.managerId);text(c.rationale,'Rationale');
   for(const employee of store.list('employees').filter(e=>e.departmentId===from.id))store.update('employees',employee.id,{departmentId:to.id});
   for(const position of store.list('positions').filter(p=>p.departmentId===from.id))store.update('positions',position.id,{departmentId:to.id});
   store.update('departments',to.id,{standingDuties:[...(to.standingDuties??[]),...(from.standingDuties??[])],inheritedDepartmentIds:[...new Set([...(to.inheritedDepartmentIds??[]),from.id,...(from.inheritedDepartmentIds??[])])]});
   return store.update('departments',from.id,{status:'retired',successorId:to.id,retirement:{...audit(actor),rationale:c.rationale}});
  }
  case 'position.update': {
   const position=store.need('positions',c.positionId);
   if(['elder','ceo','executive'].includes(position.level))throw new DomainError('governance_required','Executive offices retain governance protection',403);
   if(!position.departmentId)throw new DomainError('department_required','Position needs departmental responsibility');
   manager(store,actor,store.need('departments',position.departmentId).managerId);
   if(c.level!==undefined){
    if(typeof c.level!=='string'||!['lead','manager','worker','support'].includes(c.level))throw new DomainError('invalid_position_level','Use lead, manager, worker or support; executive offices require governance');
    if(c.level!==position.level&&actor.kind!=='owner'&&POSITION_LEVEL_RANK[c.level as PositionLevel]<=POSITION_LEVEL_RANK[store.level(actor.employeeId)])throw new DomainError('forbidden','Cannot change a position to your own or higher organizational authority',403);
    if(position.status!=='active')throw new DomainError('inactive_position','Only active unfilled positions can change level');
    if(store.list('appointments').some(a=>a.positionId===position.id&&!a.endedAt))throw new DomainError('occupied_position','An occupied position cannot change level; preserve its employee appointment');
   }
   if(c.status==='retired'&&store.list('appointments').some(a=>a.positionId===position.id&&!a.endedAt))throw new DomainError('occupied_position','Reassign the employee before retiring their position');
   if(c.status!==undefined&&!['active','retired'].includes(c.status))throw new DomainError('invalid_status','Use active or retired');
   return store.update('positions',position.id,{...(c.title?{title:text(c.title,'Title')}:{}),...(c.responsibilities?{responsibilities:text(c.responsibilities,'Responsibilities')}:{}),...(c.status?{status:c.status}:{}),...(c.level!==undefined?{level:c.level}:{}),history:[...(position.history??[]),{...audit(actor),title:position.title,responsibilities:position.responsibilities,...(c.level!==undefined?{level:position.level}:{}),rationale:text(c.rationale,'Rationale')}]});
  }
  case 'recruitment.request': {
   const position=store.need('positions',c.positionId),homeManagerId=text(c.homeManagerId,'Home manager');manager(store,actor,homeManagerId);
   if(!position.departmentId||['elder','ceo','executive'].includes(position.level)||position.status!=='active')throw new DomainError('invalid_requisition','Recruitment requires an active nonexecutive departmental position');
   manager(store,actor,store.need('departments',position.departmentId).managerId);
   const recruiter=store.need('employees',c.recruiterId);if(recruiter.status!=='active')throw new DomainError('inactive_recruiter','Select an active Recruitment employee');
   const prior=store.list('experiences').find(r=>r.kind==='requisition'&&r.positionId===position.id&&r.status!=='cancelled');if(prior){try{currentRequisition(store,prior);return prior;}catch(error){if(!(error instanceof DomainError)||error.code!=='stale_requisition')throw error;store.update('experiences',prior.id,{status:'cancelled',supersession:{...audit(actor),reason:error.message}});}}
   if(store.list('appointments').some(a=>a.positionId===position.id&&!a.endedAt))throw new DomainError('occupied_position','Position is already staffed');
   const replacement=store.put('experiences',{kind:'requisition',status:'open',positionId:position.id,departmentId:position.departmentId,departmentManagerId:store.need('departments',position.departmentId).managerId,homeManagerId,recruiterId:recruiter.id,brief:text(c.brief,'Staffing brief'),firstWork:text(c.firstWork,'First work or explicit standby condition'),authorization:audit(actor)});
   if(prior){
    const supersession={...store.need('experiences',prior.id).supersession,...audit(actor),replacementRequisitionId:replacement.id,reason:'Current management reauthorized this staffing obligation after its prior authority became stale'};
    store.update('experiences',prior.id,{supersession});
    const candidates=new Set(store.list('experiences').filter(r=>r.kind==='candidate'&&r.requisitionId===prior.id).map(r=>r.id));
    const held=new Set(store.list('runs').filter(r=>['running','cancelling','uncertain'].includes(r.status)).map(r=>r.assignmentId));
    for(const task of store.list('assignments').filter(a=>a.status==='queued'&&!held.has(a.id))){
     const target=staffingTarget(task);if(!target)continue;
     if(target.phase==='candidate'&&candidateMembers(task).length>1&&candidateMembers(task).includes(prior.id)){
      store.update('assignments',task.id,{memberSupersessions:{...(task.memberSupersessions??{}),[prior.id]:supersession}});
      if(!candidateMembers(task).every(id=>store.get('experiences',id)?.supersession?.replacementRequisitionId))continue;
      store.update('assignments',task.id,{status:'cancelled',blockedReason:'Every batch requisition was superseded by actual management reauthorization',supersession});continue;
     }
     if(target.phase==='request'?target.id===prior.positionId&&target.suffix===prior.departmentManagerId:target.phase==='candidate'?target.id===prior.id:candidates.has(target.id))store.update('assignments',task.id,{status:'cancelled',blockedReason:`Superseded by authorized recruitment request ${replacement.id}`,supersession:{...supersession,sourceRequisitionId:prior.id}});
    }
   }
   return replacement;
  }
  case 'recruitment.candidate': {
   const req=record(store,c.requisitionId,'requisition');
   if(actor.kind!=='employee'||actor.employeeId!==req.recruiterId||req.status!=='open')throw new DomainError('recruiter_required','Only the assigned Recruitment employee may author a candidate for an open requisition',403);
   currentRequisition(store,req);
   const prior=store.list('experiences').find(r=>r.kind==='candidate'&&r.requisitionId===req.id);if(prior&&prior.status!=='changes_requested'){for(const id of prior.sourceIds??[])assertRetainedSourceLicense(store,record(store,id,'skill-source'));return prior;}
   if(!Array.isArray(c.sourceIds)||!c.sourceIds.length||c.sourceIds.length>5)throw new DomainError('sources_required','Select one to five imported competency sources');
   for(const id of c.sourceIds){
    const source=record(store,id,'skill-source'),inspection=store.need('runs',actor.runId).skillInspections?.[id];
    if(!inspection?.complete||inspection.sha256!==source.sha256){
     // SkillSources.read retains sorted, merged ranges; their zero-based prefix
     // ends at the first missing character. A different hash needs a fresh read.
     const offset=inspection?.sha256===source.sha256?(inspection.ranges?.find(([start]:[number,number])=>start===0)?.[1]??0):0;
     throw new DomainError('source_inspection_required',`Read every page of each pinned skill source in this Recruitment run before adapting the candidate. Source ${id} is incomplete or its inspection hash differs. Next call: skill_read ${JSON.stringify({sourceId:id,offset})}. Continue with returned nextOffset until inspectionComplete is true, then retry recruitment.candidate. company_detail source metadata does not inspect its contents; no candidate was recorded.`,403);
    }
   }
   for(const id of c.sourceIds)assertRetainedSourceLicense(store,record(store,id,'skill-source'));
   if(!Array.isArray(c.competencies)||c.competencies.length<1||c.competencies.length>6)throw new DomainError('competencies_required','Supply one to six specific competencies');
   const candidate=store.put('experiences',{...(prior?{id:prior.id,createdAt:prior.createdAt,history:[...(prior.history??[]),{...prior,history:undefined}]}:{}),version:(prior?.version??0)+1,kind:'candidate',status:'proposed',requisitionId:req.id,positionId:req.positionId,departmentId:req.departmentId,name:text(c.name,'Name'),role:text(c.role,'Tailored role'),modelId:text(c.modelId,'Model'),competencies:c.competencies.map((v:unknown)=>text(v,'Competency')),sourceIds:[...new Set(c.sourceIds)],adaptation:text(c.adaptation,'OpenCorp adaptation'),onboarding:text(c.onboarding,'Onboarding'),authorship:audit(actor)});
   return candidate;
  }
  case 'recruitment.reject': {
   const candidate=record(store,c.candidateId,'candidate'),req=record(store,candidate.requisitionId,'requisition');currentRequisition(store,req);manager(store,actor,req.homeManagerId);manager(store,actor,req.departmentManagerId);
   if(req.status!=='open'||candidate.status==='hired')throw new DomainError('closed_requisition','Only an open unfilled requisition can request candidate changes');
   return store.update('experiences',candidate.id,{status:'changes_requested',feedback:{...audit(actor),rationale:text(c.rationale,'Requested changes')}});
  }
  case 'recruitment.approve': {
   const candidate=record(store,c.candidateId,'candidate'),req=record(store,candidate.requisitionId,'requisition');currentRequisition(store,req);manager(store,actor,req.homeManagerId);manager(store,actor,req.departmentManagerId);
   if(candidate.status==='approved'||candidate.status==='hired')return candidate;
   if(req.status!=='open')throw new DomainError('closed_requisition','Requisition is closed');
   return store.update('experiences',candidate.id,{status:'approved',approval:{...audit(actor),rationale:text(c.rationale,'Rationale')}});
  }
  case 'recruitment.onboard': {
   const employee=store.need('employees',c.employeeId);if(!employee.requisitionId&&!(actor.kind==='owner'&&employee.roleAuthorship?.authorId==='owner'&&employee.roleAuthorship?.runId===null&&employee.roleAuthorship?.basis==='Owner-directed appointment'))throw new DomainError('not_recruited','No recruitment appointment or direct Owner-authored appointment eligible for Owner onboarding');
   manager(store,actor,employee.homeManagerId!);
   if(employee.status!=='active')throw new DomainError('inactive_employee','Only active employees can accept onboarding');
   const standbyCondition=c.standbyCondition?text(c.standbyCondition,'Standby condition'):null;
   if(!standbyCondition&&!store.list('assignments').some(a=>a.employeeId===employee.id&&a.accepted&&a.status!=='cancelled'))throw new DomainError('first_work_required','Assign accepted first work or record an explicit standby condition before accepting onboarding');
   return store.update('employees',employee.id,{onboarding:{status:'accepted',...audit(actor),rationale:text(c.rationale,'Observed onboarding acceptance'),standbyCondition}});
  }
 }
 throw new DomainError('invalid_command','Unknown organization command');
}

/** Called only inside the store command transaction, then existing hire validators run. */
export function authorizedRecruitment(store:CompanyStore,actor:Actor,c:CorporateCommand){
 store.validateActor(actor);
 const candidate=record(store,c.candidateId,'candidate'),req=record(store,candidate.requisitionId,'requisition');
 if(actor.kind!=='employee'||actor.employeeId!==req.recruiterId)throw new DomainError('recruiter_required','Only assigned Recruitment can provision this hire',403);
 if(candidate.status==='hired'&&req.employeeId)return {employee:store.need('employees',req.employeeId)};
 currentRequisition(store,req);
 if(candidate.status!=='approved'||req.status!=='open')throw new DomainError('approval_required','Home manager must approve the candidate first',403);
 if(candidate.approval?.authorId!=='owner'){const approver=store.need('employees',candidate.approval?.authorId);manager(store,{kind:'employee',employeeId:approver.id,runId:actor.runId,policyRevision:actor.policyRevision},req.homeManagerId);if(approver.status!=='active')throw new DomainError('stale_requisition','Approving manager is no longer active',409);}
 for(const id of candidate.sourceIds??[])assertRetainedSourceLicense(store,record(store,id,'skill-source'));
 const currentManager=store.need('employees',req.homeManagerId);if(currentManager.status!=='active')throw new DomainError('inactive_manager','Reauthorize staffing under current management');
 manager(store,{kind:'employee',employeeId:req.homeManagerId,runId:actor.runId,policyRevision:actor.policyRevision},store.need('departments',req.departmentId).managerId);
 return {candidate,req,command:{type:'employee.hire',name:candidate.name,positionId:req.positionId,modelId:candidate.modelId,role:candidate.role,homeManagerId:req.homeManagerId,source:JSON.stringify({candidateId:candidate.id,sourceIds:candidate.sourceIds,runId:candidate.authorship.runId})}};
}
