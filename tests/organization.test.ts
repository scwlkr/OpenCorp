import { createHash } from 'node:crypto';
import { formationDispatchAllowed, formationOutcome, reconcileFormation } from '../src/core/formation.js';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CompanyStore } from '../src/storage/store.js';
import { organizationCommand } from '../src/core/organization.js';
import type { Actor } from '../src/core/types.js';
let root:string,store:CompanyStore,managerId:string,departmentId:string,positionId:string,recruiter:Actor;
const sourceId='a'.repeat(64);
const owner:Actor={kind:'owner'};
beforeEach(()=>{
 root=mkdtempSync(join(tmpdir(),'opencorp-org-'));store=new CompanyStore(root);store.bootstrap();store.update('company',store.company.id,{state:'running'});
 managerId=store.list('employees').find(e=>store.level(e.id)==='ceo')!.id;
 store.put('models',{id:'local-fixture',name:'local-fixture',local:true,available:true,artifactIdentity:'fixture'});
 departmentId=store.command(owner,{type:'department.create',name:'Recruitment',managerId,responsibilities:'Scoped staffing'}).id;
 const rp=store.command(owner,{type:'position.create',title:'Recruitment Officer',level:'worker',departmentId,responsibilities:'Source and adapt skills'});
 const employee=store.command(owner,{type:'employee.hire',name:'Recruiter',positionId:rp.id,homeManagerId:managerId,modelId:'local-fixture',role:'Source skills'});
 const run=store.put('runs',{employeeId:employee.id,status:'running',tokenRevoked:false,policyRevision:store.policy.revision});recruiter={kind:'employee',employeeId:employee.id,runId:run.id,policyRevision:store.policy.revision};
 positionId=store.command(owner,{type:'position.create',title:'Tool specialist',level:'worker',departmentId,responsibilities:'Useful local tools'}).id;
});
afterEach(()=>{store.close();rmSync(root,{recursive:true,force:true});});
function request(){return store.command(owner,{type:'recruitment.request',positionId,homeManagerId:managerId,recruiterId:(recruiter as any).employeeId,brief:'Build useful tools',firstWork:'Implement requested helper'});}
function candidate(requisitionId:string){return store.command(recruiter,{type:'recruitment.candidate',requisitionId,name:'Tool maker',role:'Adapted tool implementation role',modelId:'local-fixture',competencies:['Node tools'],sourceIds:[sourceId],adaptation:'No hosted execution',onboarding:'Inspect helper request'});}
function inspectSource(content='---\nlicense: MIT\n---\nUseful source'){
 const sha256=createHash('sha256').update(content).digest('hex'),license='MIT License\nPermission is hereby granted, free of charge',directory=join(root,'skills','vendor',sourceId);mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'SOURCE.md'),content);writeFileSync(join(directory,'LICENSE'),license);
 store.put('experiences',{id:sourceId,kind:'skill-source',sha256,license:'MIT',sourcePath:join(directory,'SOURCE.md'),licenseHash:createHash('sha256').update(license).digest('hex')});store.update('runs',(recruiter as any).runId,{skillInspections:{[sourceId]:{sha256,complete:true,ranges:[[0,content.length]]}}});
}
test('only attributed recruiter with inspected exact source can propose; manager approval and restart preserve one identity',()=>{
 const req=request();store.put('experiences',{id:sourceId,kind:'skill-source',sha256:'source-sha'});
 expect(()=>candidate(req.id)).toThrow(/every page/);inspectSource();const proposed=candidate(req.id);expect(proposed.authorship.runId).toBe((recruiter as any).runId);
 expect(()=>store.command(recruiter,{type:'recruitment.approve',candidateId:proposed.id,rationale:'Self-approval'})).toThrow(/Responsible home/);
 store.command(owner,{type:'recruitment.approve',candidateId:proposed.id,rationale:'Fits authorized work'});
 const employee=store.command(recruiter,{type:'recruitment.provision',candidateId:proposed.id});expect(employee.role).toBe(proposed.role);expect(employee.roleAuthorship).toEqual(proposed.authorship);
 store.close();store=new CompanyStore(root);const repeated=store.command(recruiter,{type:'recruitment.provision',candidateId:proposed.id});expect(repeated.id).toBe(employee.id);expect(store.list('appointments').filter(a=>a.positionId===positionId)).toHaveLength(1);
});
test('department leadership changes invalidate approved requisition and current management can replace it',()=>{
 inspectSource();const req=request(),proposed=candidate(req.id);store.command(owner,{type:'recruitment.approve',candidateId:proposed.id,rationale:'Fits work'});
 const pos=store.command(owner,{type:'position.create',title:'New Lead',level:'lead',responsibilities:'Lead department'}),lead=store.command(owner,{type:'employee.hire',name:'New lead',positionId:pos.id,homeManagerId:managerId,modelId:'local-fixture',role:'Manage work'});
 store.command(owner,{type:'department.update',departmentId,managerId:lead.id,rationale:'Leadership change'});
 expect(()=>store.command(recruiter,{type:'recruitment.provision',candidateId:proposed.id})).toThrow(/authority changed/);
 const replacement=request();expect(replacement.id).not.toBe(req.id);expect(store.need('experiences',req.id).status).toBe('cancelled');
});
test('retiring a position or revoked recruiter blocks provisioning without creating staff',()=>{
 inspectSource();const req=request(),proposed=candidate(req.id);store.command(owner,{type:'recruitment.approve',candidateId:proposed.id,rationale:'Useful'});
 store.command(owner,{type:'position.update',positionId,status:'retired',rationale:'Work cancelled'});
 expect(()=>store.command(recruiter,{type:'recruitment.provision',candidateId:proposed.id})).toThrow(/authority changed/);
 store.update('runs',(recruiter as any).runId,{tokenRevoked:true});expect(()=>candidate(req.id)).toThrow(/revoked/);expect(store.list('appointments').filter(a=>a.positionId===positionId)).toHaveLength(0);
});

