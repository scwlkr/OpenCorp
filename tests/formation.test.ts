import { Scheduler } from '../src/scheduler/scheduler.js';
import { CorporateBroker } from '../src/tools/broker.js';
import type { LocalRuntime } from '../src/runtime/index.js';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CompanyStore } from '../src/storage/store.js';
import { departmentalCoverage, reconcileFormation, formationOutcome, enqueueCompanyWork } from '../src/core/formation.js';
let root:string,store:CompanyStore;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'opencorp-formation-'));store=new CompanyStore(root);store.bootstrap();store.command({kind:'owner'},{type:'control',action:'start'});});
afterEach(()=>{store.close();rmSync(root,{recursive:true,force:true});});
test('expansion queues governance work without manufacturing staff and resumes without duplicate proposals',()=>{
 reconcileFormation(store);expect(store.list('assignments')).toHaveLength(0);
 store.command({kind:'owner'},{type:'company.expand',mandate:'Establish broad company through real local recruitment.'});
 reconcileFormation(store);reconcileFormation(store);
 expect(Object.values(departmentalCoverage).flat()).toHaveLength(29);
 expect(store.list('employees')).toHaveLength(4);expect(store.list('departments')).toHaveLength(0);
 expect(store.list('assignments')).toHaveLength(8);expect(store.list('decisions')).toHaveLength(0);
 store.close();store=new CompanyStore(root);reconcileFormation(store);expect(store.list('assignments')).toHaveLength(8);
});
test('partial charter cannot complete formation and a matching worker title cannot replace executive governance',()=>{
 const owner={kind:'owner'} as const,ceo=store.list('employees').find(e=>store.level(e.id)==='ceo')!;
 store.command(owner,{type:'company.expand',mandate:'Recruit actual specialists.'});
 store.put('models',{id:'fixture',name:'fixture',local:true,available:true,artifactIdentity:'fixture'});
 const position=store.command(owner,{type:'position.create',title:'Chief Technology Officer',level:'worker',responsibilities:'Fixture title collision'});
 store.command(owner,{type:'employee.hire',positionId:position.id,name:'Fixture worker',modelId:'fixture',homeManagerId:ceo.id});
 reconcileFormation(store);expect(store.list('assignments').some(a=>a.schedulerKey==='formation:office:Chief Technology Officer')).toBe(true);
 const department=store.command(owner,{type:'department.create',name:'Web Engineering',managerId:ceo.id,responsibilities:'Build web products'});
 const task=store.put('assignments',{schedulerKey:'formation:department:Web Engineering',employeeId:ceo.id});
 const run=store.put('runs',{employeeId:ceo.id,assignmentId:task.id});expect(formationOutcome(store,task,run).passed).toBe(false);
 store.command(owner,{type:'department.update',departmentId:department.id,charter:'Useful web products',helpPolicy:'Ask architecture',standingDuties:[{name:'Web quality',instructions:'Inspect actual needs'}],rationale:'Form department'});
 for(const [title,level] of [['Web lead','lead'],['Frontend','worker'],['Backend','worker']])store.command(owner,{type:'position.create',title,level,departmentId:department.id,responsibilities:title});
 expect(formationOutcome(store,task,run).passed).toBe(true);expect(store.list('employees')).toHaveLength(5);
});

test('formation schedules completion of existing partial departments',()=>{
 const owner={kind:'owner'} as const,ceo=store.list('employees').find(e=>store.level(e.id)==='ceo')!;
 store.command(owner,{type:'company.expand',mandate:'Complete persistent specialist formation'});
 const position=store.put('positions',{title:'Chief Technology Officer',level:'executive',status:'active'});
 const executive=store.put('employees',{name:'Existing CTO',status:'active',positionId:position.id,homeManagerId:ceo.id});
 const department=store.command(owner,{type:'department.create',name:'Web Engineering',managerId:executive.id,responsibilities:'Web products'});
 reconcileFormation(store);reconcileFormation(store);
 const tasks=store.list('assignments').filter(a=>a.schedulerKey==='formation:department:Web Engineering');expect(tasks).toHaveLength(1);expect(tasks[0].employeeId).toBe(executive.id);
 expect(tasks[0].instructions).toContain('Reuse an existing partial department');expect(store.need('departments',department.id).charter).toBeUndefined();
});

