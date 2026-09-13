import { DomainError } from './types.js';
import { currentRequisition, staffingTarget, candidateMembers } from './organization.js';
import type { CompanyStore } from '../storage/store.js';
import type { Employee, Assignment, EmployeeRun, Decision } from './types.js';

/** Coverage requirements, not employee profiles. Actual managers author charters and hires. */
export const departmentalCoverage:Record<string,string[]>={
 'Chief Technology Officer':['Software Architecture','Web Engineering','Native Applications','Languages & Developer Platforms','Data Engineering','AI & Applied Research','Infrastructure & Reliability','Quality Engineering'],
 'Chief Product Officer':['Product Management','User Research','Design & Accessibility','Product Analytics'],
 'Chief Operating Officer':['Program & Project Management','Internal Tools & Automation','Company Operations','IT & Integration Support','Knowledge & Technical Documentation'],
 'Chief Marketing Officer':['Brand & Creative','Content & Communications','Growth & Distribution','Developer Relations & Community','Customer Support & Success','Market Research & Partnerships'],
 'Chief Financial Officer':['Finance & Resource Planning'],
 'Chief People Officer':['Recruitment & Workforce Planning','Employee Development','Workplace Culture & Events'],
 'Chief Information Security Officer':['Security & Privacy'],
 'General Counsel':['Legal, Licensing & Governance Support'],
};
export function enqueueCompanyWork(store:CompanyStore,employee:Employee,key:string,title:string,instructions:string,priority=45,payload:Record<string,unknown>={}){
 const prior=store.assignmentBySchedulerKey(key);if(prior)return prior;
 return store.put('assignments',{employeeId:employee.id,supervisorId:employee.homeManagerId??employee.id,projectId:null,title,instructions,acceptance:['Perform the assigned organizational action using actual corporate tools and summarize its recorded result.'],kind:'management',status:'queued',priority,attempts:0,corrections:0,dependencies:[],availableAt:new Date().toISOString(),accepted:true,schedulerKey:key,payload:{formation:true,...payload}});
}

function departmentReady(store:CompanyStore,name:string){
 const department=store.list('departments').find(d=>d.name===name&&d.status!=='retired');
 const positions=store.list('positions').filter(p=>p.departmentId===department?.id&&p.status==='active');
 return !!department?.charter&&!!department?.helpPolicy&&department.standingDuties?.length>0&&positions.some(p=>p.level==='lead')&&positions.filter(p=>['worker','support'].includes(p.level)).length>=2;
}

export function departmentMembers(assignment:Assignment):string[]{
 const name=assignment.schedulerKey?.slice('formation:department:'.length),names=assignment.payload?.departmentNames;
 if(!assignment.schedulerKey?.startsWith('formation:department:')||!name)return [];
 if(assignment.kind==='management'&&assignment.projectId===null&&assignment.payload?.formation===true&&Array.isArray(names)&&names.length===2&&names[0]===name&&names.every(n=>typeof n==='string'&&n.trim())&&new Set(names).size===2)return names;
 return [name];
}

function recruitmentOfficer(store:CompanyStore){
 const department=store.list('departments').find(d=>d.name==='Recruitment & Workforce Planning'&&d.status!=='retired');
 if(!department)return;
 return store.list('employees').find(e=>e.status==='active'&&e.departmentId===department.id&&e.homeManagerId&&store.get('positions',e.positionId)?.title==='Recruitment Officer');
}

/** A proposal receipt belongs to the exact task that authored it, even after a drain. */
export function retainedOfficeProposal(store:CompanyStore,assignment:Assignment){
 const title=assignment.schedulerKey?.split(':')[2];
 if(!assignment.schedulerKey?.startsWith('formation:office:'))return;
 return store.list('decisions').find(decision=>{
  if(decision.kind!=='executive.appoint'||!['pending','approved','rejected'].includes(decision.status)||!decision.runId||store.get('positions',decision.payload?.positionId)?.title!==title)return false;
  const source=store.get('runs',decision.runId);
  return source?.assignmentId===assignment.id&&source.employeeId===assignment.employeeId&&decision.authorId===source.employeeId;
 });
}