test('candidate changes require renewed source inspection and preserve original employee authorship history',()=>{
 inspectSource();const req=request(),first=candidate(req.id);
 organizationCommand(store,owner,{type:'recruitment.reject',candidateId:first.id,rationale:'Tailor the role to local tools'});
 store.update('runs',(recruiter as any).runId,{skillInspections:{}});expect(()=>candidate(req.id)).toThrow(/every page/);
 inspectSource();const revised=candidate(req.id);expect(revised.id).toBe(first.id);expect(revised.version).toBe(2);expect(revised.history[0].role).toBe(first.role);expect(revised.history[0].authorship).toEqual(first.authorship);expect(revised.history[0].feedback.rationale).toContain('local tools');expect(revised.status).toBe('proposed');
 expect(()=>store.command(recruiter,{type:'recruitment.provision',candidateId:first.id})).toThrow(/approve/);
});

test('onboarding needs actual accepted work or an explicit standby condition',()=>{
 inspectSource();const req=request(),proposed=candidate(req.id);store.command(owner,{type:'recruitment.approve',candidateId:proposed.id,rationale:'Useful scoped role'});
 const employee=store.command(recruiter,{type:'recruitment.provision',candidateId:proposed.id});
 expect(()=>store.command(owner,{type:'recruitment.onboard',employeeId:employee.id,rationale:'Ready'})).toThrow(/first work/);
 expect(store.need('employees',employee.id).onboarding.status).toBe('pending');
 store.command(owner,{type:'recruitment.onboard',employeeId:employee.id,rationale:'Remit understood',standbyCondition:'Await the next actual internal helper request'});
 expect(store.need('employees',employee.id).onboarding).toMatchObject({status:'accepted',standbyCondition:'Await the next actual internal helper request'});
});