test('rejected executive proposals defer to the existing audited scheduler correction path',()=>{
 const owner={kind:'owner'} as const,ceo=store.list('employees').find(e=>store.level(e.id)==='ceo')!;
 store.command(owner,{type:'company.expand',mandate:'Establish governed executive coverage'});reconcileFormation(store);
 const task=store.list('assignments').find(a=>a.schedulerKey==='formation:office:Chief Technology Officer')!;
 store.update('assignments',task.id,{status:'completed'});
 const position=store.put('positions',{title:'Chief Technology Officer',level:'executive',status:'active'});
 const decision=store.put('decisions',{kind:'executive.appoint',status:'rejected',payload:{positionId:position.id}});
 const elders=store.list('employees').filter(e=>store.level(e.id)==='elder');
 for(const elder of elders.slice(0,2))store.put('votes',{decisionId:decision.id,employeeId:elder.id,phase:'initial',approve:false});
 reconcileFormation(store);expect(store.list('assignments').filter(a=>a.schedulerKey?.startsWith('formation:office:Chief Technology Officer'))).toHaveLength(1);
 store.put('votes',{decisionId:decision.id,employeeId:elders[2].id,phase:'initial',approve:true});reconcileFormation(store);reconcileFormation(store);
 const revised=store.list('assignments').filter(a=>a.schedulerKey?.startsWith('formation:office:Chief Technology Officer'));expect(revised).toHaveLength(1);
 const run=store.put('runs',{employeeId:ceo.id,assignmentId:task.id});expect(formationOutcome(store,task,run).passed).toBe(false);
 store.put('decisions',{kind:'strategy',status:'recorded',payload:{positionId:position.id},subject:'Proposal blocked by iteration budget'});expect(formationOutcome(store,task,run).passed).toBe(false);
 store.put('decisions',{kind:'executive.appoint',status:'pending',authorId:ceo.id,runId:run.id,payload:{positionId:position.id}});expect(formationOutcome(store,task,run).passed).toBe(true);
});

test('a candidate retained before interruption satisfies the same assignment on resume',()=>{
 const ceo=store.list('employees').find(e=>store.level(e.id)==='ceo')!;
 const task=store.put('assignments',{schedulerKey:'formation:candidate:requisition-fixture:0',employeeId:ceo.id});
 const first=store.put('runs',{employeeId:ceo.id,assignmentId:task.id,status:'failed'});
 store.put('experiences',{kind:'candidate',requisitionId:'requisition-fixture',status:'proposed',authorship:{runId:first.id}});
 const resumed=store.put('runs',{employeeId:ceo.id,assignmentId:task.id,status:'running'});
 expect(formationOutcome(store,task,resumed).passed).toBe(true);
 const unrelated=store.put('assignments',{schedulerKey:task.schedulerKey,employeeId:ceo.id});
 expect(formationOutcome(store,unrelated,{...resumed,id:'unrelated-run',assignmentId:unrelated.id}).passed).toBe(false);
});

test.each(['pending','approved','rejected'])('recovers an interrupted exact-task office proposal with status %s without replaying it',status=>{
 const ceo=store.list('employees').find(e=>store.level(e.id)==='ceo')!;
 store.command({kind:'owner'},{type:'company.expand',mandate:'Resume actual employee formation'});reconcileFormation(store);
 const task=store.list('assignments').find(a=>a.schedulerKey==='formation:office:Chief Technology Officer')!;
 const run=store.put('runs',{employeeId:ceo.id,assignmentId:task.id,status:'interrupted'});
 const position=store.put('positions',{title:'Chief Technology Officer',level:'executive',status:'active'});
 const decision=store.put('decisions',{kind:'executive.appoint',status,authorId:ceo.id,runId:run.id,payload:{positionId:position.id}});
 const previousRun=store.need('runs',run.id),previousDecision=store.need('decisions',decision.id),employeeCount=store.list('employees').length;
 expect(formationOutcome(store,task,run).passed).toBe(true);
 reconcileFormation(store);reconcileFormation(store);
 expect(store.need('assignments',task.id)).toMatchObject({status:'completed',attempts:0,completionEvidence:{decisionId:decision.id,runId:run.id,recovered:true,source:'retained-executive-proposal'}});
 expect(store.need('runs',run.id)).toEqual(previousRun);expect(store.need('decisions',decision.id)).toEqual(previousDecision);expect(store.list('employees')).toHaveLength(employeeCount);expect(store.list('runs')).toHaveLength(1);
 store.close();store=new CompanyStore(root);reconcileFormation(store);expect(store.list('runs')).toHaveLength(1);expect(store.need('assignments',task.id).status).toBe('completed');
});

test('office recovery excludes unrelated authoring tasks, wrong offices, missing provenance and active runs',()=>{
 const ceo=store.list('employees').find(e=>store.level(e.id)==='ceo')!;
 store.command({kind:'owner'},{type:'company.expand',mandate:'Keep exact proposal attribution'});reconcileFormation(store);
 const task=store.list('assignments').find(a=>a.schedulerKey==='formation:office:Chief Technology Officer')!;
 const position=store.put('positions',{title:'Chief Technology Officer',level:'executive',status:'active'});
 const unrelated=store.put('assignments',{employeeId:ceo.id,schedulerKey:'appointment-rejected:prior',status:'completed'});
 const otherRun=store.put('runs',{employeeId:ceo.id,assignmentId:unrelated.id,status:'succeeded'});
 const proposal=store.put('decisions',{kind:'executive.appoint',status:'approved',authorId:ceo.id,runId:otherRun.id,payload:{positionId:position.id}});
 const run=store.put('runs',{employeeId:ceo.id,assignmentId:task.id,status:'interrupted'});
 expect(formationOutcome(store,task,run).passed).toBe(false);reconcileFormation(store);expect(store.need('assignments',task.id).status).toBe('queued');
 store.update('decisions',proposal.id,{runId:undefined});reconcileFormation(store);expect(store.need('assignments',task.id).status).toBe('queued');
 store.update('decisions',proposal.id,{runId:run.id});store.update('positions',position.id,{title:'Other Office'});reconcileFormation(store);expect(store.need('assignments',task.id).status).toBe('queued');
 store.update('positions',position.id,{title:'Chief Technology Officer'});store.update('runs',run.id,{status:'running'});reconcileFormation(store);expect(store.need('assignments',task.id).status).toBe('queued');
 store.update('runs',run.id,{status:'interrupted'});reconcileFormation(store);expect(store.need('assignments',task.id).status).toBe('completed');
 const correction=store.put('assignments',{employeeId:ceo.id,schedulerKey:'formation:office:Chief Technology Officer:withdrawn:later',status:'queued'});
 reconcileFormation(store);expect(store.need('assignments',correction.id).status).toBe('queued');expect(formationOutcome(store,correction,{...run,assignmentId:correction.id}).passed).toBe(false);
});