/** Accepted onboarding still owes the lead handoff while its original remit remains current. */
function onboardingReady(store:CompanyStore,employee:Employee,managerId:string){
 if(employee.onboarding?.status!=='accepted')return false;
 const req=store.get('experiences',employee.requisitionId),department=req?store.get('departments',req.departmentId):undefined;
 const position=store.get('positions',employee.positionId);
 // Later dismissal, reassignment or restructuring must not restore an old reporting plan.
 if(employee.status!=='active'||employee.homeManagerId!==managerId||position?.level!=='lead'||position.status!=='active'||!department||department.status==='retired'||employee.departmentId!==department.id||position.departmentId!==department.id||employee.positionId!==req?.positionId||![managerId,employee.id].includes(department.managerId))return true;
 return department.managerId===employee.id&&!store.list('employees').some(other=>other.id!==employee.id&&other.status==='active'&&other.departmentId===department.id&&other.homeManagerId===managerId&&['worker','support'].includes(store.get('positions',other.positionId)?.level??''));
}

function candidateRecorded(store:CompanyStore,assignment:Assignment,id:string){
 return store.list('experiences').some(r=>r.kind==='candidate'&&r.requisitionId===id&&['proposed','approved','hired','changes_requested'].includes(r.status)&&[r,...(r.history??[])].some(v=>{const source=store.get('runs',v.authorship?.runId);return source?.assignmentId===assignment.id&&source.employeeId===assignment.employeeId;}));
}
function candidateMemberDone(store:CompanyStore,assignment:Assignment,id:string){
 const req=store.get('experiences',id);
 return candidateRecorded(store,assignment,id)||candidateMembers(assignment).length>1&&req?.status==='cancelled'&&!!store.get('experiences',req.supersession?.replacementRequisitionId);
}

/** Factual progress for the exact trusted batch; never authors or approves a missing candidate. */
export function candidateBatchProgress(store:CompanyStore,assignment:Assignment){
 if(staffingTarget(assignment)?.phase!=='candidate')return;
 const members=candidateMembers(assignment);if(members.length<2)return;
 const completedRequisitionIds=members.filter(id=>candidateMemberDone(store,assignment,id)),missingRequisitionIds=members.filter(id=>!completedRequisitionIds.includes(id));
 return {completed:missingRequisitionIds.length===0,completedRequisitionIds,missingRequisitionIds,
  ...(missingRequisitionIds.length?{nextCall:{tool:'company_detail',arguments:{collection:'experiences',id:missingRequisitionIds[0]}},nextStep:'Read the missing member requisition and author only its missing candidate. Retained same-assignment candidates need no repeat; the batch remains incomplete.'}:{nextStep:'Every batch member has a retained candidate receipt or actual management supersession. Summarize the actual records and end; approval and hiring remain separate.'})};
}

/** Retained staffing work must use the current manager's authorization. */
export function formationDispatchAllowed(store:CompanyStore,assignment:Assignment){
 const target=staffingTarget(assignment);if(!target)return true;
 if(target.phase==='candidate'&&candidateMembers(assignment).length>1){
  const members=candidateMembers(assignment);if(members.every(id=>candidateMemberDone(store,assignment,id)))return true;
  return members.some(id=>{if(candidateMemberDone(store,assignment,id))return false;const req=store.get('experiences',id);if(req?.kind!=='requisition'||req.status!=='open'||req.recruiterId!==assignment.employeeId)return false;try{currentRequisition(store,req);return true;}catch(error){if(error instanceof DomainError)return false;throw error;}});
 }
 if(target.phase==='request'){
  const position=store.get('positions',target.id),department=position?.departmentId?store.get('departments',position.departmentId):undefined;
  return position?.status==='active'&&!['elder','ceo','executive'].includes(position.level)&&!!department&&department.status!=='retired'&&department.managerId===target.suffix&&assignment.employeeId===target.suffix;
 }
 const candidate=['approve','provision'].includes(target.phase)?store.get('experiences',target.id):undefined;
 if(target.phase!=='candidate'&&candidate?.kind!=='candidate')return false;
 if(target.phase==='provision'&&candidate?.status==='hired')return true;
 const req=store.get('experiences',target.phase==='candidate'?target.id:candidate?.requisitionId);
 const retained=target.phase==='candidate'?store.list('experiences').find(r=>r.kind==='candidate'&&r.requisitionId===target.id):candidate;
 if(retained&&['proposed','approved','hired','changes_requested'].includes(retained.status)){
  const receipts=[retained,...(retained.history??[])].flatMap(version=>target.phase==='candidate'?[version.authorship]:target.phase==='approve'&&['approved','hired','changes_requested'].includes(retained.status)?[version.approval,version.feedback]:[]);
  if(receipts.some(receipt=>{const source=receipt?.runId?store.get('runs',receipt.runId):undefined;return source?.assignmentId===assignment.id&&source.employeeId===assignment.employeeId;}))return true;
 }
 if(req?.kind!=='requisition'||req.status!=='open'||assignment.employeeId!==(target.phase==='approve'?req.homeManagerId:req.recruiterId))return false;
 try{currentRequisition(store,req);}catch(error){if(error instanceof DomainError)return false;throw error;}
 return target.phase!=='provision'||candidate?.status==='approved';
}