test('successive department merges retain all ancestral knowledge scopes',()=>{
 const second=store.command(owner,{type:'department.create',name:'Combined department',managerId,responsibilities:'Combined work'});
 const third=store.command(owner,{type:'department.create',name:'Final department',managerId,responsibilities:'Final work'});
 store.command(owner,{type:'department.merge',departmentId,targetDepartmentId:second.id,rationale:'Combine related scopes'});
 store.command(owner,{type:'department.merge',departmentId:second.id,targetDepartmentId:third.id,rationale:'Consolidate without losing institutional knowledge'});
 expect(store.need('departments',third.id).inheritedDepartmentIds).toEqual([second.id,departmentId]);
 expect(store.need('positions',positionId).departmentId).toBe(third.id);
});

test.each([
 {inspection:undefined,offset:0},
 {inspection:{sha256:'source-sha',complete:false,ranges:[[0,2000]]},offset:2000},
 {inspection:{sha256:'source-sha',complete:false,ranges:[[0,2000],[4000,8000]]},offset:2000},
 {inspection:{sha256:'source-sha',complete:false,ranges:[[4000,8000]]},offset:0},
 {inspection:{sha256:'old-sha',complete:true,ranges:[[0,8000]]},offset:0},
])('incomplete source recovery identifies the exact next skill_read offset $offset',({inspection,offset})=>{
 const req=request();store.put('experiences',{id:sourceId,kind:'skill-source',sha256:'source-sha'});
 if(inspection)store.update('runs',(recruiter as any).runId,{skillInspections:{[sourceId]:inspection}});
 const before=store.need('runs',(recruiter as any).runId).skillInspections;
 expect(()=>candidate(req.id)).toThrow(`Next call: skill_read ${JSON.stringify({sourceId:sourceId,offset})}`);
 expect(store.list('experiences').filter(r=>r.kind==='candidate')).toHaveLength(0);expect(store.need('runs',(recruiter as any).runId).skillInspections).toEqual(before);
 inspectSource();expect(candidate(req.id).status).toBe('proposed');
});

test('source error identifies the first incomplete reference after a fully inspected source',()=>{
 const req=request();inspectSource();store.put('experiences',{id:'second-source',kind:'skill-source',sha256:'second-sha'});
 expect(()=>store.command(recruiter,{type:'recruitment.candidate',requisitionId:req.id,name:'Candidate',role:'Local role',modelId:'local-fixture',competencies:['Useful tools'],sourceIds:[sourceId,'second-source'],adaptation:'Local scope',onboarding:'Inspect work'})).toThrow('Next call: skill_read {"sourceId":"second-source","offset":0}');
 expect(store.list('experiences').filter(r=>r.kind==='candidate')).toHaveLength(0);
});

test('department management repairs unfilled levels in place and preserves existing requisitions',()=>{
 const run=store.put('runs',{employeeId:managerId,status:'running',tokenRevoked:false,policyRevision:store.policy.revision}),managerActor:Actor={kind:'employee',employeeId:managerId,runId:run.id,policyRevision:store.policy.revision};
 const req=request(),before=store.need('positions',positionId),count=store.list('positions').length;
 for(const level of ['lead','manager','support','worker']){
  const updated=store.command(managerActor,{type:'position.update',positionId,level,rationale:'Correct this unfilled staffing level'});expect(updated.id).toBe(positionId);expect(updated.level).toBe(level);expect(updated.departmentId).toBe(departmentId);
 }
 expect(store.list('positions')).toHaveLength(count);expect(store.need('positions',positionId).history[0].level).toBe(before.level);expect(store.need('experiences',req.id)).toEqual(req);
});