test('recruiter bootstrap requires the same departmental identity used for staffing discovery',()=>{
 const owner={kind:'owner'} as const,ceo=store.list('employees').find(e=>store.level(e.id)==='ceo')!;
 store.command(owner,{type:'company.expand',mandate:'Form actual recruitment'});
 store.put('models',{id:'fixture',name:'fixture',local:true,available:true,artifactIdentity:'fixture'});
 const office=store.put('positions',{title:'Chief People Officer',level:'executive',status:'active'});
 const people=store.put('employees',{name:'People executive',positionId:office.id,homeManagerId:ceo.id,status:'active'});
 const department=store.command(owner,{type:'department.create',name:'Recruitment & Workforce Planning',managerId:people.id,responsibilities:'Scoped staffing'});
 reconcileFormation(store);
 const task=store.list('assignments').find(a=>a.schedulerKey==='formation:recruiter-bootstrap')!,run=store.put('runs',{employeeId:people.id,assignmentId:task.id});
 store.update('departments',department.id,{charter:'Scoped candidate research'});
 expect(task.instructions).toContain(`departmentId ${department.id}`);expect(task.instructions).toContain(`homeManagerId ${people.id}`);
 const position=store.command(owner,{type:'position.create',title:'Recruitment Officer',level:'worker',responsibilities:'Adapt relevant source profiles'});
 const source=store.put('experiences',{kind:'skill-source',repository:'fixture/roles',commit:'a'.repeat(40),sha256:'b'.repeat(64),upstreamPath:'recruitment.md',license:'MIT'});
 const employee=store.command(owner,{type:'employee.hire',name:'Fixture recruiter',positionId:position.id,homeManagerId:people.id,modelId:'fixture',role:'Source candidates for manager approval',source:JSON.stringify({sourceIds:[source.id]})});
 expect(store.list('roleVersions').find(r=>r.employeeId===employee.id)?.source).toContain(source.id);
 expect(formationOutcome(store,task,run).passed).toBe(false);
 const vacancy=store.command(owner,{type:'position.create',title:'Recruitment specialist',level:'worker',departmentId:department.id,responsibilities:'Useful candidate research'});
 reconcileFormation(store);expect(store.list('assignments').some(a=>a.schedulerKey?.startsWith(`formation:request:${vacancy.id}:`))).toBe(false);
 store.update('positions',position.id,{departmentId:department.id});store.update('employees',employee.id,{departmentId:department.id});
 expect(formationOutcome(store,task,run).passed).toBe(true);
 reconcileFormation(store);expect(store.list('assignments').some(a=>a.schedulerKey?.startsWith(`formation:request:${vacancy.id}:`))).toBe(true);
 store.update('employees',employee.id,{homeManagerId:null});expect(formationOutcome(store,task,run).passed).toBe(false);
 store.update('employees',employee.id,{homeManagerId:people.id,status:'dismissed'});expect(formationOutcome(store,task,run).passed).toBe(false);
});