/** A partially written chart cannot silently finish a formation assignment. */
export function formationOutcome(store:CompanyStore,assignment:Assignment,_run:EmployeeRun){
 const key=assignment.schedulerKey??'',id=key.split(':')[2];let passed=false;
 if(key.startsWith('formation:office:'))passed=!!retainedOfficeProposal(store,assignment);
 else if(key.startsWith('formation:department:')){const names=departmentMembers(assignment);passed=names.length>0&&names.every(name=>departmentReady(store,name));}
 else if(key==='formation:recruiter-bootstrap')passed=!!recruitmentOfficer(store);
 else if(key.startsWith('formation:request:'))passed=store.list('experiences').some(r=>r.kind==='requisition'&&r.positionId===id&&r.status!=='cancelled'&&r.departmentManagerId===store.get('departments',r.departmentId)?.managerId);
 else if(key.startsWith('formation:candidate:')){const batch=candidateBatchProgress(store,assignment);if(batch)return {passed:batch.completed,summary:batch.completed?'Every assigned candidate batch member has a retained receipt or actual management supersession.':`Candidate batch incomplete. Missing candidate receipts for requisitions ${JSON.stringify(batch.missingRequisitionIds)}. Retained members ${JSON.stringify(batch.completedRequisitionIds)} need no repeat. Read each missing requisition and author its candidate; do not end after only the first member.`};passed=candidateMembers(assignment).every(member=>candidateMemberDone(store,assignment,member));}
 else if(key.startsWith('formation:approve:'))passed=['approved','changes_requested','hired'].includes(store.get('experiences',id)?.status);
 else if(key.startsWith('formation:provision:'))passed=store.get('experiences',id)?.status==='hired';
 else if(key.startsWith('formation:onboard:'))passed=!!store.get('employees',id)&&onboardingReady(store,store.need('employees',id),assignment.employeeId);
 return {passed,summary:passed?'Assigned formation action is retained.':'Complete the assigned formation action: required staffing, charter, source-adapted candidate, approval, onboarding or lead reporting handoff is still absent. Inspect current records and finish only the missing action.'};
}

/** Combine only untouched, never-dispatched initial sourcing tasks as vacancies arrive. */
function coalesceFreshCandidates(store:CompanyStore,experiences:Record<string,any>[],runs:ReadonlySet<string>){
 const fresh=store.list('assignments').filter(a=>staffingTarget(a)?.phase==='candidate'&&a.schedulerKey?.endsWith(':0')&&a.status==='queued'&&a.attempts===0&&!runs.has(a.id)&&a.createdAt===a.updatedAt&&!store.db.prepare("SELECT 1 FROM events WHERE type='assignment.update' AND json_extract(payload,'$.id')=? LIMIT 1").get(a.id)&&candidateMembers(a).every(id=>!experiences.some(c=>c.kind==='candidate'&&c.requisitionId===id)));
 const consumed=new Set<string>();
 for(const first of fresh){
  if(consumed.has(first.id))continue;
  const initial=candidateMembers(first),req=store.get('experiences',initial[0]);if(!req)continue;
  const matching=(ids:string[])=>ids.every(id=>{const other=store.get('experiences',id);if(!other||other.status!=='open'||other.departmentId!==req.departmentId||other.departmentManagerId!==req.departmentManagerId||other.homeManagerId!==req.homeManagerId||other.recruiterId!==req.recruiterId||other.recruiterId!==first.employeeId)return false;try{currentRequisition(store,other);return true;}catch(error){if(error instanceof DomainError)return false;throw error;}});
  if(!matching(initial))continue;
  const members=[...initial],siblings:Assignment[]=[];
  for(const next of fresh){
   if(next.id===first.id||consumed.has(next.id)||next.employeeId!==first.employeeId||next.supervisorId!==first.supervisorId)continue;
   const ids=candidateMembers(next);if(members.length+ids.length>3)continue;
   if(ids.some(id=>members.includes(id))||!matching(ids))continue;
   members.push(...ids);siblings.push(next);consumed.add(next.id);
  }
  if(!siblings.length)continue;
  consumed.add(first.id);
  const audit={at:new Date().toISOString(),reason:'Combine untouched never-dispatched authorized candidate tasks into one bounded sourcing run',retainedAssignmentId:first.id,sourceAssignmentIds:siblings.map(a=>a.id)};
  store.db.transaction(()=>{
  store.update('assignments',first.id,{payload:{...first.payload,candidateRequisitionIds:members},instructions:first.instructions+`\nThe complete fixed batch is now ${JSON.stringify(members)}. Read each requisition and author each candidate separately; reuse relevant sources fully inspected in this run. Retained same-task receipts need no repeat. Finish only after every member has its own candidate receipt or actual management supersession.`,candidateBatchAssembly:{...audit,priorPayload:first.payload,priorInstructions:first.instructions}});
  for(const sibling of siblings)store.update('assignments',sibling.id,{status:'cancelled',blockedReason:`Candidate sourcing retained in batch assignment ${first.id}`,supersession:audit});
  })();
 }
}