test('position level correction rejects occupied, retired and unauthorized changes without mutating identities',()=>{
 const occupiedId=store.need('employees',(recruiter as any).employeeId).positionId,before=store.need('positions',occupiedId),appointments=store.list('appointments');
 expect(()=>store.command(owner,{type:'position.update',positionId:occupiedId,level:'manager',rationale:'Cannot change occupied role'})).toThrow(/occupied position/);expect(store.need('positions',occupiedId)).toEqual(before);expect(store.list('appointments')).toEqual(appointments);
 expect(()=>store.command(recruiter,{type:'position.update',positionId,level:'manager',rationale:'Worker lacks department authority'})).toThrow(/Responsible home management/);
 store.command(owner,{type:'position.update',positionId,status:'retired',rationale:'Retire vacant work'});expect(()=>store.command(owner,{type:'position.update',positionId,level:'worker',rationale:'Cannot revise retired level'})).toThrow(/active unfilled/);
});

test.each(['executive','ceo','elder','invalid','',null,1,{}])('position update rejects invalid or protected target level %j',level=>{
 const before=store.need('positions',positionId);expect(()=>store.command(owner,{type:'position.update',positionId,level,rationale:'Invalid level'})).toThrow(/lead, manager, worker or support/);expect(store.need('positions',positionId)).toEqual(before);
});

test.each(['executive','ceo','elder'] as const)('position update cannot demote an existing %s office',level=>{
 const position=store.put('positions',{title:'Protected office',level,departmentId,status:'active'});
 expect(()=>store.command(owner,{type:'position.update',positionId:position.id,level:'worker',rationale:'Cannot bypass governance'})).toThrow(/governance protection/);expect(store.need('positions',position.id)).toEqual(position);
});