function onboardingFixture(level:'lead'|'worker'='lead',recruiterStatus:'active'|'dismissed'|'missing'='active'){
 const ceo=store.list('employees').find(e=>store.level(e.id)==='ceo')!;
 store.command({kind:'owner'},{type:'company.expand',mandate:'Complete real onboarding and reporting'});
 const department=store.put('departments',{name:'Fixture team',managerId:ceo.id,status:'active'});
 const position=store.put('positions',{title:'Team role',level,departmentId:department.id,status:'active'});
 const req=store.put('experiences',{kind:'requisition',positionId:position.id,departmentId:department.id,departmentManagerId:ceo.id,status:'filled'});
 const employee=store.put('employees',{name:'Recruited teammate',positionId:position.id,departmentId:department.id,homeManagerId:ceo.id,status:'active',requisitionId:req.id,onboarding:{status:'pending'}});
 // Already-hired employees remain the home manager's responsibility without Recruitment.
 const recruitment=store.put('departments',{name:'Recruitment & Workforce Planning',managerId:ceo.id,status:'active'});
 const recruiterPosition=store.put('positions',{title:'Recruitment Officer',level:'worker',departmentId:recruitment.id,status:'active'});
 if(recruiterStatus!=='missing')store.put('employees',{name:'Recruiter',status:recruiterStatus,positionId:recruiterPosition.id,departmentId:recruitment.id,homeManagerId:ceo.id});
 reconcileFormation(store);
 const task=store.list('assignments').find(a=>a.schedulerKey===`formation:onboard:${employee.id}`)!;
 const run=store.put('runs',{employeeId:ceo.id,assignmentId:task.id,status:'running'});
 return {ceo,department,position,employee,task,run};
}
test.each(['missing','dismissed'] as const)('manager onboarding continues when Recruitment Officer is %s',recruiterStatus=>{
 const f=onboardingFixture('lead',recruiterStatus);
 expect(f.task).toMatchObject({employeeId:f.ceo.id,status:'queued',priority:60});
 expect(formationOutcome(store,f.task,f.run).passed).toBe(false);
 reconcileFormation(store);
 expect(store.list('assignments').filter(a=>a.schedulerKey===f.task.schedulerKey).map(a=>a.id)).toEqual([f.task.id]);
 store.update('employees',f.employee.id,{onboarding:{status:'accepted'}});
 expect(formationOutcome(store,f.task,f.run).passed).toBe(false);
 store.update('departments',f.department.id,{managerId:f.employee.id});
 expect(formationOutcome(store,f.task,f.run).passed).toBe(true);
 expect(store.need('assignments',f.task.id).status).toBe('queued');
});
test('accepted lead onboarding requires both department ownership and scoped specialist reporting; same task survives resume',()=>{
 const f=onboardingFixture(),specialistPosition=store.put('positions',{title:'Specialist',level:'worker',status:'active',departmentId:f.department.id});
 const specialist=store.put('employees',{name:'Specialist',positionId:specialistPosition.id,departmentId:f.department.id,homeManagerId:f.ceo.id,status:'active',projectSupervisorId:'retained-project-supervisor'});
 const outside=store.put('employees',{name:'Outside employee',positionId:specialistPosition.id,departmentId:'other-department',homeManagerId:f.ceo.id,status:'active'});
 store.update('employees',f.employee.id,{onboarding:{status:'accepted'}});
 expect(formationOutcome(store,f.task,f.run).passed).toBe(false);
 reconcileFormation(store);expect(store.list('assignments').filter(a=>a.schedulerKey===f.task.schedulerKey).map(a=>a.id)).toEqual([f.task.id]);
 store.update('departments',f.department.id,{managerId:f.employee.id});
 expect(formationOutcome(store,f.task,f.run).passed).toBe(false);
 store.update('employees',specialist.id,{homeManagerId:f.employee.id});
 const resumed=store.put('runs',{employeeId:f.ceo.id,assignmentId:f.task.id,status:'running'});
 expect(formationOutcome(store,f.task,resumed).passed).toBe(true);
 expect(store.need('employees',specialist.id).projectSupervisorId).toBe('retained-project-supervisor');expect(store.need('employees',outside.id).homeManagerId).toBe(f.ceo.id);
});
test('ordinary worker accepted onboarding does not require department transfer',()=>{
 const f=onboardingFixture('worker');store.update('employees',f.employee.id,{onboarding:{status:'accepted'}});
 expect(formationOutcome(store,f.task,f.run).passed).toBe(true);
});
test.each(['dismissed','retired','reassigned','restructured','completed'])('later %s state does not reopen a retained onboarding assignment',change=>{
 const f=onboardingFixture();store.update('employees',f.employee.id,{onboarding:{status:'accepted'}});
 if(change==='dismissed')store.update('employees',f.employee.id,{status:'dismissed'});
 if(change==='retired')store.update('departments',f.department.id,{status:'retired'});
 if(change==='reassigned')store.update('employees',f.employee.id,{departmentId:'new-department'});
 if(change==='restructured')store.update('departments',f.department.id,{managerId:'new-manager'});
 if(change==='completed')store.update('assignments',f.task.id,{status:'completed'});
 reconcileFormation(store);expect(store.list('assignments').filter(a=>a.schedulerKey===f.task.schedulerKey).map(a=>a.id)).toEqual([f.task.id]);
 if(change==='completed')expect(store.need('assignments',f.task.id).status).toBe('completed');else expect(formationOutcome(store,f.task,f.run).passed).toBe(true);
});

 test('new onboarding dispatches before further departments while an existing Owner priority remains unchanged',async()=>{
 const f=onboardingFixture();store.update('runs',f.run.id,{status:'succeeded'});
 const executivePosition=store.put('positions',{title:'Chief Technology Officer',level:'executive',status:'active'});
 const executive=store.put('employees',{name:'CTO',positionId:executivePosition.id,homeManagerId:f.ceo.id,status:'active',modelId:f.ceo.modelId});
 store.put('models',{id:f.ceo.modelId,name:f.ceo.modelId,available:true,local:true,artifactIdentity:'fixture'});
 reconcileFormation(store);
 const departments=store.list('assignments').filter(a=>a.schedulerKey?.startsWith('formation:department:')&&a.status==='queued');
 expect(departments.length).toBeGreaterThan(1);expect(departments.every(a=>a.priority===55)).toBe(true);
 expect(store.need('assignments',f.task.id).priority).toBe(60);
 const override=departments[0];store.command({kind:'owner'},{type:'assignment.update',assignmentId:override.id,priority:90,rationale:'Owner explicit ordering'});
 // Keep that override unavailable; it must retain its value without bypassing readiness.
 store.update('assignments',override.id,{availableAt:new Date(Date.now()+86400000).toISOString()});
 for(const task of store.list('assignments').filter(a=>a.schedulerKey?.startsWith('formation:office:')))store.update('assignments',task.id,{status:'cancelled'});
 reconcileFormation(store);expect(store.need('assignments',override.id).priority).toBe(90);
 const scheduler=new Scheduler(store,{} as LocalRuntime,new CorporateBroker(store,root),'http://localhost');
 (scheduler as any).recoveryComplete=true;vi.spyOn(scheduler,'initialize').mockResolvedValue();
 vi.spyOn(scheduler as any,'reconcileOrganization').mockImplementation(()=>reconcileFormation(store));vi.spyOn(scheduler as any,'deliveryEvents').mockResolvedValue(undefined);
 const execute=vi.spyOn(scheduler as any,'execute').mockResolvedValue(undefined);
 await scheduler.tick();expect(execute).toHaveBeenCalledOnce();expect(execute.mock.calls[0][0]).toMatchObject({assignmentId:f.task.id,employeeId:f.ceo.id});
 expect(store.need('assignments',departments[1].id).status).toBe('queued');expect(store.need('employees',executive.id).status).toBe('active');expect(store.need('assignments',override.id).priority).toBe(90);
 });

