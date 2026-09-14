import { DomainError, type CorporateCommand } from '../core/types.js';

// Required fields come from existing CompanyStore validators. Defaults and
// conditional requirements (for example retry rationale) remain in the domain.
export const commandFields:Record<string,{required:string[];optional:string[]}>= {
 'owner.request':{required:['title','detail','requiredAction','recommendation'],optional:['assignmentId','nextCheckAt']},
 'responsibility.update':{required:['assignmentId','kind','action'],optional:['ownerId','nextCheckAt','followupAssignmentId','attentionId']},
 'review.respond':{required:['decisionId','rationale','kind'],optional:['followupAssignmentId']},
 'workplace.channel.create':{required:['name'],optional:['departmentId']},
 'workplace.event.create':{required:['channelId','title','purpose','participantIds','scheduledAt'],optional:['eventType','subjectEmployeeId','recurrence','durationMinutes','maxTurnsPerParticipant']},
 'workplace.event.update':{required:['eventId','status'],optional:['scheduledAt']},
 'workplace.message.send':{required:['channelId','content'],optional:['eventId']},
 'department.update':{required:['departmentId','rationale'],optional:['name','responsibilities','charter','helpPolicy','managerId','standingDuties','relatedDepartmentIds']},
 'department.merge':{required:['departmentId','targetDepartmentId','rationale'],optional:[]},
 'position.update':{required:['positionId','rationale'],optional:['title','responsibilities','status','level']},
 'recruitment.request':{required:['positionId','homeManagerId','recruiterId','brief','firstWork'],optional:[]},
 'recruitment.candidate':{required:['requisitionId','name','role','modelId','competencies','sourceIds','adaptation','onboarding'],optional:[]},
 'recruitment.reject':{required:['candidateId','rationale'],optional:[]},
 'recruitment.approve':{required:['candidateId','rationale'],optional:[]},
 'recruitment.provision':{required:['candidateId'],optional:[]},
 'recruitment.onboard':{required:['employeeId','rationale'],optional:['standbyCondition']},
 'product.register_internal':{required:['name','verificationCommand','rationale'],optional:[]},
 'product.assess':{required:['productId','assessment','rationale'],optional:['priority','status','roadmap']},
 'product.goal':{required:['productId','goals','rationale'],optional:['roadmap','priority']},
 'department.create':{required:['name','responsibilities'],optional:['managerId']},
 'position.create':{required:['title','level','responsibilities'],optional:['departmentId']},
 'employee.hire':{required:['name','positionId','modelId'],optional:['homeManagerId','role','source','acting']},
 'employee.appoint':{required:['employeeId','positionId'],optional:['homeManagerId','acting']},
 'employee.reassign':{required:['employeeId','homeManagerId'],optional:['departmentId']},
 'employee.model':{required:['employeeId','modelId','rationale'],optional:['fallbackModelIds']},
 'employee.dismiss':{required:['employeeId','rationale'],optional:[]},
 'project.create':{required:['name','outcome','acceptance','rationale'],optional:['productId','supervisorId','priority']},
 'project.update':{required:['projectId','rationale'],optional:['outcome','priority','status','acceptance','supervisorId','completionEvidence']},
 'assignment.create':{required:['employeeId','title','instructions','acceptance'],optional:['projectId','supervisorId','kind','priority','dependencies','dataClass','payload','completionRequirements','completionSource','rationale']},
 'assignment.accept':{required:['assignmentId'],optional:['accept','rationale']},
 'assignment.update':{required:['assignmentId'],optional:['paused','guidance','employeeId','supervisorId','instructions','priority','availableAt','blockedReason','status','dependencies','completionRequirements','completionEvidence','rationale']},
 'decision.create':{required:['kind','subject','rationale'],optional:['payload']},
 'decision.vote':{required:['decisionId','approve','rationale'],optional:[]},
 'message.send':{required:['content'],optional:['recipientId','projectId','wake','channel']},
 'role.update':{required:['employeeId','content','source','rationale'],optional:[]},
 'experience.record':{required:['summary','source','learned'],optional:['employeeId','modelId','environment']},
 'knowledge.write':{required:['content','source'],optional:['scope','scopeId','title','path','supersedes']},
};
export const employeeCommands=Object.keys(commandFields);
const text=(description:string)=>({type:'string',description});
const strings={type:'array',items:{type:'string'}};
const payload={type:'object',description:'Decision-specific details; arbitrary strategy/evidence extensions remain accepted. This is not a wrapper for direct command fields.',properties:{
 positionId:text('executive.appoint/replace: target executive position ID.'),
 employeeId:text('Existing candidate ID for executive.appoint/replace; executive.review/dismiss target ID. Omission selects a new candidate, never a same-name identity.'),
 name:text('New executive candidate name; required with modelId when employeeId is omitted.'),
 modelId:text('Installed local model ID for a new candidate; optional reassignment for an existing candidate.'),
 role:text('New executive responsibilities.'),acting:{type:'boolean'},source:text('Appointment role source.'),
 rejectedDecisionId:text('Exact rejected appointment being corrected.'),reviewedVoteIds:{...strings,description:'Retained finalized vote IDs considered in an appointment correction.'},
 failedRunId:text('Exact failed run for a linked strategy diagnosis.'),failedAssignmentId:text('Exact original blocked assignment.'),
 disposition:text('Strategy disposition, for example blocked or withdrawn.'),remainingPrerequisite:text('Exact unmet prerequisite supported by the diagnosis.'),
},additionalProperties:true};
export const assignmentPayload={type:'object',description:'Assignment-specific metadata; arbitrary source/evidence extensions remain accepted. This is not a wrapper for direct command fields.',properties:{
 artifactId:text('Review assignment: exact retained artifact ID.'),
 decisionId:text('Governance assignment: exact decision ID for the independent judgment.'),
 sourceAssignmentId:text('Preserved assignment referenced by new subset work.'),
 pullRequest:{type:'object',description:'Explicit finite implementation assignment to import and verify this existing product PR; source authorship stays external.',properties:{number:{type:'integer',minimum:1},headSha:text('Exact headSha observed with repo_pr; moved heads require a newly selected assignment.')},required:['number','headSha'],additionalProperties:false},
},additionalProperties:true};
export const commandProperties:Record<string,any>={
 type:{type:'string',enum:employeeCommands},
 detail:text('Observed prerequisite or obstacle.'),requiredAction:text('Smallest indispensable Owner input.'),recommendation:text('Management recommendation.'),nextCheckAt:text('Future ISO date within 30 days.'),ownerId:text('Accountable employee ID.'),action:text('Concrete next action retaining responsibility.'),followupAssignmentId:text('Actual next assignment ID.'),attentionId:text('Open Owner request ID.'),
 channelId:text('Persistent workplace channel ID.'),eventId:text('Persistent workplace event ID.'),purpose:text('Internal event purpose; demonstration gatherings must be labeled.'),participantIds:strings,scheduledAt:text('ISO event schedule'),eventType:{type:'string',enum:['welcome','formation_anniversary','fictional_birthday','office_party','gathering']},subjectEmployeeId:text('Employee celebrated; persona birthdays are fictional.'),recurrence:{type:'string',enum:['none','annual','weekly']},durationMinutes:{type:'integer',minimum:1,maximum:60},maxTurnsPerParticipant:{type:'integer',minimum:1,maximum:2},
 charter:text('Department purpose and scope.'),helpPolicy:text('When and where to seek help.'),
 standingDuties:{type:'array',items:{type:'object',properties:{name:text('Duty name'),instructions:text('Standing remit work'),intervalHours:{type:'number'}},required:['name','instructions']}},relatedDepartmentIds:strings,targetDepartmentId:text('Receiving department ID; history and obligations are preserved.'),
 recruiterId:text('Persistent Recruitment employee authorized for this specific position.'),brief:text('Manager staffing brief.'),firstWork:text('Real first work or explicit standby condition.'),
 requisitionId:text('Manager-authorized staffing requisition ID in experiences.'),candidateId:text('Locally authored candidate ID in experiences.'),competencies:{...strings,minItems:1,maxItems:6,description:'One to six specific competencies adapted to this role.'},sourceIds:{...strings,description:'Imported skill-source IDs in experiences, selected and inspected for this role.'},adaptation:text('How source instructions were adapted to local AI work and OpenCorp authority.'),onboarding:text('Useful onboarding instructions.'),standbyCondition:text('Explicit condition activating useful work.'),verificationCommand:text('Dependency-free Node verifier, e.g. node --test.'),
 productId:text('Registered product ID, not project ID.'),projectId:text('Project ID; omit for company work where supported.'),
 fallbackModelIds:{...strings,description:'Suitable permitted alternatives for this employee work, in preferred order. Omit or [] clears alternatives; does not grant model or data permissions.'},
 dataClass:{type:'string',enum:['public','internal','confidential'],description:'Confidential work stays local and child assignments inherit that restriction. Default internal.'},
 employeeId:text('Employee being assigned or changed; required for employee.model.'),modelId:text('Eligible local or permitted free model ID from company_read models; required for employee.model.'),
 rationale:text('Evidence-based reason; required for employee.model and decisions, and for retries/diagnoses.'),
 assessment:text('Current observed product assessment.'),goals:{type:'array',minItems:1,items:{anyOf:[{type:'string'},{type:'object',properties:{outcome:text('Intended product result.'),measure:text('Observable success evidence.')},additionalProperties:true}]},description:'Concrete product success measures as text or outcome/measure objects.'},
 roadmap:{...strings,description:'Concise textual descriptions of leadership-selected subsequent product work; retained backend extensions remain accepted.'},priority:{type:'number',description:'Larger numbers dispatch first.'},
 status:text('project.update: active, parked, blocked, completed, cancelled. assignment.update: queued, blocked, cancelled, or completed with exact reviewed completionEvidence; omit when declaring requirements. product.assess retains supplied status.'),
 name:text('Department, project, or new employee name.'),managerId:text('Department manager; defaults to the caller.'),
 title:text('Position or assignment title.'),responsibilities:text('Department or position responsibilities.'),
 level:{type:'string',enum:['executive','lead','manager','worker','support']},departmentId:text('Department ID for a position or employee reassignment.'),
 positionId:text('Position ID for hiring or ordinary appointment.'),homeManagerId:text('Responsible home manager ID; hiring defaults to caller.'),
 role:text('Persistent employee operating instructions: purpose, duties, coordination and authority limits. The position title is supplied separately.'),acting:{type:'boolean'},source:text('Underlying source or correction evidence reference.'),
 outcome:text('Finite project outcome.'),acceptance:{...strings,minItems:1,description:'Nonempty concrete acceptance conditions; original assignment acceptance is retained on updates.'},
 supervisorId:text('Responsible project/assignment supervisor; organizational authority still applies.'),
 completionSource:{type:'string',enum:['artifact','delivery'],description:'Manager declares one source kind for all original implementation criteria without repeating each criterion. Use full completionRequirements for mixed outcomes.'},
 completionRequirements:{type:'array',items:{type:'object',properties:{criterion:text('Exact unchanged original assignment acceptance text.'),source:{type:'string',enum:['artifact','delivery','release']},authorship:{type:'string',enum:['external'],description:'Only when the criterion requires retained external PR authorship; omit otherwise.'},version:text('Required exact version for release; omit for artifact/delivery.')},required:['criterion','source']},description:'Supervising management declares every implementation criterion once with rationale. No evidence kind is inferred; declarations cannot be changed by a reviewer or downgraded.'},
 completionEvidence:{type:'array',items:{type:'object',properties:{criterion:text('Exact original assignment or current project acceptance text.'),rationale:text('Evidence-based explanation.'),sources:{type:'array',minItems:1,items:{type:'object',properties:{type:{type:'string',enum:['artifact','delivery','release']},id:text('Retained artifact or published release-package ID.')},required:['type','id']}}},required:['criterion','rationale','sources']},description:'Every completed criterion needs actual retained sources with independent coverage; assignments additionally enforce immutable completionRequirements.'},
 paused:{type:'boolean',description:'Hold this assignment across restart, or release its hold after runtime/effect reconciliation. Requires rationale.'},guidance:text('Add guidance for the next attempt, preserving the existing instructions and acceptance. Requires rationale.'),
 instructions:text('Actual assignment work to perform.'),kind:text('assignment.create: implementation, management, assessment, review, governance, conversation. decision.create: strategy or executive.appoint/replace/review/dismiss; use payload for details.'),
 dependencies:{...strings,description:'Actual completion prerequisites, not provenance. On assignment.update supply the full replacement array and rationale; only queued/blocked/needs_changes work may change. Use [] when no prerequisites remain.'},payload,
 assignmentId:text('Existing assignment to update or accept.'),accept:{type:'boolean',description:'Home-management staffing acceptance; declining requires rationale.'},
 availableAt:text('Assignment eligibility time as an ISO timestamp.'),blockedReason:text('Precise observed impediment; does not replace acceptance.'),
 subject:text('Decision subject.'),decisionId:text('Exact decision for the independent vote.'),approve:{type:'boolean',description:'Explicit independent vote; false is dissent.'},
 wake:{type:'boolean',description:'Wake recipient for action by default; false records an informational message only.'},
 channel:{type:'string',enum:['email'],description:'Send an Owner report or proposal through configured email; omit for ordinary conversation.'},
 recipientId:text('Message recipient; defaults to active CEO.'),content:text('Actual message, role text, or Markdown knowledge body.'),
 summary:text('Observed experience summary.'),learned:text('Source-linked lesson.'),environment:text('Observed execution environment.'),
 scope:{type:'string',enum:['company','products','departments','projects','employees']},scopeId:text('ID belonging to the selected knowledge scope.'),
 path:text('Optional Markdown path within the knowledge vault.'),supersedes:text('Prior retained knowledge ID corrected by this note.'),
};
export const commandSchema={type:'object',anyOf:Object.entries(commandFields).map(([type,fields])=>({
 type:'object',properties:{type:{type:'string',enum:[type]},...Object.fromEntries([...fields.required,...fields.optional].map(key=>[key,key==='payload'&&type==='assignment.create'?assignmentPayload:key==='kind'&&type==='responsibility.update'?{type:'string',enum:['changed_approach','specialist_help','reassignment','prerequisite_work','scheduled_recheck','owner_decision'],description:'Continuation kind for the original obligation; not an assignment kind.'}:key==='level'&&type==='position.update'?{type:'string',enum:['lead','manager','worker','support'],description:'Correct an active unfilled departmental position only; occupied and executive offices are protected.'}:commandProperties[key]]))},
 required:['type',...fields.required],additionalProperties:true,
})),description:'Choose the branch matching command.type and supply its required fields directly beside type. Only decision details and assignment metadata belong in payload. Defaults, authority and state-dependent rules remain enforced by the backend.'};

export function validateCommandFields(command:CorporateCommand):void {
 const fields=commandFields[command.type];if(!fields)return;
 const missing=fields.required.filter(key=>command[key]===undefined||command[key]===null||typeof command[key]==='string'&&!command[key].trim());
 if(missing.length)throw new DomainError('missing_command_fields',`${command.type} is missing required direct fields: ${missing.join(', ')}. Put these fields inside command beside type, not inside command.payload. Required shape: command {type:"${command.type}", ${fields.required.join(', ')}}. Read company_help for ${command.type} syntax.${command.type==='assignment.create'?' Prefer create_assignment with direct employeeId, title, instructions, acceptance and kind arguments; no command wrapper.':command.type==='recruitment.onboard'?' Prefer accept_onboarding with direct employeeId and rationale; standbyCondition is only a genuine waiting condition, not acceptance rationale.':''} No command was applied.`);
}