test.each([
 ['manager','lead',false],['manager','manager',false],['lead','lead',false],['executive','lead',true],['executive','worker',true],
] as const)('level repair by %s to %s preserves organizational rank authority',(actorLevel,targetLevel,allowed)=>{
 const actorPosition=store.put('positions',{title:'Department authority fixture',level:actorLevel,status:'active'}),employee=store.put('employees',{name:'Department manager fixture',positionId:actorPosition.id,status:'active',homeManagerId:managerId});
 store.update('departments',departmentId,{managerId:employee.id});store.update('positions',positionId,{level:targetLevel==='worker'?'manager':'worker'});
 const run=store.put('runs',{employeeId:employee.id,status:'running',tokenRevoked:false,policyRevision:store.policy.revision}),actor:Actor={kind:'employee',employeeId:employee.id,runId:run.id,policyRevision:store.policy.revision},before=store.need('positions',positionId);
 const change=()=>store.command(actor,{type:'position.update',positionId,level:targetLevel,rationale:'Correct vacant position within rank authority'});
 if(allowed)expect(change()).toMatchObject({id:positionId,level:targetLevel});else{expect(change).toThrow(/own or higher/);expect(store.need('positions',positionId)).toEqual(before);}
});

 test('real manager reauthorization supersedes only queued trusted staffing tasks and retains all evidence',()=>{
 const req=request();inspectSource();const proposed=candidate(req.id);
 const task=(key:string,patch:any={})=>store.put('assignments',{kind:'management',projectId:null,payload:{formation:true},schedulerKey:key,employeeId:key.includes(':request:')||key.includes(':approve:')?managerId:(recruiter as any).employeeId,status:'queued',...patch});
 const keys=[`formation:request:${positionId}:${managerId}`,`formation:candidate:${req.id}:0`,`formation:approve:${proposed.id}:1`,`formation:provision:${proposed.id}`];
 const obsolete=keys.map(key=>task(key));
 expect(formationDispatchAllowed(store,obsolete[0])).toBe(true);expect(formationDispatchAllowed(store,obsolete[1])).toBe(true);
 const preserved=[task(keys[1],{status:'running'}),task(keys[2],{status:'failed'}),task(keys[1],{payload:{}}),task('formation:candidate:unrelated:0'),task(keys[1],{projectId:'product'})];
 const held=task(keys[1]);store.put('runs',{assignmentId:held.id,status:'uncertain'});preserved.push(held);
 const leadPosition=store.command(owner,{type:'position.create',title:'Recruitment lead',level:'lead',departmentId,responsibilities:'Manage department'});
 const lead=store.command(owner,{type:'employee.hire',positionId:leadPosition.id,name:'New lead',modelId:'local-fixture',homeManagerId:managerId});
 store.command(owner,{type:'department.update',departmentId,managerId:lead.id,rationale:'Transfer to actual lead'});
 for(const t of obsolete)expect(formationDispatchAllowed(store,t)).toBe(false);
 const leadRun=store.put('runs',{employeeId:lead.id,status:'running',tokenRevoked:false,policyRevision:store.policy.revision}),leadActor:Actor={kind:'employee',employeeId:lead.id,runId:leadRun.id,policyRevision:store.policy.revision};
 const replacement=store.command(leadActor,{type:'recruitment.request',positionId,homeManagerId:lead.id,recruiterId:(recruiter as any).employeeId,brief:'Lead authorizes retained vacancy',firstWork:'Implement useful helper'});
 expect(store.need('experiences',req.id)).toMatchObject({status:'cancelled',supersession:{replacementRequisitionId:replacement.id,authorId:lead.id,runId:leadRun.id}});
 for(const t of obsolete)expect(store.need('assignments',t.id)).toMatchObject({status:'cancelled',supersession:{sourceRequisitionId:req.id,replacementRequisitionId:replacement.id,authorId:lead.id}});
 for(const t of preserved)expect(store.need('assignments',t.id)).toEqual(t);
 expect(store.need('experiences',proposed.id)).toEqual(proposed);
 const fresh=task(`formation:candidate:${replacement.id}:0`);expect(formationDispatchAllowed(store,fresh)).toBe(true);
 store.update('experiences',proposed.id,{status:'hired'});expect(formationDispatchAllowed(store,obsolete[3])).toBe(true);
 expect(store.command(leadActor,{type:'recruitment.request',positionId,homeManagerId:lead.id,recruiterId:(recruiter as any).employeeId,brief:'Repeat retained authorization',firstWork:'Same work'}).id).toBe(replacement.id);
 });

 test.each(['candidate','approve'] as const)('filled requisition permits only exact retained %s task summary recovery',phase=>{
 const req=request();inspectSource();const proposed=candidate(req.id);
 const employeeId=phase==='candidate'?(recruiter as any).employeeId:managerId;
 const task=store.put('assignments',{kind:'management',projectId:null,payload:{formation:true},schedulerKey:phase==='candidate'?`formation:candidate:${req.id}:0`:`formation:approve:${proposed.id}:1`,employeeId,status:'queued'});
 const source=store.put('runs',{employeeId,assignmentId:task.id,status:'interrupted'});
 const receipt={runId:source.id,authorId:employeeId},field=phase==='candidate'?'authorship':'approval';
 store.update('experiences',proposed.id,{status:'hired',[field]:receipt});store.update('experiences',req.id,{status:'filled'});
 expect(formationDispatchAllowed(store,task)).toBe(true);
 const unrelated=store.put('assignments',{...task,id:undefined});expect(formationDispatchAllowed(store,unrelated)).toBe(false);
 store.update('experiences',proposed.id,{[field]:{runId:'unrelated'},history:[{version:1,[field]:receipt}]});expect(formationDispatchAllowed(store,task)).toBe(true);
 if(phase==='approve'){store.update('experiences',proposed.id,{history:[{version:1,feedback:receipt}]});expect(formationDispatchAllowed(store,task)).toBe(true);}
 store.update('runs',source.id,{employeeId:'other-employee'});expect(formationDispatchAllowed(store,task)).toBe(false);
 });