test('new recruitment stages increase priority without modifying existing defaults or overrides',()=>{
 const f=onboardingFixture();store.update('departments',f.department.id,{charter:'Useful specialist work'});
 const position=store.put('positions',{title:'Next specialist',level:'worker',departmentId:f.department.id,status:'active'});
 reconcileFormation(store);const request=store.list('assignments').find(a=>a.schedulerKey===`formation:request:${position.id}:${f.ceo.id}`)!;expect(request.priority).toBe(56);
 const req=store.put('experiences',{kind:'requisition',positionId:position.id,departmentId:f.department.id,departmentManagerId:f.ceo.id,homeManagerId:f.ceo.id,recruiterId:f.ceo.id,status:'open'});
 reconcileFormation(store);const source=store.list('assignments').find(a=>a.schedulerKey===`formation:candidate:${req.id}:0`)!;expect(source.priority).toBe(57);
 const candidate=store.put('experiences',{kind:'candidate',requisitionId:req.id,name:'Real candidate fixture',version:1,status:'proposed'});
 reconcileFormation(store);expect(store.list('assignments').find(a=>a.schedulerKey===`formation:approve:${candidate.id}:1`)?.priority).toBe(58);
 store.update('experiences',candidate.id,{status:'approved'});reconcileFormation(store);expect(store.list('assignments').find(a=>a.schedulerKey===`formation:provision:${candidate.id}`)?.priority).toBe(59);
 store.update('assignments',source.id,{priority:55});store.command({kind:'owner'},{type:'assignment.update',assignmentId:request.id,priority:89,rationale:'Retain Owner direction'});
 reconcileFormation(store);expect(store.need('assignments',source.id).priority).toBe(55);expect(store.need('assignments',request.id).priority).toBe(89);
});

test('new candidates batch at most three matching vacancies without rewriting existing tasks',()=>{
 const f=onboardingFixture();
 const requests=Array.from({length:5},(_,i)=>{const position=store.put('positions',{title:`Specialist ${i}`,level:'worker',status:'active',departmentId:f.department.id});return store.put('experiences',{kind:'requisition',positionId:position.id,departmentId:f.department.id,departmentManagerId:f.ceo.id,homeManagerId:f.ceo.id,recruiterId:f.ceo.id,status:'open'});});
 const existing=store.put('assignments',{employeeId:f.ceo.id,kind:'management',projectId:null,status:'running',schedulerKey:`formation:candidate:${requests[0].id}:0`,payload:{formation:true},priority:91});
 reconcileFormation(store);reconcileFormation(store);
 const tasks=store.list('assignments').filter(a=>a.schedulerKey?.startsWith('formation:candidate:'));
 expect(tasks).toHaveLength(3);expect(store.need('assignments',existing.id)).toEqual(existing);
 const batch=tasks.find(a=>a.payload?.candidateRequisitionIds)!;expect(batch.payload.candidateRequisitionIds).toEqual(requests.slice(1,4).map(r=>r.id));
 const source=store.put('runs',{employeeId:f.ceo.id,assignmentId:batch.id,status:'running'});
 expect(formationOutcome(store,batch,source).passed).toBe(false);
 for(const [index,req] of requests.slice(1,4).entries()){
  store.put('experiences',{kind:'candidate',requisitionId:req.id,status:'proposed',authorship:{runId:source.id}});
  expect(formationOutcome(store,batch,source).passed).toBe(index===2);
 }
 store.update('runs',source.id,{status:'interrupted'});const resumed=store.put('runs',{employeeId:f.ceo.id,assignmentId:batch.id,status:'running'});expect(formationOutcome(store,batch,resumed).passed).toBe(true);
 reconcileFormation(store);expect(store.list('assignments').filter(a=>a.schedulerKey?.startsWith('formation:approve:'))).toHaveLength(3);
});