/** Pair untouched department work before any executive has started either remit. */
function coalesceFreshDepartments(store:CompanyStore,runs:ReadonlySet<string>){
 const departments=store.list('departments');
 const fresh=store.list('assignments').filter(a=>a.kind==='management'&&a.projectId===null&&a.payload?.formation===true&&a.schedulerKey?.startsWith('formation:department:')&&departmentMembers(a).length===1&&a.status==='queued'&&a.attempts===0&&a.createdAt===a.updatedAt&&!runs.has(a.id)&&store.get('employees',a.employeeId)?.status==='active'&&store.level(a.employeeId)==='executive'&&!store.db.prepare("SELECT 1 FROM events WHERE type='assignment.update' AND json_extract(payload,'$.id')=? LIMIT 1").get(a.id)&&!departments.some(d=>departmentMembers(a).includes(d.name)));
 const consumed=new Set<string>();
 for(const first of fresh){
  if(consumed.has(first.id))continue;
  const sibling=fresh.find(a=>a.id!==first.id&&!consumed.has(a.id)&&a.employeeId===first.employeeId&&a.supervisorId===first.supervisorId&&departmentMembers(a)[0]!==departmentMembers(first)[0]);if(!sibling)continue;
  consumed.add(first.id);consumed.add(sibling.id);
  const names=[...departmentMembers(first),...departmentMembers(sibling)],audit={at:new Date().toISOString(),reason:'Pair untouched never-dispatched departments under the same executive',retainedAssignmentId:first.id,sourceAssignmentIds:[sibling.id]};
  store.db.transaction(()=>{
   store.update('assignments',first.id,{payload:{...first.payload,departmentNames:names},instructions:first.instructions+`\nThis fixed batch covers BOTH departments ${JSON.stringify(names)}. Apply the charter, help policy, standing duties and one lead plus two specialist position requirements separately to EACH. Inspect and reuse partial records; create only missing records. End only when both departments are complete. This batch does not hire employees.`,departmentBatchAssembly:{...audit,priorPayload:first.payload,priorInstructions:first.instructions}});
   store.update('assignments',sibling.id,{status:'cancelled',blockedReason:`Department formation retained in batch assignment ${first.id}`,supersession:audit});
  })();
 }
}