test('batch candidates reuse inspected sources but keep individual proposals and surviving members after supersession',()=>{
 const first=request(),secondPosition=store.command(owner,{type:'position.create',title:'Second specialist',level:'worker',departmentId,responsibilities:'Distinct useful work'});
 const second=store.command(owner,{type:'recruitment.request',positionId:secondPosition.id,homeManagerId:managerId,recruiterId:(recruiter as any).employeeId,brief:'Different role',firstWork:'Different useful helper'});
 const task=store.put('assignments',{kind:'management',projectId:null,employeeId:(recruiter as any).employeeId,status:'queued',schedulerKey:`formation:candidate:${first.id}:0`,payload:{formation:true,candidateRequisitionIds:[first.id,second.id]}});
 store.update('runs',(recruiter as any).runId,{assignmentId:task.id});
 expect(()=>candidate(first.id)).toThrow();inspectSource();const firstCandidate=candidate(first.id),secondCandidate=candidate(second.id);
 expect(firstCandidate.id).not.toBe(secondCandidate.id);expect(firstCandidate.status).toBe('proposed');expect(secondCandidate.status).toBe('proposed');
 expect(()=>store.command(recruiter,{type:'recruitment.approve',candidateId:secondCandidate.id,rationale:'Cannot self approve batch'})).toThrow();
 // A single member becomes stale; real manager reauthorization retains the other obligation.
 store.update('experiences',firstCandidate.id,{authorship:{runId:'unrelated-earlier-task'}});expect(formationOutcome(store,task,store.need('runs',(recruiter as any).runId)).passed).toBe(false);
 store.update('experiences',first.id,{departmentManagerId:'previous-manager'});store.update('runs',(recruiter as any).runId,{status:'interrupted'});
 const replacement=store.command(owner,{type:'recruitment.request',positionId,homeManagerId:managerId,recruiterId:(recruiter as any).employeeId,brief:'Reauthorize changed staffing',firstWork:'Useful replacement work'});
 expect(store.need('assignments',task.id).status).toBe('queued');expect(store.need('assignments',task.id).memberSupersessions[first.id].replacementRequisitionId).toBe(replacement.id);
 expect(store.need('experiences',second.id).status).toBe('open');expect(formationDispatchAllowed(store,task)).toBe(true);expect(formationOutcome(store,task,store.need('runs',(recruiter as any).runId)).passed).toBe(true);
});

test('prior inspection and approval cannot authorize a retained restricted source candidate or hire',()=>{
 const req=request();inspectSource();const proposed=candidate(req.id);store.command(owner,{type:'recruitment.approve',candidateId:proposed.id,rationale:'Original source appears suitable'});
 inspectSource('---\nlicense: MIT + Commons Clause\n---\nRestricted retained source');const retained=store.need('experiences',sourceId),receipt=store.need('runs',(recruiter as any).runId).skillInspections,employees=store.list('employees');
 expect(()=>candidate(req.id)).toThrow(/plain MIT/);expect(()=>store.command(recruiter,{type:'recruitment.provision',candidateId:proposed.id})).toThrow(/plain MIT/);
 store.update('experiences',proposed.id,{status:'changes_requested'});expect(()=>candidate(req.id)).toThrow(/plain MIT/);
 expect(store.list('employees')).toEqual(employees);expect(store.need('experiences',sourceId)).toEqual(retained);expect(store.need('runs',(recruiter as any).runId).skillInspections).toEqual(receipt);
});