test('sequential vacancies coalesce only untouched never-dispatched candidate tasks',()=>{
 const f=onboardingFixture();
 const add=()=>{const position=store.put('positions',{title:'Authorized specialist',level:'worker',departmentId:f.department.id,status:'active'});return store.put('experiences',{kind:'requisition',positionId:position.id,departmentId:f.department.id,departmentManagerId:f.ceo.id,homeManagerId:f.ceo.id,recruiterId:f.ceo.id,status:'open'});};
 const first=add();reconcileFormation(store);const original=store.list('assignments').find(a=>a.schedulerKey===`formation:candidate:${first.id}:0`)!;
 const second=add();reconcileFormation(store);
 const merged=store.need('assignments',original.id),sibling=store.list('assignments').find(a=>a.schedulerKey===`formation:candidate:${second.id}:0`)!;
 expect(merged.payload.candidateRequisitionIds).toEqual([first.id,second.id]);expect(merged.instructions.startsWith(original.instructions)).toBe(true);expect(merged.priority).toBe(original.priority);
 expect(sibling).toMatchObject({status:'cancelled',supersession:{retainedAssignmentId:original.id}});expect(merged.candidateBatchAssembly.priorInstructions).toBe(original.instructions);
 const snapshot=store.need('assignments',original.id);store.put('runs',{assignmentId:original.id,employeeId:f.ceo.id,status:'interrupted'});add();reconcileFormation(store);expect(store.need('assignments',original.id)).toEqual(snapshot);
});

test.each(['run','owner','candidate','correction','untrusted'])('fresh batching excludes %s task and preserves it',mode=>{
 const f=onboardingFixture();const add=()=>{const position=store.put('positions',{title:'Specialist',level:'worker',departmentId:f.department.id,status:'active'});return store.put('experiences',{kind:'requisition',positionId:position.id,departmentId:f.department.id,departmentManagerId:f.ceo.id,homeManagerId:f.ceo.id,recruiterId:f.ceo.id,status:'open'});};
 const first=add();reconcileFormation(store);let task=store.list('assignments').find(a=>a.schedulerKey===`formation:candidate:${first.id}:0`)!;
 if(mode==='run')store.put('runs',{assignmentId:task.id,employeeId:f.ceo.id,status:'interrupted'});
 if(mode==='owner'){store.command({kind:'owner'},{type:'assignment.update',assignmentId:task.id,instructions:'Owner narrowed this role',priority:91,rationale:'Preserve my work'});store.update('assignments',task.id,{createdAt:'2020-01-01T00:00:00.000Z',updatedAt:'2020-01-01T00:00:00.000Z'});}
 if(mode==='candidate')store.put('experiences',{kind:'candidate',status:'proposed',requisitionId:first.id});
 if(mode==='correction')store.update('assignments',task.id,{schedulerKey:`formation:candidate:${first.id}:1`});
 if(mode==='untrusted')store.update('assignments',task.id,{payload:{}});
 task=store.need('assignments',task.id);add();reconcileFormation(store);expect(store.need('assignments',task.id)).toEqual(task);
});

 test('four pristine sourcing tasks form disjoint batches without cancelling a retained task',()=>{
 const f=onboardingFixture();const tasks=Array.from({length:4},()=>{const position=store.put('positions',{title:'Specialist',level:'worker',departmentId:f.department.id,status:'active'});const req=store.put('experiences',{kind:'requisition',positionId:position.id,departmentId:f.department.id,departmentManagerId:f.ceo.id,homeManagerId:f.ceo.id,recruiterId:f.ceo.id,status:'open'});return enqueueCompanyWork(store,f.ceo,`formation:candidate:${req.id}:0`,'Source candidate','Retain individually authorized brief',57);});
 reconcileFormation(store);reconcileFormation(store);
 const active=tasks.map(t=>store.need('assignments',t.id)).filter(t=>t.status==='queued');expect(active).toHaveLength(2);expect(active[0].id).toBe(tasks[0].id);
 const ids=active.flatMap(t=>t.payload?.candidateRequisitionIds??[t.schedulerKey!.split(':')[2]]);expect(ids).toHaveLength(4);expect(new Set(ids).size).toBe(4);expect(active.every(t=>(t.payload?.candidateRequisitionIds?.length??1)<=3)).toBe(true);
 });