export function reconcileFormation(store:CompanyStore){
 if(!store.company.expansion||store.company.state!=='running')return;
 // This synchronous pass only creates/updates assignments; recruitment records change between passes.
 const experiences=store.list('experiences'),runs=store.list('runs'),dispatched=new Set(runs.map(r=>r.assignmentId));
 const held=new Set(runs.filter(r=>['running','cancelling','uncertain'].includes(r.status)).map(r=>r.assignmentId));
 for(const assignment of store.list('assignments').filter(a=>a.status==='queued'&&a.schedulerKey?.startsWith('formation:office:')&&!held.has(a.id))){
  const decision=retainedOfficeProposal(store,assignment);if(!decision)continue;
  store.update('assignments',assignment.id,{status:'completed',completedAt:new Date().toISOString(),completionEvidence:{decisionId:decision.id,runId:decision.runId,recovered:true,source:'retained-executive-proposal'}});
 }
 const employees=store.list('employees').filter(e=>e.status==='active'),positions=store.list('positions');
 const ceo=employees.find(e=>store.level(e.id)==='ceo');if(!ceo)return;
 const exact=(title:string)=>employees.find(e=>store.level(e.id)==='executive'&&positions.find(p=>p.id===e.positionId)?.title===title);
 for(const [title,coverage] of Object.entries(departmentalCoverage)){
  const executive=exact(title);
  if(!executive){
   const proposals=store.list('decisions').filter(d=>d.kind==='executive.appoint'&&store.get('positions',d.payload?.positionId)?.title===title);
   if(proposals.some(d=>d.status==='pending'))continue;
   // Audited rejection correction owns the candidate; withdrawal does not retire required coverage.
   const vacancy=store.list('appointments').filter(a=>a.endedAt&&positions.find(p=>p.id===a.positionId)?.title===title).sort((a,b)=>a.endedAt!.localeCompare(b.endedAt!)).at(-1);
   const rejected=proposals.filter(d=>d.status==='rejected'&&(!vacancy||d.createdAt>=vacancy.endedAt!)).at(-1);
   let withdrawal:Decision|undefined;
   if(rejected){
    const correction=store.assignmentBySchedulerKey(`appointment-rejected:${rejected.id}`);
    if(correction?.status!=='completed')continue;
    withdrawal=store.list('decisions').findLast(d=>d.kind==='strategy'&&d.authorId===ceo.id&&d.payload?.disposition==='withdrawn'&&d.payload?.rejectedDecisionId===rejected.id&&Array.isArray(d.payload.reviewedVoteIds)&&(correction.payload?.voteIds??[]).every((id:string)=>d.payload.reviewedVoteIds.includes(id))&&d.runId&&store.get('runs',d.runId)?.assignmentId===correction.id);
    if(!withdrawal)continue;
   }
   enqueueCompanyWork(store,ceo,`formation:office:${title}${vacancy?`:vacancy:${vacancy.id}`:''}${withdrawal?`:withdrawn:${withdrawal.id}`:''}`,`Propose ${title}`,`${withdrawal?`Candidate withdrawal ${withdrawal.id} resolved the prior staffing proposal, but ${title} coverage remains unfilled. Read its rationale and the rejected proposal before choosing a materially different candidate or remit. Do not retry the withdrawn candidate unchanged. Keep genuine obstacles and their accountable continuation explicit through responsibility.update; never describe absent coverage as staffed. `:''}The Owner authorized the foundational expansion and this executive office with departmental coverage ${JSON.stringify(coverage)}. Inspect existing employees/positions; retain and reuse suitable identities. Create the executive position only if absent. Write a tailored candidate remit and propose decision.create kind executive.appoint with its exact positionId and either existing employeeId or a new name, actual local modelId, and your own role text. Use company_command with command {type:"decision.create",kind:"executive.appoint",subject,rationale,payload:{positionId,employeeId}} for an existing identity, or payload:{positionId,name,modelId,role} for a new candidate. Put appointment fields inside payload. Elders independently decide. Do not appoint directly or ask Owner for routine permission. Avoid duplicating a pending proposal. Read any rejected proposal and all finalized Elder judgments; revise the candidate or remit to address their substance without overriding their votes. This task ends after the proposal is recorded.`,65);
   continue;
  }
  for(const name of coverage){
   if(!departmentReady(store,name))enqueueCompanyWork(store,executive,`formation:department:${name}`,`Establish ${name}`,`Establish the ${name} department within your executive remit. Inspect existing departments to avoid duplicates. Reuse an existing partial department and its positions; create only missing records. Use department.create when absent then department.update to write its charter, helpPolicy, relatedDepartmentIds when known, and one or two standingDuties {name,instructions,intervalHours}. Author these for actual OpenCorp needs: local AI employees, the portfolio and useful internal software, $0 new spending. Create one lead position and two distinct specialist positions with position.create, tailored responsibilities and this departmentId. Do not bulk-hire generic employees. Recruitment will source tailored candidates after positions exist. You remain accountable manager until a lead is appointed.`,55);
  }
 }
 coalesceFreshDepartments(store,dispatched);
 const people=exact('Chief People Officer');
 const recruitment=store.list('departments').find(d=>d.name==='Recruitment & Workforce Planning'&&d.status!=='retired');
 const recruiter=recruitmentOfficer(store);
 if(people&&recruitment&&!recruiter){
  enqueueCompanyWork(store,people,'formation:recruiter-bootstrap','Bootstrap the Recruitment Officer',`As authorized home manager bootstrap the first persistent Recruitment Officer in department ${recruitment.id}; this resolves recruitment's circular dependency. Discover source agency via skill_discover query recruitment, import the relevant role with skill_import and inspect all pages; also discover skills and inspect the find-skills competency. Adapt human salary/interview/platform instructions into local AI candidate profiling and useful onboarding. Use company_command with command.type position.create, title exactly Recruitment Officer, level worker or support, departmentId ${recruitment.id} and tailored responsibilities unless that departmental position already exists. Then company_command employee.hire with that positionId, homeManagerId ${people.id}, your locally authored name and tailored role, permitted local modelId and source references in source. State that it only provisions manager-approved requisitions; executives still require Elder votes. Do not hire the entire company yourself.`,70);
 }
 for(const employee of employees.filter(e=>e.requisitionId&&['pending','accepted'].includes(e.onboarding?.status))){
  const prior=store.assignmentBySchedulerKey(`formation:onboard:${employee.id}`);
  const manager=store.get('employees',prior?.employeeId??employee.homeManagerId!);if(!manager||manager.status!=='active'||onboardingReady(store,employee,manager.id))continue;
  enqueueCompanyWork(store,manager,`formation:onboard:${employee.id}`,`Accept and activate ${employee.name}`,`Inspect employee ${employee.id}, its candidate and onboarding instructions. Assign useful first work with assignment.create or explicitly record a standbyCondition, then recruitment.onboard {employeeId:"${employee.id}",rationale:your actual acceptance,standbyCondition:if applicable}. If this is a departmental lead, use department.update managerId ${employee.id} to transfer departmental responsibility, then employee.reassign to move this department's specialists who report directly to you under the new lead. Preserve their identities, existing project supervisors and assignments; do not move staff outside your authority. Standing remit work will activate the department. No fictional completed work or customers.`,60);
 }
 if(recruiter)for(const department of store.list('departments').filter(d=>d.status!=='retired'&&d.charter)){
  const manager=store.get('employees',department.managerId);if(!manager||manager.status!=='active')continue;
  const vacancies=positions.filter(p=>p.departmentId===department.id&&p.status==='active'&&!['ceo','executive','elder'].includes(p.level)&&!employees.some(e=>e.positionId===p.id));
  for(const position of vacancies){
   if(experiences.some(r=>r.kind==='requisition'&&r.positionId===position.id&&r.status!=='cancelled'&&r.departmentManagerId===department.managerId))continue;
   enqueueCompanyWork(store,manager,`formation:request:${position.id}:${department.managerId}`,`Authorize recruitment: ${position.title}`,`Position ${position.id}, ${position.title}, is vacant in ${department.name}. Read its responsibilities and the department charter. Use company_read employees and positions to inspect active Recruitment worker/support staff, their current roles and assigned work. Choose a suitable Recruitment Officer or assistant based on remit and capacity; Recruitment Officer ${recruiter.id} is the fallback when no suitable assistant is available. Author recruitment.request with positionId ${position.id}, homeManagerId ${manager.id}, your chosen recruiterId, a specific brief and useful firstWork or honest standby condition. This scopes Recruitment's authority; you will approve its candidate. Do not hire an unadapted generic profile.`,56);
  }
 }
 const requisitions=experiences.filter(r=>r.kind==='requisition');
 const currentRequests=requisitions.filter(r=>{if(r.status!=='open')return false;try{currentRequisition(store,r);return true;}catch(error){if(error instanceof DomainError)return false;throw error;}});
 for(const req of currentRequests){
  const candidate=experiences.find(r=>r.kind==='candidate'&&r.requisitionId===req.id);
  const assigned=store.get('employees',req.recruiterId),manager=store.get('employees',req.homeManagerId);if(!assigned||!manager)continue;
  const version=candidate?.version??0;
  if((!candidate||candidate.status==='changes_requested')&&store.list('assignments').some(a=>a.schedulerKey?.startsWith('formation:candidate:')&&candidateMembers(a).includes(req.id)&&(a.payload?.candidateRequisitionIds?version===0:a.schedulerKey===`formation:candidate:${req.id}:${version}`)))continue;
  const members=!candidate?currentRequests.filter(other=>other.status==='open'&&other.recruiterId===req.recruiterId&&other.homeManagerId===req.homeManagerId&&other.departmentId===req.departmentId&&other.departmentManagerId===req.departmentManagerId&&!experiences.some(c=>c.kind==='candidate'&&c.requisitionId===other.id)&&!store.list('assignments').some(a=>a.schedulerKey?.startsWith('formation:candidate:')&&candidateMembers(a).includes(other.id))).slice(0,3).map(r=>r.id):[req.id];
  if(!candidate||candidate.status==='changes_requested')enqueueCompanyWork(store,assigned,`formation:candidate:${req.id}:${candidate?.version??0}`,`Source candidate: ${positions.find(p=>p.id===req.positionId)?.title}`,`Read requisition ${req.id} in experiences and position ${req.positionId}. Use skill_discover agency with relevant search terms to select a suitable specialist role seed; skill_import its exact path. Also use skill_discover with source skills and an explicit query for a competency relevant to this position; a queryless generic find-skills result is not a substitute for the position's actual capability. Import an appropriate competency from skills.sh discovery. Use skill_read to inspect every page of each selected imported source in this run, including sources already imported. Write your own tailored employee name, role, competencies, adaptation notes and onboarding for this remit; remove human salary, quotas, external authority and irrelevant procedures. Use recruitment.candidate with requisitionId ${req.id}, name, role, permitted modelId, competencies, sourceIds, adaptation, onboarding. Both discovery sources must inform the company; choose narrow pertinent references for this employee, never the whole catalog. Persist the candidate; the home manager approves.${members.length>1?` This fixed batch contains requisitions ${JSON.stringify(members)}. Read each exact brief. Author each candidate separately; reuse only relevant sources fully inspected in this run. Retained same-task candidates need no repeat. End only after every member has its own candidate receipt or actual management supersession. Do not add vacancies to the batch.`:''}`,57,members.length>1?{candidateRequisitionIds:members}:{});
  else if(candidate.status==='proposed')enqueueCompanyWork(store,manager,`formation:approve:${candidate.id}:${candidate.version??1}`,`Review candidate: ${candidate.name}`,`Inspect locally authored candidate ${candidate.id} in experiences, requisition ${req.id}, source provenance and role relevance. If appropriate use recruitment.approve {candidateId:"${candidate.id}",rationale:your judgment}. If unsuitable use recruitment.reject with candidateId and the exact correction rationale; Recruitment will revise while preserving evidence. You own hiring judgment, never approve blindly.`,58);
  else if(candidate.status==='approved')enqueueCompanyWork(store,assigned,`formation:provision:${candidate.id}`,`Onboard ${candidate.name}`,`Provision manager-approved candidate ${candidate.id} with recruitment.provision. This is scoped audited hiring, not an executive appointment. Retain the receipt and notify home manager ${req.homeManagerId} of the employee's tailored onboarding and firstWork from requisition ${req.id}. Do not claim the manager accepted onboarding.`,59);
 }
 coalesceFreshCandidates(store,experiences,dispatched);
}

export function reconcileStandingDuties(store:CompanyStore,now=Date.now()){
 if(!store.company.expansion||store.company.state!=='running')return;
 // Each duty has a distinct department/index key; newly queued work cannot be another duty's prior.
 const assignments=store.list('assignments');
 for(const department of store.list('departments').filter(d=>d.status!=='retired'&&d.standingDuties?.length)){
  const manager=store.get('employees',department.managerId);if(!manager||manager.status!=='active')continue;
  for(const [index,duty] of department.standingDuties.entries()){
   const key=`duty:${department.id}:${index}`,prior=assignments.filter(a=>a.schedulerKey?.startsWith(`${key}:`)).at(-1);
   if(prior&&(!['completed','cancelled'].includes(prior.status)||now-Date.parse(prior.updatedAt)<duty.intervalHours*3600000))continue;
   enqueueCompanyWork(store,manager,`${key}:${prior?.id??'first'}`,`${department.name}: ${duty.name}`,`Standing departmental responsibility: ${duty.instructions}. Inspect current needs, choose useful work or record a precise standby condition. Delegate real finite assignments to qualified staff; coordinate related departments. Do not invent demand or produce reports solely to appear busy. You retain responsibility through obstacles.`,12);
  }
 }
}