test.each(['active','dismissed','reassigned'])('manager-selected assistant continues candidate, review and provision with Officer %s',officerState=>{
 store.command(owner,{type:'company.expand',mandate:'Recruit actual tailored staff'});
 store.update('departments',departmentId,{name:'Recruitment & Workforce Planning',charter:'Source tailored staff'});
 const officer=recruiter;
 const assistantPosition=store.command(owner,{type:'position.create',title:'Talent Acquisition Specialist',level:'worker',departmentId,responsibilities:'Source tailored local candidates'});
 const assistant=store.command(owner,{type:'employee.hire',name:'Talent assistant',positionId:assistantPosition.id,homeManagerId:managerId,modelId:'local-fixture',role:'Adapt inspected sources into tailored local candidate roles'});
 const run=store.put('runs',{employeeId:assistant.id,status:'running',tokenRevoked:false,policyRevision:store.policy.revision});
 const managerRun=store.put('runs',{employeeId:managerId,status:'running',tokenRevoked:false,policyRevision:store.policy.revision});
 const manager:Actor={kind:'employee',employeeId:managerId,runId:managerRun.id,policyRevision:store.policy.revision};
 reconcileFormation(store);
 const requestTask=store.list('assignments').find(a=>a.schedulerKey===`formation:request:${positionId}:${managerId}`)!;
 expect(requestTask.instructions).toContain('your chosen recruiterId');
 expect(requestTask.instructions).toContain('current roles and assigned work');
 const command={type:'recruitment.request',positionId,homeManagerId:managerId,recruiterId:assistant.id,brief:'Assistant has relevant sourcing remit and capacity',firstWork:'Implement requested local helper'};
 const req=store.command(manager,command);
 expect(store.command(manager,{...command,recruiterId:(officer as Extract<Actor,{kind:'employee'}>).employeeId})).toEqual(req);
 recruiter={kind:'employee',employeeId:assistant.id,runId:run.id,policyRevision:store.policy.revision};
 inspectSource();
 const officerId=(officer as Extract<Actor,{kind:'employee'}>).employeeId;
 if(officerState==='dismissed')store.update('employees',officerId,{status:'dismissed'});
 if(officerState==='reassigned')store.update('employees',officerId,{departmentId:null});
 const vacancy=store.command(owner,{type:'position.create',title:'Later vacancy',level:'worker',departmentId,responsibilities:'Later authorized work'});
 reconcileFormation(store);
 expect(store.list('assignments').some(a=>a.schedulerKey===`formation:request:${vacancy.id}:${managerId}`)).toBe(officerState==='active');
 expect(store.list('assignments').find(a=>a.schedulerKey===`formation:candidate:${req.id}:0`)?.employeeId).toBe(assistant.id);
 recruiter=officer;expect(()=>candidate(req.id)).toThrow(officerState==='dismissed'?undefined:/Only the assigned Recruitment/);
 recruiter={kind:'employee',employeeId:assistant.id,runId:run.id,policyRevision:store.policy.revision};
 const proposed=candidate(req.id);
 reconcileFormation(store);
 expect(store.list('assignments').find(a=>a.schedulerKey===`formation:approve:${proposed.id}:1`)?.employeeId).toBe(managerId);
 store.command(manager,{type:'recruitment.approve',candidateId:proposed.id,rationale:'Tailored to authorized local work'});
 reconcileFormation(store);
 expect(store.list('assignments').find(a=>a.schedulerKey===`formation:provision:${proposed.id}`)?.employeeId).toBe(assistant.id);
 expect(()=>store.command(officer,{type:'recruitment.provision',candidateId:proposed.id})).toThrow(officerState==='dismissed'?undefined:/Only assigned Recruitment/);
 expect(store.command(recruiter,{type:'recruitment.provision',candidateId:proposed.id}).role).toBe(proposed.role);
 expect(store.need('assignments',requestTask.id).instructions).toBe(requestTask.instructions);
});


test('department creation rejects normalized duplicate names without reassigning or rewriting retained departments',()=>{
 const original=store.need('departments',departmentId),before=store.list('departments');
 for(const name of ['Recruitment',' recruitment ','RECRUITMENT','Ｒｅｃｒｕｉｔｍｅｎｔ']){
  expect(()=>store.command(owner,{type:'department.create',name,managerId,responsibilities:'Different replacement remit'})).toThrow(expect.objectContaining({code:'department_exists',status:409}));
  expect(store.list('departments')).toEqual(before);
 }
 const first=store.command(owner,{type:'department.create',name:'Quality Engineering',managerId,responsibilities:'Original quality remit'});
 expect(()=>store.command(owner,{type:'department.create',name:'quality \t engineering',managerId,responsibilities:'Other quality remit'})).toThrow(expect.objectContaining({code:'department_exists'}));
 expect(()=>store.command(recruiter,{type:'department.create',name:first.name,managerId,responsibilities:'Unauthorized reuse'})).toThrow(expect.objectContaining({code:'forbidden'}));
 expect(store.need('departments',departmentId)).toEqual(original);expect(store.need('departments',first.id)).toEqual(first);
 store.update('departments',first.id,{status:'retired'});
 const replacement=store.command(owner,{type:'department.create',name:first.name,managerId,responsibilities:'New accountable department after retirement'});
 expect(replacement.id).not.toBe(first.id);expect(store.need('departments',first.id)).toMatchObject({status:'retired',responsibilities:first.responsibilities});
});

