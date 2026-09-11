import { DomainError, type CorporateCommand } from '../core/types.js';

// Required fields come from existing CompanyStore validators. Defaults and
// conditional requirements (for example retry rationale) remain in the domain.
export const commandFields:Record<string,{required:string[];optional:string[]}>= {
 'product.assess':{required:['productId','assessment','rationale'],optional:['priority','status','roadmap']},
 'product.goal':{required:['productId','goals','rationale'],optional:['roadmap','priority']},
 'department.create':{required:['name','responsibilities'],optional:['managerId']},
 'position.create':{required:['title','level','responsibilities'],optional:['departmentId']},
 'employee.hire':{required:['name','positionId','modelId'],optional:['homeManagerId','role','source','acting']},
 'employee.appoint':{required:['employeeId','positionId'],optional:['homeManagerId','acting']},
 'employee.reassign':{required:['employeeId','homeManagerId'],optional:['departmentId']},
 'employee.model':{required:['employeeId','modelId','rationale'],optional:[]},
 'employee.dismiss':{required:['employeeId','rationale'],optional:[]},
 'project.create':{required:['name','outcome','acceptance','rationale'],optional:['productId','supervisorId','priority']},
 'project.update':{required:['projectId','rationale'],optional:['outcome','priority','status','acceptance','supervisorId','completionEvidence']},
 'assignment.create':{required:['employeeId','title','instructions','acceptance'],optional:['projectId','supervisorId','kind','priority','dependencies','payload','completionRequirements','rationale']},
 'assignment.accept':{required:['assignmentId'],optional:['accept','rationale']},
 'assignment.update':{required:['assignmentId'],optional:['employeeId','supervisorId','instructions','priority','availableAt','blockedReason','status','dependencies','completionRequirements','completionEvidence','rationale']},
 'decision.create':{required:['kind','subject','rationale'],optional:['payload']},
 'decision.vote':{required:['decisionId','approve','rationale'],optional:[]},
 'message.send':{required:['content'],optional:['recipientId','projectId']},
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
 productId:text('Registered product ID, not project ID.'),projectId:text('Project ID; omit for company work where supported.'),
 employeeId:text('Employee being assigned or changed; required for employee.model.'),modelId:text('Installed local model ID from company_read models; required for employee.model.'),
 rationale:text('Evidence-based reason; required for employee.model and decisions, and for retries/diagnoses.'),
 assessment:text('Current observed product assessment.'),goals:{type:'array',minItems:1,items:{anyOf:[{type:'string'},{type:'object',properties:{outcome:text('Intended product result.'),measure:text('Observable success evidence.')},additionalProperties:true}]},description:'Concrete product success measures as text or outcome/measure objects.'},
 roadmap:{...strings,description:'Concise textual descriptions of leadership-selected subsequent product work; retained backend extensions remain accepted.'},priority:{type:'number',description:'Larger numbers dispatch first.'},
 status:text('project.update: active, parked, blocked, completed, cancelled. assignment.update: queued, blocked, cancelled, or completed with exact reviewed completionEvidence; omit when declaring requirements. product.assess retains supplied status.'),
 name:text('Department, project, or new employee name.'),managerId:text('Department manager; defaults to the caller.'),
 title:text('Position or assignment title.'),responsibilities:text('Department or position responsibilities.'),
 level:{type:'string',enum:['executive','lead','manager','worker','support']},departmentId:text('Department ID for a position or employee reassignment.'),
 positionId:text('Position ID for hiring or ordinary appointment.'),homeManagerId:text('Responsible home manager ID; hiring defaults to caller.'),
 role:text('Employee role text; hiring defaults to position responsibilities.'),acting:{type:'boolean'},source:text('Underlying source or correction evidence reference.'),
 outcome:text('Finite project outcome.'),acceptance:{...strings,minItems:1,description:'Nonempty concrete acceptance conditions; original assignment acceptance is retained on updates.'},
 supervisorId:text('Responsible project/assignment supervisor; organizational authority still applies.'),
 completionRequirements:{type:'array',items:{type:'object',properties:{criterion:text('Exact unchanged original assignment acceptance text.'),source:{type:'string',enum:['artifact','delivery','release']},authorship:{type:'string',enum:['external'],description:'Only when the criterion requires retained external PR authorship; omit otherwise.'},version:text('Required exact version for release; omit for artifact/delivery.')},required:['criterion','source']},description:'Supervising management declares every implementation criterion once with rationale. No evidence kind is inferred; declarations cannot be changed by a reviewer or downgraded.'},
 completionEvidence:{type:'array',items:{type:'object',properties:{criterion:text('Exact original assignment or current project acceptance text.'),rationale:text('Evidence-based explanation.'),sources:{type:'array',minItems:1,items:{type:'object',properties:{type:{type:'string',enum:['artifact','delivery','release']},id:text('Retained artifact or published release-package ID.')},required:['type','id']}}},required:['criterion','rationale','sources']},description:'Every completed criterion needs actual retained sources with independent coverage; assignments additionally enforce immutable completionRequirements.'},
 instructions:text('Actual assignment work to perform.'),kind:text('assignment.create: implementation, management, assessment, review, governance, conversation. decision.create: strategy or executive.appoint/replace/review/dismiss; use payload for details.'),
 dependencies:{...strings,description:'Actual completion prerequisites, not provenance. On assignment.update supply the full replacement array and rationale; only queued/blocked/needs_changes work may change. Use [] when no prerequisites remain.'},payload,
 assignmentId:text('Existing assignment to update or accept.'),accept:{type:'boolean',description:'Home-management staffing acceptance; declining requires rationale.'},
 availableAt:text('Assignment eligibility time as an ISO timestamp.'),blockedReason:text('Precise observed impediment; does not replace acceptance.'),
 subject:text('Decision subject.'),decisionId:text('Exact decision for the independent vote.'),approve:{type:'boolean',description:'Explicit independent vote; false is dissent.'},
 recipientId:text('Message recipient; defaults to active CEO.'),content:text('Actual message, role text, or Markdown knowledge body.'),
 summary:text('Observed experience summary.'),learned:text('Source-linked lesson.'),environment:text('Observed execution environment.'),
 scope:{type:'string',enum:['company','products','departments','projects','employees']},scopeId:text('ID belonging to the selected knowledge scope.'),
 path:text('Optional Markdown path within the knowledge vault.'),supersedes:text('Prior retained knowledge ID corrected by this note.'),
};
export const commandSchema={type:'object',anyOf:Object.entries(commandFields).map(([type,fields])=>({
 type:'object',properties:{type:{type:'string',enum:[type]},...Object.fromEntries([...fields.required,...fields.optional].map(key=>[key,key==='payload'&&type==='assignment.create'?assignmentPayload:commandProperties[key]]))},
 required:['type',...fields.required],additionalProperties:true,
})),description:'Choose the branch matching command.type and supply its required fields directly beside type. Only decision details and assignment metadata belong in payload. Defaults, authority and state-dependent rules remain enforced by the backend.'};

export function validateCommandFields(command:CorporateCommand):void {
 const fields=commandFields[command.type];if(!fields)return;
 const missing=fields.required.filter(key=>command[key]===undefined||command[key]===null||typeof command[key]==='string'&&!command[key].trim());
 if(missing.length)throw new DomainError('missing_command_fields',`${command.type} is missing required direct fields: ${missing.join(', ')}. Put these fields inside command beside type, not inside command.payload. Required shape: command {type:"${command.type}", ${fields.required.join(', ')}}. Read company_help for ${command.type} syntax. No command was applied.`);
}