function departmentExecutive(title='Chief Product Officer'){
 const ceo=store.list('employees').find(e=>store.level(e.id)==='ceo')!;store.command({kind:'owner'},{type:'company.expand',mandate:'Author complete distinct departments'});
 const position=store.put('positions',{title,level:'executive',status:'active'});return store.put('employees',{name:title,positionId:position.id,status:'active',homeManagerId:ceo.id});
}
test('department pairs stay within executive remit, require both real outcomes and resume partial work',()=>{
 const executive=departmentExecutive();departmentExecutive('Chief Operating Officer');reconcileFormation(store);
 const tasks=store.list('assignments').filter(a=>a.schedulerKey?.startsWith('formation:department:')&&a.status==='queued');expect(tasks.filter(a=>a.employeeId===executive.id)).toHaveLength(2);
 const batch=tasks.find(a=>a.employeeId===executive.id)!;
 const siblingId=batch.departmentBatchAssembly.sourceAssignmentIds[0],sibling=store.need('assignments',siblingId);
 expect(sibling).toMatchObject({status:'cancelled',supersession:{retainedAssignmentId:batch.id}});
 expect(batch.instructions.startsWith(batch.departmentBatchAssembly.priorInstructions)).toBe(true);expect(batch.departmentBatchAssembly.priorPayload).toEqual({formation:true});
 reconcileFormation(store);reconcileFormation(store);expect(store.need('assignments',siblingId)).toEqual(sibling);expect(store.list('assignments').filter(a=>a.schedulerKey===sibling.schedulerKey)).toHaveLength(1);
 expect(batch.payload.departmentNames).toHaveLength(2);expect(batch.payload.departmentNames.every((n:string)=>departmentalCoverage['Chief Product Officer'].includes(n))).toBe(true);
 for(const task of tasks.filter(a=>a.employeeId!==executive.id))expect((task.payload.departmentNames??[task.schedulerKey!.slice('formation:department:'.length)]).every((n:string)=>departmentalCoverage['Chief Operating Officer'].includes(n))).toBe(true);
 const run=store.put('runs',{assignmentId:batch.id,employeeId:executive.id,status:'running'});expect(formationOutcome(store,batch,run).passed).toBe(false);
 for(const [index,name] of batch.payload.departmentNames.entries()){
  const department=store.command({kind:'owner'},{type:'department.create',name,managerId:executive.id,responsibilities:`Useful ${name} work`});
  store.command({kind:'owner'},{type:'department.update',departmentId:department.id,charter:`Actual ${name} charter`,helpPolicy:'Coordinate with related teams',standingDuties:[{name:'Useful upkeep',instructions:'Inspect current requests'}],rationale:'Actual departmental formation'});
  for(const [title,level] of [['Lead','lead'],['First specialist','worker'],['Second specialist','support']])store.command({kind:'owner'},{type:'position.create',departmentId:department.id,title:`${name} ${title}`,level,responsibilities:'Distinct local duties'});
  expect(formationOutcome(store,batch,run).passed).toBe(index===1);
  const before=store.list('positions').length;reconcileFormation(store);expect(store.list('positions')).toHaveLength(before);expect(store.need('assignments',batch.id).payload.departmentNames).toEqual(batch.payload.departmentNames);
 }
 const resumed=store.put('runs',{assignmentId:batch.id,employeeId:executive.id,status:'running'});expect(formationOutcome(store,batch,resumed).passed).toBe(true);
});
test.each(['edited','ever-run','applied'])('department batching preserves %s singleton work',mode=>{
 const executive=departmentExecutive();const task=enqueueCompanyWork(store,executive,'formation:department:Product Management','Establish Product Management','Retain exact instructions',55);
 if(mode==='edited')store.command({kind:'owner'},{type:'assignment.update',assignmentId:task.id,instructions:'Owner-specific instructions',priority:89,rationale:'Preserve scope'});
 if(mode==='ever-run')store.put('runs',{assignmentId:task.id,employeeId:executive.id,status:'interrupted'});
 if(mode==='applied')store.command({kind:'owner'},{type:'department.create',name:'Product Management',managerId:executive.id,responsibilities:'Retain partial records'});
 const before=store.need('assignments',task.id);reconcileFormation(store);expect(store.need('assignments',task.id)).toEqual(before);
});

test('empty department scheduler suffix cannot satisfy formation completion',()=>{
 const ceo=store.list('employees').find(e=>store.level(e.id)==='ceo')!;
 const task=store.put('assignments',{employeeId:ceo.id,kind:'management',projectId:null,schedulerKey:'formation:department:',payload:{formation:true}});
 const run=store.put('runs',{employeeId:ceo.id,assignmentId:task.id});expect(formationOutcome(store,task,run).passed).toBe(false);
});

test('company enqueue observes retained keys immediately without scanning assignment history',()=>{
 const ceo=store.list('employees').find(e=>store.level(e.id)==='ceo')!,reads=vi.spyOn(store,'list');
 const first=enqueueCompanyWork(store,ceo,'formation:test:retained','Original task','Actual instructions',59);
 store.update('assignments',first.id,{status:'cancelled',instructions:'Owner retained correction',priority:99});
 const retained=enqueueCompanyWork(store,ceo,first.schedulerKey!,'Duplicate','Must not overwrite',1);
 expect(retained).toMatchObject({id:first.id,status:'cancelled',instructions:'Owner retained correction',priority:99});expect(reads.mock.calls.filter(([table])=>table==='assignments')).toHaveLength(0);reads.mockRestore();
});
test('one recruitment snapshot per synchronous pass sees new receipts on the next pass and preserves batch dedup',()=>{
 const f=onboardingFixture(),requests=Array.from({length:3},()=>{const position=store.put('positions',{title:'Specialist',level:'worker',status:'active',departmentId:f.department.id});return store.put('experiences',{kind:'requisition',positionId:position.id,departmentId:f.department.id,departmentManagerId:f.ceo.id,homeManagerId:f.ceo.id,recruiterId:f.ceo.id,status:'open'});});
 const reads=vi.spyOn(store,'list'),pass=()=>{reads.mockClear();reconcileFormation(store);expect(reads.mock.calls.filter(([table])=>table==='experiences')).toHaveLength(1);};
 pass();const tasks=store.list('assignments').filter(a=>a.schedulerKey?.startsWith('formation:candidate:'));expect(tasks).toHaveLength(1);expect(tasks[0].payload.candidateRequisitionIds).toEqual(requests.map(r=>r.id));
 const candidate=store.put('experiences',{kind:'candidate',requisitionId:requests[0].id,name:'Actual test candidate',version:1,status:'proposed'});pass();expect(store.assignmentBySchedulerKey(`formation:approve:${candidate.id}:1`)).toBeDefined();
 store.update('experiences',candidate.id,{status:'approved'});pass();expect(store.assignmentBySchedulerKey(`formation:provision:${candidate.id}`)).toBeDefined();expect(store.list('assignments').filter(a=>a.schedulerKey?.startsWith('formation:candidate:')).map(a=>a.id)).toEqual(tasks.map(a=>a.id));reads.mockRestore();
});