test('direct Owner foundation hires retain honest authorship and Owner-only onboarding with real first-work or standby',()=>{
 const prior=store.list('roleVersions'),employee=store.command(owner,{type:'employee.hire',positionId,name:'Owner-directed specialist',homeManagerId:managerId,modelId:'local-fixture',role:'Codex adapted source-backed duties',source:'Codex/Owner-directed; pinned-source:sha256-fixture',runId:'forged',authorId:managerId});
 const role=store.list('roleVersions').find(v=>v.employeeId===employee.id)!;expect(role).toMatchObject({authorId:'owner',runId:null,source:'Codex/Owner-directed; pinned-source:sha256-fixture'});expect(employee.roleAuthorship).toMatchObject({authorId:'owner',runId:null,basis:'Owner-directed appointment'});expect(employee.requisitionId).toBeUndefined();expect(store.list('roleVersions').filter(v=>v.employeeId!==employee.id)).toEqual(prior);
 expect(()=>store.command(owner,{type:'recruitment.onboard',employeeId:employee.id,rationale:'Setup acceptance'})).toThrow('first work');
 expect(()=>store.command(owner,{type:'recruitment.onboard',employeeId:managerId,rationale:'Not a new Owner hire',standbyCondition:'Wait'})).toThrow('No recruitment appointment');
 expect(()=>store.command(recruiter,{type:'recruitment.onboard',employeeId:employee.id,rationale:'Pretend recruiter acceptance',standbyCondition:'Wait'})).toThrow('Owner');
 const result=store.command(owner,{type:'recruitment.onboard',employeeId:employee.id,rationale:'Codex/Owner reviewed setup, not employee delivery',standbyCondition:'Await home-manager assignment on an accepted company priority'});expect(result.onboarding).toMatchObject({status:'accepted',authorId:'owner',runId:null});expect(store.list('experiences').filter(e=>['candidate','requisition'].includes(e.kind))).toEqual([]);
});
test('Owner executive override preserves Owner role authorship and records no invented Elder votes',()=>{
 const position=store.command(owner,{type:'position.create',title:'Owner-established executive',level:'executive',responsibilities:'Accountable portfolio leadership'}),decision=store.command(owner,{type:'decision.create',kind:'executive.appoint',subject:'Owner-directed foundation office',rationale:'Explicit setup authorization',payload:{positionId:position.id,name:'Owner-directed executive',modelId:'local-fixture',role:'Source-adapted executive duties',source:'Codex/Owner-directed source adaptation'}});
 const applied=store.command(owner,{type:'decision.override',decisionId:decision.id,approve:true,rationale:'Owner-directed setup; not independent Elder approval'});expect(applied.application.status).toBe('applied');expect(applied.override.actorId).toBe('owner');expect(store.list('votes').filter(v=>v.decisionId===decision.id)).toEqual([]);
 const employee=store.list('employees').find(e=>e.positionId===position.id)!,role=store.list('roleVersions').find(v=>v.employeeId===employee.id)!;expect(role).toMatchObject({authorId:'owner',runId:null,decisionId:decision.id});expect(employee.roleAuthorship).toMatchObject({authorId:'owner',runId:null,decisionId:decision.id});expect(employee.homeManagerId).toBe(managerId);
});