test('batch checkpoint names only missing exact-assignment receipts and accepts actual supersession',()=>{
 const f=onboardingFixture(),reqs=[0,1].map(()=>store.put('experiences',{kind:'requisition',status:'open'}));
 const task=enqueueCompanyWork(store,f.ceo,`formation:candidate:${reqs[0].id}:0`,'Batch','Author both candidates',57,{candidateRequisitionIds:reqs.map(r=>r.id)}),run=store.put('runs',{assignmentId:task.id,employeeId:f.ceo.id,status:'running'});
 store.put('experiences',{kind:'candidate',status:'proposed',requisitionId:reqs[0].id,authorship:{runId:run.id}});const unrelated=store.put('runs',{assignmentId:'other-assignment',employeeId:f.ceo.id,status:'succeeded'});store.put('experiences',{kind:'candidate',status:'proposed',requisitionId:reqs[1].id,authorship:{runId:unrelated.id}});
 const incomplete=formationOutcome(store,task,run);expect(incomplete.passed).toBe(false);expect(incomplete.summary).toContain(`Missing candidate receipts for requisitions ["${reqs[1].id}"]`);expect(incomplete.summary).toContain(`Retained members ["${reqs[0].id}"] need no repeat`);
 store.update('experiences',reqs[1].id,{status:'cancelled',supersession:{replacementRequisitionId:'not-retained'}});expect(formationOutcome(store,task,run).passed).toBe(false);store.put('experiences',{id:'not-retained',kind:'requisition',status:'open'});expect(formationOutcome(store,task,run).passed).toBe(true);
});


test('an actual executive transfer creates one new vacancy obligation without replaying historical office work',()=>{
 const owner={kind:'owner'} as const,ceo=store.list('employees').find(e=>store.level(e.id)==='ceo')!;
 store.command(owner,{type:'company.expand',mandate:'Maintain canonical executive coverage'});reconcileFormation(store);
 store.put('models',{id:'fixture',name:'fixture',local:true,available:true,artifactIdentity:'fixture'});
 const cpo=store.command(owner,{type:'position.create',title:'Chief Product Officer',level:'executive',responsibilities:'Product ownership'}),cto=store.command(owner,{type:'position.create',title:'Chief Technology Officer',level:'executive',responsibilities:'Technology ownership'});
 const appoint=(positionId:string,name:string)=>{const proposal=store.command(owner,{type:'decision.create',kind:'executive.appoint',subject:name,rationale:'Initial fixture executive',payload:{positionId,name,modelId:'fixture',role:'Actual fixture executive responsibilities'}});store.command(owner,{type:'decision.override',decisionId:proposal.id,approve:true,rationale:'Explicit initial fixture appointment'});return store.list('employees').find(e=>e.positionId===positionId&&e.status==='active')!;};
 const alex=appoint(cpo.id,'Alex'),casey=appoint(cto.id,'Casey');
 const old=store.assignmentBySchedulerKey('formation:office:Chief Product Officer')!;store.update('assignments',old.id,{status:'completed'});
 const before=store.need('assignments',old.id),oldAppointment=store.list('appointments').find(a=>a.employeeId===alex.id&&!a.endedAt)!;
 const decision=store.command(owner,{type:'decision.create',kind:'executive.replace',subject:'Move existing executive',rationale:'Actual governed replacement',payload:{positionId:cto.id,employeeId:alex.id}});
 store.command(owner,{type:'decision.override',decisionId:decision.id,approve:true,rationale:'Fixture explicitly authorizes the actual transfer'});
 expect(store.need('employees',casey.id).status).toBe('dismissed');expect(store.need('employees',alex.id).positionId).toBe(cto.id);
 reconcileFormation(store);reconcileFormation(store);
 const key=`formation:office:Chief Product Officer:vacancy:${oldAppointment.id}`,fresh=store.assignmentBySchedulerKey(key)!;
 expect(fresh).toMatchObject({status:'queued',employeeId:ceo.id});expect(store.need('assignments',old.id)).toEqual(before);expect(store.list('assignments').filter(a=>a.schedulerKey===key)).toHaveLength(1);
 const run=store.put('runs',{employeeId:ceo.id,assignmentId:fresh.id});expect(formationOutcome(store,fresh,run).passed).toBe(false);
 store.command(owner,{type:'decision.create',kind:'executive.appoint',subject:'Pending new CPO',rationale:'Actual pending proposal suppresses further requests',payload:{positionId:cpo.id,name:'New candidate',modelId:'fixture',role:'Product ownership'}});
 reconcileFormation(store);expect(store.list('assignments').filter(a=>a.schedulerKey?.startsWith('formation:office:Chief Product Officer'))).toHaveLength(2);
});
