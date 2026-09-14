import { RunInspection } from '../src/runtime/inspection.js';
import { fromJSONSchema } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyStore, instructionsHash } from '../src/storage/store.js';
import { CorporateBroker, brokerTools, corporateGuide } from '../src/tools/broker.js';
import { formationOutcome } from '../src/core/formation.js';
import { managementOutcome } from '../src/scheduler/scheduler.js';
import { commandFields } from '../src/tools/commands.js';
import type { Actor, Employee, Project } from '../src/core/types.js';

const withoutDescriptions=(value:unknown)=>JSON.parse(JSON.stringify(value,(key,item)=>key==='description'?undefined:item));
const owner={kind:'owner'} as const,model='wlkr-management-qwen3.8-27b-q4-k-m:latest';
let root:string,store:CompanyStore,broker:CorporateBroker,ceo:Employee;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'opencorp-broker-'));store=new CompanyStore(root);store.bootstrap();store.put('models',{name:model,artifactIdentity:'fixture-local-digest',local:true,available:true,capabilities:['tools']});store.command(owner,{type:'control',action:'start'});broker=new CorporateBroker(store,root);ceo=store.list('employees').find(e=>store.level(e.id)==='ceo')!;});
afterEach(async()=>{await broker.cancel();store.close();rmSync(root,{recursive:true,force:true});vi.restoreAllMocks();});
// Exercise canonical field schemas through optional help instead of requiring their full advertisement.
async function disclosedTools(actor:Actor):Promise<any[]> {
 const tools=broker.toolsFor(actor);
 return Promise.all(tools.map(async tool=>{
  if(tool.name!=='company_command')return tool;
  const canonical=brokerTools.find(t=>t.name==='company_command')!.inputSchema.properties.command;
  const branches=await Promise.all(tool.inputSchema.properties.command.properties.type.enum.map(async(commandType:string)=>(await broker.call(actor,'company_help',{commandType})).inputSchema));
  return {...tool,inputSchema:{...tool.inputSchema,properties:{command:{...canonical,anyOf:branches}}}};
 }));
}

function hire(name:string,homeManagerId=ceo.id,level='manager'):Employee{const position=store.command(owner,{type:'position.create',title:name,level,responsibilities:'Concrete product responsibility'});return store.command(owner,{type:'employee.hire',name,positionId:position.id,homeManagerId,modelId:model});}
function actorFor(employee:Employee,project?:Project):Extract<Actor,{kind:'employee'}>{
 const assignment=store.command(owner,{type:'assignment.create',employeeId:employee.id,projectId:project?.id,title:'Inspect retained evidence',instructions:'Diagnose actual work',acceptance:['Source-linked judgment'],kind:project?'implementation':'management'});
 const run=store.put('runs',{employeeId:employee.id,assignmentId:assignment.id,modelId:model,workspace:project?.workspace??root,sessionId:randomUUID(),policyRevision:store.policy.revision,status:'running',attempt:1,heartbeatAt:new Date().toISOString(),leaseUntil:new Date(Date.now()+60000).toISOString(),tokenRevoked:false,tokenHash:'PRIVATE_TOKEN_HASH'});
 return {kind:'employee',employeeId:employee.id,runId:run.id,policyRevision:store.policy.revision};
}

describe('typed management tools',()=>{
 it('keeps acceptance followup bookkeeping and independent delegation with a smaller tool scope',async()=>{
  const project=store.command(owner,{type:'project.create',name:'Retained implementation',outcome:'Reviewed artifact',acceptance:['Actual result'],supervisorId:ceo.id,rationale:'Acceptance followup fixture'});
  const source=actorFor(ceo,project),original=store.need('assignments',store.need('runs',source.runId).assignmentId),actor=actorFor(ceo),taskId=store.need('runs',actor.runId).assignmentId;
  const full=broker.toolsFor(actor);
  store.update('assignments',taskId,{schedulerKey:`acceptance:${original.id}:fixture`,payload:{acceptanceAssignmentId:original.id,sourceProjectId:project.id}});
  const scoped=broker.toolsFor(actor),names=scoped.map(tool=>tool.name);
  expect(JSON.stringify(scoped).length).toBeLessThan(JSON.stringify(full).length);
  expect(names).toEqual(expect.arrayContaining(['company_detail','company_command','create_assignment','finish_assignment','inspect_artifact']));
  expect(names).not.toContain('deliver_product');
  await broker.call(actor,'company_command',{command:{type:'assignment.update',assignmentId:original.id,completionRequirements:original.acceptance.map((criterion:string)=>({criterion,source:'artifact'})),rationale:'Retain exact original artifact requirements'}});
  await expect(broker.call(actor,'finish_assignment',{assignmentId:original.id,artifactId:'missing-artifact',rationale:'No actual source'})).rejects.toThrow();
  expect(store.need('assignments',original.id).status).not.toBe('completed');
  const artifact=store.put('artifacts',{projectId:project.id,assignmentId:original.id,employeeId:ceo.id,runId:source.runId,kind:'commit',identity:'synthetic-artifact'}),reviewer=hire('Independent acceptance reviewer');
  const review=await broker.call(actor,'create_assignment',{employeeId:reviewer.id,projectId:project.id,kind:'review',title:'Evaluate retained coverage',instructions:'Inspect the exact artifact and evaluate original requirements independently.',acceptance:['Actual coverage verdict'],payload:{artifactId:artifact.id}});
  expect(store.need('assignments',review.id)).toMatchObject({kind:'review',employeeId:reviewer.id,payload:{artifactId:artifact.id}});
  store.update('assignments',taskId,{payload:{acceptanceAssignmentId:original.id,sourceProjectId:'wrong-project'}});
  expect(broker.toolsFor(actor).map(tool=>tool.name)).toContain('propose_executive');
 });
 function diagnosis(){
  const manager=hire('Product supervisor'),worker=hire('Assigned implementer',manager.id,'worker');
  const project=store.command(owner,{type:'project.create',name:'Retained broad commitment',productId:store.list('products')[0].id,outcome:'Actual reviewed delivery',acceptance:['Document CI','External contribution merged'],supervisorId:manager.id,rationale:'Leadership-selected scope'});
  let original=store.command(owner,{type:'assignment.create',projectId:project.id,employeeId:worker.id,title:'Broad original work',instructions:'Document CI and obtain the external contribution.',acceptance:project.acceptance,kind:'implementation'});
  original=store.update('assignments',original.id,{status:'blocked',blockedReason:'Missing implementation checkpoint',attempts:3});
  const failed=store.put('runs',{employeeId:worker.id,assignmentId:original.id,modelId:model,status:'failed',attempt:3,error:original.blockedReason});
  const actor=actorFor(manager,project),task=store.update('assignments',store.need('runs',actor.runId).assignmentId,{kind:'management',status:'running',schedulerKey:`fault:${failed.id}`,payload:{failedRunId:failed.id,failedAssignmentId:original.id,baselineModelId:model,baselineInstructionsHash:instructionsHash(original.instructions),baselineBlockedReason:original.blockedReason}});
  const outcome=()=>managementOutcome(store,store.need('assignments',task.id),store.need('runs',actor.runId));
  return {manager,worker,project,original,failed,actor,task,outcome};
 }
 it('lets responsible fault management adopt a skill lesson while preserving role authority',async()=>{
  const {actor,original}=diagnosis(),employee=store.need('employees',original.employeeId);
  expect(broker.toolsFor(actor).map(t=>t.name)).toContain('update_role');
  await broker.call(actor,'update_role',{employeeId:employee.id,content:employee.role+'\nUse retained results before retrying.',source:actor.runId,rationale:'Observed repeated recovery failure'});
  expect(store.need('employees',employee.id).roleVersion).toBe(employee.roleVersion+1);
  await expect(broker.call(actor,'update_role',{employeeId:ceo.id,content:'Unauthorized revision',source:actor.runId,rationale:'Not a managed employee'})).rejects.toMatchObject({code:'forbidden'});
 });
 it('keeps inline diagnosis knowledge linked and authorized without changing normal or explicit reads',async()=>{
  const {actor,original,failed}=diagnosis();
  const linked=store.command(owner,{type:'knowledge.write',scope:'company',content:'LINKED_FAILURE_FINDING',source:`Observed failed run ${failed.id}`});
  const unrelated=store.command(owner,{type:'knowledge.write',scope:'company',content:'UNRELATED_WORKFORCE_REPORT',source:'Different employee task'});
  const hidden=store.command(owner,{type:'knowledge.write',scope:'employees',scopeId:ceo.id,content:'PRIVATE_LEADERSHIP_FINDING',source:`Observed ${original.id}`});
  const generated=store.command(owner,{type:'knowledge.write',scope:'company',content:'GENERATED_MIRROR',source:`Mirror ${original.id}`});store.update('knowledge',generated.id,{generated:true});
  const notes=broker.knowledgeContext(actor,[],20000),focused=broker.promptContext(actor).knowledge.items;
  expect(notes.map(n=>n.id)).toContain(linked.id);expect(focused.map((n:any)=>n.id)).toContain(linked.id);
  for(const id of [unrelated.id,hidden.id,generated.id]){expect(notes.map(n=>n.id)).not.toContain(id);expect(focused.map((n:any)=>n.id)).not.toContain(id);}
  expect((await broker.call(actor,'company_detail',{collection:'knowledge',id:unrelated.id,view:'content'})).content).toBe('UNRELATED_WORKFORCE_REPORT');
  expect((await broker.call(actor,'knowledge_search',{query:'UNRELATED_WORKFORCE_REPORT'})).items.some((n:any)=>n.id===unrelated.id)).toBe(true);
  await expect(broker.call(actor,'company_detail',{collection:'knowledge',id:hidden.id})).rejects.toMatchObject({code:'evidence_forbidden'});
  const ordinary=actorFor(ceo);expect(broker.knowledgeContext(ordinary,[],20000).map(n=>n.id)).toContain(unrelated.id);
  const replacement=store.command(owner,{type:'knowledge.write',scope:'company',content:'CORRECTED_LINKED_FINDING',source:`Corrected ${failed.id}`,supersedes:linked.id});
  const corrected=broker.knowledgeContext(actor,[],20000);expect(corrected.map(n=>n.id)).not.toContain(linked.id);expect(corrected.map(n=>n.id)).toContain(replacement.id);
  store.command(owner,{type:'knowledge.write',scope:'company',content:'WITHDRAWN_LINK',source:'Corrected unrelated evidence',supersedes:replacement.id});
  expect(broker.knowledgeContext(actor,[],20000).map(n=>n.id)).not.toContain(replacement.id);
 });
 const disposition={blockedReason:'The original acceptance requires an external contributor and cannot be completed by this implementation alone.',rationale:'The retained assignment includes an external contribution, while the failed run contains no authored artifact.',remainingPrerequisite:'An independently reviewed external contribution must actually merge before the original acceptance can be complete.'};
 it('typed retry derives the blocked original and atomically retains current-run correction without weakening acceptance',async()=>{
  const {actor,original,failed,task,outcome}=diagnosis(),args={instructions:'Document existing CI with verified repository evidence, then obtain the independently reviewed external contribution.',rationale:'The prior instructions omitted the concrete verification and review approach.'};
  expect(broker.toolsFor(actor).find(t=>t.name==='revise_and_retry_assignment')!.inputSchema.required).toEqual(['instructions','rationale']);
  expect(await broker.call(actor,'company_help',{})).toContain('revise_and_retry_assignment {instructions:');
  expect((await broker.call(actor,'company_help',{commandType:'assignment.update'})).guidance).toContain('revise_and_retry_assignment');
  await expect(broker.call(actor,'company_command',{command:{type:'assignment.update',assignmentId:original.id,status:'queued'}})).rejects.toThrow(/revise_and_retry_assignment/);
  for(const invalid of [{instructions:args.instructions},{...args,rationale:' '},{...args,assignmentId:original.id},{...args,status:'completed'}])await expect(broker.call(actor,'revise_and_retry_assignment',invalid)).rejects.toMatchObject({code:'retry_arguments'});
  await expect(broker.call(actor,'revise_and_retry_assignment',{...args,instructions:` ${original.instructions} `})).rejects.toMatchObject({code:'unchanged_retry'});
  expect(store.need('assignments',original.id)).toEqual(original);expect(store.need('runs',actor.runId).corporateCommands??[]).toEqual([]);
  await broker.call(actor,'revise_and_retry_assignment',args);
  const revised=store.need('assignments',original.id);expect(revised).toMatchObject({id:original.id,status:'queued',instructions:args.instructions,acceptance:original.acceptance,projectId:original.projectId,employeeId:original.employeeId,supervisorId:original.supervisorId});
  expect(revised.faultCorrections.at(-1)).toMatchObject({runId:actor.runId,failedRunId:failed.id,instructionsChanged:true,rationale:args.rationale});expect(revised.retryDecisions.at(-1)).toMatchObject({runId:actor.runId,priorStatus:'blocked',priorAttempts:3});
  expect(store.need('runs',actor.runId).corporateCommands).toEqual([expect.objectContaining({type:'assignment.update',id:original.id})]);expect(outcome().passed).toBe(true);expect(store.need('assignments',task.id).status).toBe('running');
  await expect(broker.call(actor,'revise_and_retry_assignment',args)).rejects.toMatchObject({code:'diagnosis_required'});
 });
 it('typed retry excludes ordinary and forged supervisor scopes and stale failures',async()=>{
  const {actor,original,failed}=diagnosis(),args={instructions:'Changed actual approach',rationale:'Observed diagnosis'};
  const ordinary=actorFor(ceo);expect(broker.toolsFor(ordinary).map(t=>t.name)).not.toContain('revise_and_retry_assignment');await expect(broker.call(ordinary,'revise_and_retry_assignment',args)).rejects.toMatchObject({code:'diagnosis_required'});
  const outsider=actorFor(hire('Unrelated supervisor'));store.update('assignments',store.need('runs',outsider.runId).assignmentId,{kind:'management',status:'running',schedulerKey:`fault:${failed.id}`,payload:{failedRunId:failed.id,failedAssignmentId:original.id}});
  await expect(broker.call(outsider,'revise_and_retry_assignment',args)).rejects.toMatchObject({code:'diagnosis_required'});
  store.put('runs',{employeeId:original.employeeId,assignmentId:original.id,status:'failed'});
  await expect(broker.call(actor,'revise_and_retry_assignment',args)).rejects.toMatchObject({code:'diagnosis_required'});expect(store.need('assignments',original.id)).toEqual(original);
 });
 it('scopes trusted fault recovery and initial evidence without removing full authorized reads',async()=>{
  const {actor,original,failed,worker,project}=diagnosis();
  const names=(await disclosedTools(actor)).map(tool=>tool.name),schema=(await disclosedTools(actor)).find(t=>t.name==='company_command')!.inputSchema.properties.command;
  expect(schema.anyOf.map((b:any)=>b.properties.type.enum[0]).sort()).toEqual(['role.update','employee.model','assignment.update','assignment.create','decision.create','responsibility.update','owner.request','message.send'].sort());
  for(const name of ['record_blocked_diagnosis','create_assignment','company_read','company_detail','knowledge_search','repo_read','repo_pr','repo_issue','inspect_artifact','fetch_public','browser','skill_discover','skill_import','skill_read'])expect(names).toContain(name);
  for(const name of ['communicate','propose_executive','vote_decision','commit_work','deliver_product','publish_release'])expect(names).not.toContain(name);
  const help=await broker.call(actor,'company_help',{});expect(help).toContain(original.id);expect(help).toContain(failed.id);expect(help).toContain('actual current-run model or instruction change');expect(help.length).toBeLessThan(3000);
  store.update('runs',failed.id,{runtimeFailureCode:'native_step_limit',runtimeDiagnosticsPath:'/retained/failure.json'});
  store.update('policy',store.policy.id,{concurrencyQualification:{fixture:'Synthetic retained capacity evidence'}});
  const note=store.command(actor,{type:'knowledge.write',scope:'projects',scopeId:project.id,title:'Linked failure lesson',content:'Read retained failure evidence',source:`failed run ${failed.id}`});
  const unrelated=store.put('attention',{status:'open',title:'UNRELATED_FAULT_ALERT'});
  const context=broker.promptContext(actor);expect(context.policy.concurrencyQualification).toBeUndefined();expect(store.policy.concurrencyQualification).toEqual({fixture:'Synthetic retained capacity evidence'});expect(context.originalAssignment.id).toBe(original.id);expect(context.failedRun.id).toBe(failed.id);expect(context.failure).toMatchObject({employeeId:worker.id,runtimeFailureCode:'native_step_limit',details:{collection:'runs',id:failed.id,view:'record'}});expect(JSON.stringify(context)).not.toContain('/retained/failure.json');expect(context.knowledge.items.some((k:any)=>k.id===note.id)).toBe(true);expect(JSON.stringify(context)).not.toContain('UNRELATED_FAULT_ALERT');expect(JSON.stringify(context).length).toBeLessThanOrEqual(12000);
  await expect(broker.call(actor,'company_detail',{collection:'runs',id:failed.id,view:'verification'})).rejects.toThrow('retained failure summary use company_detail');
  await expect(broker.call(actor,'company_detail',{collection:'attention',id:unrelated.id})).resolves.toBeDefined();
  const ordinary=actorFor(ceo);expect(withoutDescriptions((await disclosedTools(ordinary)))).toEqual(withoutDescriptions(brokerTools.filter(tool=>!['revise_and_retry_assignment','resolve_ruby_dependencies','commit_work','verify_product','deliver_product','communicate','prepare_preview','prepare_release','publish_release','inspect_artifact','review_work','import_pull_request'].includes(tool.name))));expect(await broker.call(ordinary,'company_help',{})).toBe(corporateGuide);
 });
 it('trusted fault scope retains changed retry validation and cannot grant an outsider recovery authority',async()=>{
  const {actor,original,worker,outcome}=diagnosis();
  await expect(broker.call(actor,'company_command',{command:{type:'assignment.update',assignmentId:original.id,status:'queued',rationale:'No real change'}})).rejects.toMatchObject({code:'unchanged_retry'});expect(outcome().passed).toBe(false);
  const alternate=store.put('models',{name:'fixture-alternate-local',local:true,available:true,artifactIdentity:'alternate-digest'});
  const outsider=actorFor(hire('Unrelated manager'));
  await expect(broker.call(outsider,'company_command',{command:{type:'employee.model',employeeId:worker.id,modelId:alternate.name,rationale:'Outside responsibility'}})).rejects.toThrow();
  await broker.call(actor,'company_command',{command:{type:'employee.model',employeeId:worker.id,modelId:alternate.name,rationale:'Use local model suited to observed failure'}});
  await broker.call(actor,'company_command',{command:{type:'assignment.update',assignmentId:original.id,status:'queued',rationale:'Retry exact original with changed local model'}});
  expect(outcome().passed).toBe(true);expect(store.need('assignments',original.id).acceptance).toEqual(original.acceptance);
 });
 it('advertises direct arguments with no caller-selected diagnosis identity',()=>{
  const create=brokerTools.find(tool=>tool.name==='create_assignment')!.inputSchema,blocked=brokerTools.find(tool=>tool.name==='record_blocked_diagnosis')!.inputSchema;
  expect(create.required).toEqual(['employeeId','title','instructions','acceptance','kind']);expect(create.additionalProperties).toBe(false);
  expect(blocked.required).toEqual(['blockedReason','rationale','remainingPrerequisite']);expect(Object.keys(blocked.properties)).toEqual(blocked.required);expect(blocked.additionalProperties).toBe(false);
  expect(corporateGuide).toContain('Prefer create_assignment');expect(corporateGuide).toContain('prefer record_blocked_diagnosis');
 });
 it('creates only explicitly scoped subset work with unchanged supervision, staffing and original acceptance rules',async()=>{
  const {actor,worker,project,original,outcome}=diagnosis(),other=hire('Other home manager'),shared=hire('Shared specialist',other.id,'worker');
  const input={employeeId:worker.id,projectId:project.id,title:'Document existing CI',instructions:'Write accurate CI documentation and verify the source.',acceptance:['CI documentation committed and verified'],kind:'implementation',priority:7,payload:{sourceAssignmentId:original.id}};
  const created=await broker.call(actor,'create_assignment',input);
  expect(store.need('assignments',created.id)).toMatchObject({...input,supervisorId:actor.employeeId,status:'queued',accepted:true});
  const sharedTask=await broker.call(actor,'create_assignment',{...input,employeeId:shared.id});expect(store.need('assignments',sharedTask.id).accepted).toBe(false);
  expect(store.need('assignments',original.id)).toEqual(original);expect(outcome().passed).toBe(false);
  const outsider=actorFor(other),before=store.list('assignments');await expect(broker.call(outsider,'create_assignment',input)).rejects.toThrow(/project supervisor/);expect(store.list('assignments')).toEqual(before);
 });
 it.each([{command:{employeeId:'wrapped'}},{employeeId:'employee',title:'Missing acceptance',instructions:'Actual work'},{employeeId:'employee',title:'Empty acceptance',instructions:'Actual work',acceptance:[]}])('rejects malformed typed assignment arguments without creating work',async input=>{
  const {actor}=diagnosis(),before=store.list('assignments');await expect(broker.call(actor,'create_assignment',input)).rejects.toThrow(/direct employeeId.*nonempty acceptance/);expect(store.list('assignments')).toEqual(before);expect(store.need('runs',actor.runId).corporateCommands??[]).toEqual([]);
 });
 it('atomically retains a precise blocked disposition and actual current-run receipts, without completing original work',async()=>{
  const {actor,original,failed,task,outcome}=diagnosis(),observations:boolean[]=[];
  store.events.on('event',event=>{if(['assignment.update','decision.create'].includes(event.type))observations.push(store.need('assignments',original.id).blockedReason===disposition.blockedReason&&store.list('decisions').some(d=>d.runId===actor.runId&&d.payload.failedRunId===failed.id)&&(store.need('runs',actor.runId).corporateCommands??[]).length===2);});
  const result=await broker.call(actor,'record_blocked_diagnosis',{...disposition,failedAssignmentId:'untrusted-other-assignment',actor:{kind:'owner'}});
  expect(result.currentDiagnosis).toMatchObject({assignmentId:task.id,blockedAssignmentId:original.id});expect(result.currentDiagnosis.assignmentId).not.toBe(result.assignment.id);
  expect(result.assignment.id).toBe(original.id);expect(result.decision._receipt.fullRecord).toEqual({collection:'decisions',id:result.decision.id});
  expect(store.need('assignments',original.id)).toMatchObject({status:'blocked',instructions:original.instructions,acceptance:original.acceptance,blockedReason:disposition.blockedReason});
  expect(store.need('decisions',result.decision.id)).toMatchObject({authorId:actor.employeeId,runId:actor.runId,kind:'strategy',status:'recorded',rationale:disposition.rationale,payload:{failedRunId:failed.id,failedAssignmentId:original.id,disposition:'blocked',remainingPrerequisite:disposition.remainingPrerequisite}});
  expect(store.need('runs',actor.runId).corporateCommands?.map((command:any)=>command.type)).toEqual(['assignment.update','decision.create']);expect(observations).toEqual([true,true]);expect(outcome().passed).toBe(true);expect(store.need('assignments',task.id).status).toBe('running');
  const decisions=store.list('decisions');await expect(broker.call(actor,'record_blocked_diagnosis',disposition)).rejects.toThrow(/existing or initial/);expect(store.list('decisions')).toEqual(decisions);
 });
 it.each(['wrong actor','stale run','queued original','completed original','cancelled original','inactive diagnosis'] as const)('denies a blocked disposition for %s',async scenario=>{
  const fixture=diagnosis();let actor=fixture.actor;
  if(scenario==='wrong actor')actor=actorFor(hire('Unrelated supervisor'));
  if(scenario==='stale run')store.put('runs',{...fixture.failed,id:undefined,attempt:4});
  if(scenario.endsWith(' original'))store.update('assignments',fixture.original.id,{status:scenario==='queued original'?'queued':scenario==='completed original'?'completed':'cancelled'});
  if(scenario==='inactive diagnosis')store.update('assignments',fixture.task.id,{status:'blocked'});
  const before=store.need('assignments',fixture.original.id),decisions=store.list('decisions');await expect(broker.call(actor,'record_blocked_diagnosis',disposition)).rejects.toThrow(/active trusted diagnosis/);expect(store.need('assignments',fixture.original.id)).toEqual(before);expect(store.list('decisions')).toEqual(decisions);expect(store.need('runs',actor.runId).corporateCommands??[]).toEqual([]);
 });
 it.each([{blockedReason:' ',rationale:'Actual cause',remainingPrerequisite:'Actual prerequisite'},{blockedReason:'New reason',rationale:' ',remainingPrerequisite:'Actual prerequisite'},{blockedReason:'New reason',rationale:'Actual cause'},{blockedReason:'Missing implementation checkpoint',rationale:'Actual cause',remainingPrerequisite:'Actual prerequisite'}])('rejects malformed or unchanged blocked diagnoses before any business mutation',async input=>{
  const {actor,original}=diagnosis(),decisions=store.list('decisions');await expect(broker.call(actor,'record_blocked_diagnosis',input)).rejects.toThrow(/nonempty text|existing or initial/);expect(store.need('assignments',original.id)).toEqual(original);expect(store.list('decisions')).toEqual(decisions);expect(store.need('runs',actor.runId).corporateCommands??[]).toEqual([]);
 });
 it('rolls back both original correction and receipts and emits no committed notifications when decision storage fails',async()=>{
  const {actor,original}=diagnosis(),decisions=store.list('decisions'),notified:string[]=[];
  store.events.on('event',event=>{if(['assignment.update','decision.create'].includes(event.type))notified.push(event.type);});
  store.db.exec("CREATE TRIGGER reject_diagnosis BEFORE INSERT ON decisions BEGIN SELECT RAISE(ABORT,'fixture decision storage failed'); END;");
  await expect(broker.call(actor,'record_blocked_diagnosis',disposition)).rejects.toThrow(/fixture decision storage failed/);
  expect(store.need('assignments',original.id)).toEqual(original);expect(store.list('decisions')).toEqual(decisions);expect(store.need('runs',actor.runId).corporateCommands??[]).toEqual([]);expect(notified).toEqual([]);
 });
});

describe('scoped retained evidence',()=>{
 it('prioritizes recent scoped corrections over oversized old profiles without admitting another employee private notes',()=>{
  const worker=hire('Current specialist',ceo.id,'worker'),other=hire('Unrelated specialist',ceo.id,'worker'),actor=actorFor(worker);
  const clock=vi.spyOn(Date.prototype,'toISOString').mockReturnValue('2030-01-01T00:00:00.000Z');
  const mirror=store.vault.write({scope:'employees',scopeId:worker.id,title:'Old generated profile',content:'OLD_PROFILE '.repeat(500),generated:true});
  const old=store.command(owner,{type:'knowledge.write',scope:'company',title:'Older source context',content:'OLD_CONTEXT '.repeat(500),source:'run:older-evidence'});
  clock.mockReturnValue('2030-01-02T00:00:00.000Z');
  const earlier=store.command(owner,{type:'knowledge.write',scope:'employees',scopeId:worker.id,title:'Earlier observed correction',content:'EARLIER_CORRECTION: read the retained verifier receipt.',source:'run:earlier-evidence'});
  clock.mockReturnValue('2030-01-03T00:00:00.000Z');
  const latest=store.command(owner,{type:'knowledge.write',scope:'employees',scopeId:worker.id,title:'Latest observed correction',content:'LATEST_CORRECTION: employee instructions now persist after native compaction.',source:'run:latest-evidence'});
  clock.mockReturnValue('2030-01-04T00:00:00.000Z');
  const privateNote=store.command(owner,{type:'knowledge.write',scope:'employees',scopeId:other.id,title:'Private unrelated record',content:'PRIVATE_UNRELATED_NOTE',source:'run:private-evidence'});
  const legacy=store.command(owner,{type:'knowledge.write',scope:'company',title:'Legacy structured provenance',content:'LEGACY_CONTEXT',source:{runId:'older-structured-source'}});
  // A recently refreshed mirror must still follow source-linked correction notes.
  store.update('knowledge',mirror.id,{title:'Refreshed generated profile'});
  const context=broker.knowledgeContext(actor,[worker.id,other.id]);
  expect(context.slice(0,3).map(note=>note.id)).toEqual([latest.id,earlier.id,old.id]);
  expect(context[0].content).toBe(store.readKnowledge(latest.id).content);expect(context[0].truncated).toBe(false);
  expect(context.reduce((sum,note)=>sum+note.content.length,0)).toBe(4500);expect(context.at(-1)?.nextOffset).not.toBeNull();
  expect(context.some(note=>note.id===mirror.id||note.id===privateNote.id)).toBe(false);expect(JSON.stringify(context)).not.toContain('PRIVATE_UNRELATED_NOTE');
  expect(context.some(note=>note.id===legacy.id)).toBe(false);
  expect(store.readKnowledge(mirror.id).content.length).toBeGreaterThan(4500);
 });
 it('keeps a fresh public correction while excluding a newer peer initial judgment from prioritized knowledge',()=>{
  const elders=store.list('employees').filter(e=>store.level(e.id)==='elder'),peer=actorFor(elders[0]),reader=actorFor(elders[1]);
  const decision=store.command(owner,{type:'decision.create',kind:'executive.review',subject:'Independent review',rationale:'Judge current evidence',payload:{employeeId:ceo.id}});
  store.update('assignments',store.need('runs',peer.runId).assignmentId,{kind:'governance',payload:{decisionId:decision.id}});
  const clock=vi.spyOn(Date.prototype,'toISOString').mockReturnValue('2030-02-01T00:00:00.000Z');
  store.vault.write({scope:'company',title:'Oversized operational mirror',content:'OLD_COMPANY_PROFILE '.repeat(500),generated:true});
  clock.mockReturnValue('2030-02-02T00:00:00.000Z');
  const correction=store.command(owner,{type:'knowledge.write',scope:'company',title:'Installed runtime correction',content:'PUBLIC_CORRECTION: inspect the actual preserved run evidence.',source:'acceptance/runtime-repair.json'});
  clock.mockReturnValue('2030-02-03T00:00:00.000Z');
  store.command(peer,{type:'decision.vote',decisionId:decision.id,approve:false,rationale:'HIDDEN_INITIAL_JUDGMENT'});
  const hidden=store.command(peer,{type:'knowledge.write',scope:'company',title:'Initial judgment',content:'HIDDEN_INITIAL_JUDGMENT',source:`decision:${decision.id}`});
  const context=broker.knowledgeContext(reader,[elders[1].id],100);
  expect(context[0].id).toBe(correction.id);expect(context[0].content).toBe(store.readKnowledge(correction.id).content);
  expect(context.reduce((sum,note)=>sum+note.content.length,0)).toBe(100);expect(JSON.stringify(context)).not.toContain('HIDDEN_INITIAL_JUDGMENT');
  expect(context.some(note=>note.id===hidden.id)).toBe(false);
  store.command(reader,{type:'decision.vote',decisionId:decision.id,approve:true,rationale:'My independently recorded assessment'});
  expect(broker.knowledgeContext(reader,[elders[1].id],100)[0].id).toBe(hidden.id);
 });
 it('provides actual learning, role versions and narrative bodies to responsible management while denying another team',async()=>{
  const manager=hire('Responsible manager'),other=hire('Other manager'),worker=hire('Specialist',manager.id,'worker'),workerActor=actorFor(worker),managerActor=actorFor(manager),otherActor=actorFor(other);
  const experience=store.command(workerActor,{type:'experience.record',summary:'Canonical verifier failed',source:'run:actual-failed-check',learned:'Use the pinned Ruby environment before retrying'});
  const note=store.command(workerActor,{type:'knowledge.write',scope:'employees',scopeId:worker.id,title:'Ruby setup finding',content:'# Actual finding\nUse pinned Ruby.\n',source:experience.id});
  const role=store.list('roleVersions').find(r=>r.employeeId===worker.id)!;
  expect((await broker.call(managerActor,'company_detail',{collection:'experiences',id:experience.id})).content).toContain('pinned Ruby environment');
  expect((await broker.call(managerActor,'company_detail',{collection:'roleVersions',id:role.id})).content).toContain('Concrete product responsibility');
  expect((await broker.call(managerActor,'company_detail',{collection:'knowledge',id:note.id})).content).toBe('# Actual finding\nUse pinned Ruby.\n');
  const search=await broker.call(managerActor,'knowledge_search',{query:'Ruby'});expect(search.items.some((r:any)=>r.id===note.id)).toBe(true);
  await expect(broker.call(otherActor,'company_detail',{collection:'knowledge',id:note.id})).rejects.toThrow(/authorized scope/);
  expect((await broker.call(otherActor,'knowledge_search',{query:'Ruby'})).items).toEqual([]);
  for(const id of [note.id,'unknown-evidence-id'])await expect(broker.call(otherActor,'company_detail',{collection:'assignments',id})).rejects.toMatchObject({code:'evidence_forbidden',message:'Evidence is absent or outside this employee\'s authorized scope. Collection paging uses the same scope and cannot reveal this ID. Use available evidence, ask the responsible employee for the needed result, or retain the missing prerequisite; do not scan collections for this denied ID.'});
  const runs=await broker.call(managerActor,'company_read',{collection:'runs'});expect(runs.items.some((r:any)=>r.id===workerActor.runId)).toBe(true);expect(JSON.stringify(runs)).not.toContain('PRIVATE_TOKEN_HASH');
  const detail=await broker.call(managerActor,'company_detail',{collection:'runs',id:workerActor.runId});expect(detail.content).not.toContain('PRIVATE_TOKEN_HASH');
 });
 it('does not expose initial Elder judgments through run text, roles, messages, experience or notes',async()=>{
  const elders=store.list('employees').filter(e=>store.level(e.id)==='elder'),peer=actorFor(elders[0]),reader=actorFor(elders[1]);
  const decision=store.command(owner,{type:'decision.create',kind:'executive.review',subject:'Actual leadership outcome',rationale:'Assess evidence',payload:{employeeId:ceo.id}});
  const peerRun=store.need('runs',peer.runId);store.update('assignments',peerRun.assignmentId,{kind:'governance',payload:{decisionId:decision.id}});
  store.command(peer,{type:'decision.vote',decisionId:decision.id,approve:false,rationale:'HIDDEN_INITIAL_JUDGMENT'});store.update('runs',peerRun.id,{text:'HIDDEN_INITIAL_JUDGMENT'});store.update('employees',elders[0].id,{role:'HIDDEN_INITIAL_JUDGMENT'});
  store.put('roleVersions',{employeeId:elders[0].id,version:2,content:'HIDDEN_INITIAL_JUDGMENT',source:'Initial review'});
  store.command(peer,{type:'experience.record',summary:'HIDDEN_INITIAL_JUDGMENT',source:'Independent review',learned:'HIDDEN_INITIAL_JUDGMENT'});
  store.command(peer,{type:'message.send',recipientId:ceo.id,content:'HIDDEN_INITIAL_JUDGMENT'});
  const channel=store.command(owner,{type:'workplace.channel.create',name:'Visible workplace channel'});
  const channelMessage=store.put('messages',{senderId:peer.employeeId,recipientId:null,projectId:null,channelId:channel.id,runId:peer.runId,content:'HIDDEN_INITIAL_JUDGMENT'});
  await expect(broker.call(reader,'company_detail',{collection:'messages',id:channelMessage.id})).rejects.toMatchObject({code:'evidence_forbidden'});
  expect((await broker.call(reader,'company_read',{collection:'messages',channelId:channel.id})).total).toBe(0);
  store.command(peer,{type:'knowledge.write',scope:'company',title:'Review judgment',content:'HIDDEN_INITIAL_JUDGMENT',source:'Independent review'});
  for(const collection of ['runs','experiences','roleVersions','employees','messages','knowledge','decisions'])expect(JSON.stringify(await broker.call(reader,'company_read',{collection,limit:30}))).not.toContain('HIDDEN_INITIAL_JUDGMENT');
  expect(JSON.stringify(broker.knowledgeContext(reader,[elders[0].id]))).not.toContain('HIDDEN_INITIAL_JUDGMENT');
  await expect(broker.call(reader,'company_detail',{collection:'runs',id:peerRun.id})).rejects.toThrow(/authorized scope/);
  store.command(reader,{type:'decision.vote',decisionId:decision.id,approve:true,rationale:'My independent judgment'});
  expect((await broker.call(reader,'company_detail',{collection:'runs',id:peerRun.id})).content).toContain('HIDDEN_INITIAL_JUDGMENT');
  expect((await broker.call(reader,'company_read',{collection:'messages',channelId:channel.id})).items.map((m:any)=>m.id)).toContain(channelMessage.id);
 });
 it('requires the assigned initial vote before mutations and hides subsequent peer proposals in scheduler snapshots',async()=>{
  const elders=store.list('employees').filter(e=>store.level(e.id)==='elder'),peer=actorFor(elders[0]),reader=actorFor(elders[1]);
  const decision=store.command(owner,{type:'decision.create',kind:'executive.review',subject:'Independent governance',rationale:'Judge actual delivery',payload:{employeeId:ceo.id}});
  for(const actor of [peer,reader])store.update('assignments',store.need('runs',actor.runId).assignmentId,{kind:'governance',payload:{decisionId:decision.id}});
  const proposal={type:'decision.create',kind:'strategy',subject:'PEER_FOLLOWUP_JUDGMENT',rationale:'PEER_FOLLOWUP_JUDGMENT',payload:{outcome:'Actual follow-up work'},runId:'forged-origin'};
  await expect(broker.call(peer,'company_command',{command:proposal})).rejects.toThrow(/independent initial/);
  await expect(broker.call(peer,'company_command',{command:{type:'role.update',employeeId:peer.employeeId,content:'My judgment',source:'initial',rationale:'premature'}})).rejects.toThrow(/independent initial/);
  await expect(broker.call(peer,'company_command',{command:{type:'decision.vote',decisionId:'other-decision',approve:true,rationale:'Wrong assignment'}})).rejects.toThrow(/independent initial/);
  await broker.call(peer,'company_command',{command:{type:'decision.vote',decisionId:decision.id,approve:true,rationale:'My own initial judgment'}});
  const followup=await broker.call(peer,'company_command',{command:proposal});expect(followup.runId).toBe(peer.runId);expect(store.snapshot().decisions.some(d=>d.id===followup.id)).toBe(true);
  expect(store.snapshot(reader).decisions.some(d=>d.id===followup.id)).toBe(false);expect(JSON.stringify(await broker.call(reader,'company_read',{collection:'decisions'}))).not.toContain('PEER_FOLLOWUP_JUDGMENT');
  await expect(broker.call(reader,'company_detail',{collection:'decisions',id:followup.id})).rejects.toThrow(/authorized scope/);
  store.update('decisions',followup.id,{runId:undefined});expect(store.snapshot(reader).decisions.some(d=>d.id===followup.id)).toBe(false); // Legacy run command audit still closes the leak.
  await broker.call(reader,'company_command',{command:{type:'decision.vote',decisionId:decision.id,approve:false,rationale:'My independently formed dissent'}});
  expect(store.snapshot(reader).decisions.some(d=>d.id===followup.id)).toBe(true);expect((await broker.call(reader,'company_detail',{collection:'decisions',id:followup.id})).content).toContain('PEER_FOLLOWUP_JUDGMENT');
 });
 it.each(['dependency-wait','responsibility','message'])('keeps %s mixed recovery chains, requests and descendant decisions blind to each unvoted Elder',async(lastKind)=>{
  const elders=store.list('employees').filter(employee=>store.level(employee.id)==='elder'),[peer,reader,third]=elders.map(employee=>actorFor(employee));
  const decision=store.command(owner,{type:'decision.create',kind:'executive.review',subject:'Independent leadership assessment',rationale:'Judge actual evidence',payload:{employeeId:ceo.id}});
  for(const elder of [peer,reader,third])store.update('assignments',store.need('runs',elder.runId).assignmentId,{kind:'governance',payload:{decisionId:decision.id}});
  const originalId=store.need('runs',peer.runId).assignmentId,secret='PRIVATE_DEPENDENCY_JUDGMENT';
  // Persist descendants before their parents to require closure, not insertion-order propagation.
  const last=actorFor(elders[0]),middle=actorFor(elders[0]),first=actorFor(elders[0]);
  const firstId=store.need('runs',first.runId).assignmentId,middleId=store.need('runs',middle.runId).assignmentId,lastId=store.need('runs',last.runId).assignmentId;
  store.update('assignments',firstId,{schedulerKey:`dependency-wait:${originalId}:fixture`,title:`${secret} dependency diagnosis`,payload:{blockedAssignmentId:originalId}});
  store.update('assignments',middleId,{schedulerKey:'fault:fixture-failure',title:`${secret} fault descendant`,payload:{failedAssignmentId:firstId}});
  store.update('assignments',lastId,{schedulerKey:`${lastKind}:${middleId}:fixture`,title:`${secret} recovery descendant`,payload:lastKind==='responsibility'?{sourceAssignmentId:middleId}:{blockedAssignmentId:middleId}});
  if(lastKind==='message'){
   const message=store.command(middle,{type:'message.send',recipientId:ceo.id,content:secret,wake:false});
   store.update('assignments',lastId,{employeeId:ceo.id,schedulerKey:`message:${message.id}`,payload:{incomingMessageId:message.id}});
   store.update('runs',last.runId,{employeeId:ceo.id});last.employeeId=ceo.id;
  }
  for(const origin of [first,middle,last])store.update('runs',origin.runId,{text:secret});
  const request=store.put('attention',{kind:'owner_decision',status:'open',title:secret,detail:secret,assignmentId:lastId,runId:last.runId});
  store.put('attention',{kind:'owner_decision',status:'open',title:secret,detail:secret,assignmentId:originalId});
  const vote=await broker.call(peer,'vote_decision',{decisionId:decision.id,approve:false,rationale:'My retained independent dissent'});
  const childDecision=await broker.call(last,'company_command',{command:{type:'decision.create',kind:'executive.review',subject:`${secret} follow-up`,rationale:secret,payload:{employeeId:ceo.id}}});
  await broker.call(last,'company_command',{command:{type:'message.send',recipientId:ceo.id,content:secret}});
  const child=actorFor(elders[0]),childId=store.need('runs',child.runId).assignmentId;
  store.update('assignments',childId,{kind:'governance',title:`${secret} child judgment`,payload:{decisionId:childDecision.id}});
  await broker.call(child,'vote_decision',{decisionId:childDecision.id,approve:true,rationale:secret});
  const descendant=await broker.call(child,'company_command',{command:{type:'decision.create',kind:'strategy',subject:`${secret} descendant decision`,rationale:secret,payload:{}}});
  const retainedVote=store.need('votes',vote.id);
  for(const unvoted of [reader,third]){
   expect(store.snapshot(unvoted).decisions.some(item=>[childDecision.id,descendant.id].includes(item.id))).toBe(false);
   for(const collection of ['assignments','runs','decisions','messages','attention'])expect(JSON.stringify(await broker.call(unvoted,'company_read',{collection,limit:30}))).not.toContain(secret);
   expect(JSON.stringify(broker.promptContext(unvoted))).not.toContain(secret);
   for(const id of [firstId,middleId,lastId,childId])await expect(broker.call(unvoted,'company_detail',{collection:'assignments',id})).rejects.toThrow(/authorized scope/);
   for(const id of [first.runId,middle.runId,last.runId,child.runId])await expect(broker.call(unvoted,'company_detail',{collection:'runs',id})).rejects.toThrow(/authorized scope/);
   await expect(broker.call(unvoted,'company_detail',{collection:'attention',id:request.id})).rejects.toThrow(/authorized scope/);
   await expect(broker.call(unvoted,'company_detail',{collection:'decisions',id:descendant.id})).rejects.toThrow(/authorized scope/);
  }
  await broker.call(reader,'vote_decision',{decisionId:decision.id,approve:true,rationale:'Reader independently evaluates original evidence'});
  expect((await broker.call(reader,'company_detail',{collection:'assignments',id:lastId})).content).toContain(secret);expect(store.snapshot(reader).decisions.some(item=>item.id===childDecision.id)).toBe(true);
  expect(store.snapshot(reader).decisions.some(item=>item.id===descendant.id)).toBe(false);expect(JSON.stringify(await broker.call(third,'company_read',{collection:'assignments',limit:30}))).not.toContain(secret);
  const readerChild=actorFor(elders[1]);store.update('assignments',store.need('runs',readerChild.runId).assignmentId,{kind:'governance',payload:{decisionId:childDecision.id}});
  await broker.call(readerChild,'vote_decision',{decisionId:childDecision.id,approve:false,rationale:'Reader independently evaluates the child decision'});
  expect((await broker.call(readerChild,'company_detail',{collection:'decisions',id:descendant.id})).content).toContain(secret);expect(store.need('votes',vote.id)).toEqual(retainedVote);
 });
 it('bounds large repository evidence with explicit pages and retains complete stored sources',async()=>{
  const actor=actorFor(ceo),product=store.list('products')[2],body='Observation '.repeat(7000);
  const binding={repository:'fixture/product',url:'https://github.com/fixture/product',defaultBranch:'main',public:true,baseCommit:'base',originalHead:'head',localStatus:'',refreshedAt:new Date().toISOString(),issues:Array.from({length:40},(_,i)=>({number:i+1,title:'Source-backed product issue',body,url:`https://github.com/fixture/product/issues/${i+1}`})),pulls:[],files:Object.fromEntries(Array.from({length:10},(_,i)=>[`doc-${i}.md`,body]))};
  vi.spyOn(broker.workspaces,'inspect').mockImplementation(async()=>{store.update('products',product.id,{binding});return binding as any;});
  const result=await broker.call(actor,'repo_inspect',{productId:product.id});expect(JSON.stringify(result).length).toBeLessThanOrEqual(6000);expect(result.issues.items[0].body.truncated).toBe(true);expect(result.issues.total).toBe(40);
  expect((await broker.call(actor,'repo_issue',{productId:product.id,number:1,offset:8000})).content).toBe(body.slice(8000,16000));
  vi.spyOn(broker.workspaces,'readProduct').mockResolvedValue(body);
  const page=await broker.call(actor,'repo_read',{productId:product.id,path:'README.md'});expect(page.content).toHaveLength(6000);expect(page.nextOffset).toBe(6000);expect(page.totalCharacters).toBe(body.length);
  expect((await broker.call(actor,'repo_read',{productId:product.id,path:'README.md',offset:6000,limit:50000})).content).toBe(body.slice(6000,18000));
 });
 it('labels remote-source character pages and gives an exact larger next call without changing requested content',async()=>{
  const actor=actorFor(ceo),product=store.list('products')[0],workspace=join(root,'remote-source-fixture'),mirror=join(root,'repositories','source-fixture.git');mkdirSync(join(workspace,'docs'),{recursive:true});mkdirSync(join(root,'repositories'),{recursive:true});execFileSync('/usr/bin/git',['init','--bare',mirror],{stdio:'pipe'});
  const git=(args:string[])=>execFileSync('/usr/bin/git',['--git-dir',mirror,'--work-tree',workspace,'-c','user.name=Fixture','-c','user.email=fixture@localhost','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null',...args],{cwd:workspace,env:{PATH:'/usr/bin:/bin',HOME:root,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'},encoding:'utf8'}).trim();
  const content='  # Retained source\n'+'Actual baseline line with preserved spaces.  \n'.repeat(400);writeFileSync(join(workspace,'docs/STATUS.md'),content);git(['add','docs/STATUS.md']);git(['commit','-m','Fixture remote baseline']);store.update('products',product.id,{binding:{mirror,baseCommit:git(['rev-parse','HEAD'])}});writeFileSync(join(workspace,'docs/STATUS.md'),'Different uncommitted workspace content');
  const page=await broker.call(actor,'repo_read',{productId:product.id,path:'docs/STATUS.md',offset:1,limit:100});expect(page).toMatchObject({units:'characters',offset:1,content:content.slice(1,101),totalCharacters:content.length,nextOffset:101,nextCall:{tool:'repo_read',arguments:{productId:product.id,path:'docs/STATUS.md',offset:101,limit:6000}}});expect(page.paginationGuidance).toContain('100 characters');
  const next=await broker.call(actor,page.nextCall.tool,page.nextCall.arguments);expect(next.content).toBe(content.slice(101,6101));expect(next.offset).toBe(101);expect(next.nextCall).toBeUndefined();
  const last=await broker.call(actor,'repo_read',{productId:product.id,path:'docs/STATUS.md',offset:content.length-20,limit:100});expect(last.content).toBe(content.slice(-20));expect(last.nextOffset).toBeNull();expect(last.nextCall).toBeUndefined();
  const normal=await broker.call(actor,'repo_read',{productId:product.id,path:'docs/STATUS.md'});expect(normal.content).toBe(content.slice(0,6000));expect(normal.nextCall).toBeUndefined();expect((await broker.call(actor,'repo_read',{productId:product.id,path:'docs/STATUS.md',limit:50000})).content).toBe(content.slice(0,12000));
  const schema=brokerTools.find(tool=>tool.name==='repo_read')!.inputSchema;expect(schema.properties.offset.description).toContain('Zero-based character offset');expect(schema.properties.limit.description).toContain('6000 for normal reading');expect(corporateGuide).toContain('Existing assignment acceptance stays intact');
 });
 it('keeps a grown company and large nested records inside the model budget without losing paging access',async()=>{
  const actor=actorFor(ceo),long='source-linked observation '.repeat(1000);
  const qualification={fixture:'Synthetic retained capacity evidence'};store.update('policy',store.policy.id,{concurrencyQualification:qualification,productiveConcurrencyQualification:qualification});
  for(let i=0;i<60;i++)store.put('decisions',{authorId:ceo.id,subject:`Decision ${i}`,rationale:long,kind:'strategy',status:'recorded',policyRevision:store.policy.revision,payload:{evidence:long,checks:Array(20).fill(long)},result:{explanation:long}});
  const summary=await broker.call(actor,'company_read',{collection:'summary',limit:30});expect(JSON.stringify(summary).length).toBeLessThanOrEqual(12000);expect(summary.decisions.total).toBe(60);expect(summary.decisions.items.length).toBeLessThanOrEqual(3);expect(summary.decisions.offset).toBe(57);
  const collection=await broker.call(actor,'company_read',{collection:'decisions',limit:30});expect(JSON.stringify(collection).length).toBeLessThanOrEqual(12000);expect(collection.items.length).toBeGreaterThan(0);expect(collection.items.length).toBeLessThan(30);expect(collection.nextOffset).toBe(collection.items.length);expect(collection.items[0].payload.truncated).toBe(true);
  const next=await broker.call(actor,'company_read',{collection:'decisions',limit:30,offset:collection.nextOffset});expect(next.items[0].id).not.toBe(collection.items[0].id);expect(JSON.stringify(next).length).toBeLessThanOrEqual(12000);
  const detail=await broker.call(actor,'company_detail',{collection:'decisions',id:collection.items[0].id,offset:8000});expect(detail.offset).toBe(8000);expect(detail.content).toHaveLength(8000);expect(detail.totalCharacters).toBeGreaterThan(16000);
  const run=store.need('runs',actor.runId);store.update('assignments',run.assignmentId,{instructions:long,payload:{decisionId:collection.items[0].id}});const context=broker.promptContext(actor);expect(JSON.stringify(context).length).toBeLessThanOrEqual(12000);expect(context.assignment.id).toBe(run.assignmentId);expect(context.assignment.instructions.truncated).toBe(true);expect(context.assignedDecision.id).toBe(collection.items[0].id);expect(JSON.parse(JSON.stringify(context)).assignment.payload.decisionId).toBe(collection.items[0].id);
  expect(context.policy).toEqual({...store.policy,concurrencyQualification:undefined,productiveConcurrencyQualification:undefined});expect(summary.policy.concurrencyQualification).toEqual(qualification);expect(summary.policy.productiveConcurrencyQualification).toEqual(qualification);expect(store.policy.concurrencyQualification).toEqual(qualification);
 });
});

describe('bounded corporate mutation receipts',()=>{
 it('exposes completion prerequisites and lets only supervising management persist an exact dependency correction',async()=>{
  const manager=hire('Dependency supervisor'),worker=hire('Subset worker',manager.id,'worker'),actor=actorFor(manager);
  const base={employeeId:worker.id,supervisorId:manager.id,title:'Retained broad assignment',instructions:'Preserve actual outcomes',acceptance:['Actual independent evidence'],kind:'implementation'};
  const original=store.command(owner,{type:'assignment.create',...base});store.update('assignments',original.id,{status:'blocked',blockedReason:'The original awaits actual subset outcomes'});
  const subset=store.command(owner,{type:'assignment.create',...base,title:'Actionable subset',dependencies:[original.id],payload:{sourceAssignmentId:original.id}});
  const page=await broker.call(actor,'company_read',{collection:'assignments'});expect(page.items.find((item:any)=>item.id===subset.id).dependencies).toEqual([original.id]);expect(page.items.find((item:any)=>item.id===original.id).blockedReason).toBe('The original awaits actual subset outcomes');
  const before=store.need('runs',actor.runId).corporateCommands??[];
  await expect(broker.call(actor,'company_command',{command:{type:'assignment.update',assignmentId:subset.id,dependencies:[]}})).rejects.toThrow(/Dependency rationale/);expect(store.need('assignments',subset.id)).toEqual(subset);expect(store.need('runs',actor.runId).corporateCommands??[]).toEqual(before);
  const receipt=await broker.call(actor,'company_command',{command:{type:'assignment.update',assignmentId:subset.id,dependencies:[],rationale:'Source provenance does not require the original to complete first'}});
  const detail=JSON.parse((await broker.call(actor,'company_detail',receipt._receipt.fullRecord)).content);expect(detail.dependencies).toEqual([]);expect(detail.acceptance).toEqual(subset.acceptance);expect(detail.payload).toEqual(subset.payload);expect(detail.dependencyDecisions[0]).toMatchObject({actorId:manager.id,runId:actor.runId,priorDependencies:[original.id],dependencies:[]});
  const command=brokerTools.find(tool=>tool.name==='company_command')!.inputSchema.properties.command.anyOf.find((branch:any)=>branch.properties.type.enum[0]==='assignment.update');
  expect(command.properties.dependencies).toMatchObject({type:'array',items:{type:'string'}});expect(Object.keys(command.properties).indexOf('dependencies')).toBeLessThan(Object.keys(command.properties).indexOf('rationale'));
  expect(corporateGuide).toContain('payload.sourceAssignmentId for provenance');expect(corporateGuide).toContain('assignment.update {assignmentId,dependencies:[actual prerequisite IDs],rationale}');
 });
 it('exposes every existing generic command field and nested evidence fields through the provider-compatible object schema',()=>{
  const schema=brokerTools.find(tool=>tool.name==='company_command')!.inputSchema.properties.command;
  expect(schema.properties).toBeUndefined();expect(schema.anyOf.map((branch:any)=>branch.properties.type.enum[0])).toEqual(Object.keys(commandFields));
  for(const [type,entry] of Object.entries(commandFields)){
   const branch=schema.anyOf.find((item:any)=>item.properties.type.enum[0]===type);
   expect(branch.type).toBe('object');expect(branch.properties.type.enum).toEqual([type]);expect(branch.required).toEqual(['type',...entry.required]);
   expect(Object.keys(branch.properties)).toEqual(['type',...entry.required,...entry.optional]);
  }
  const model=schema.anyOf.find((item:any)=>item.properties.type.enum[0]==='employee.model').properties;
  expect(model.employeeId.type).toBe('string');expect(model.modelId.type).toBe('string');expect(model.rationale.type).toBe('string');
  const payload=schema.anyOf.find((item:any)=>item.properties.type.enum[0]==='decision.create').properties.payload;
  expect(payload.additionalProperties).toBe(true);
  expect(Object.keys(payload.properties)).toEqual(['positionId','employeeId','name','modelId','role','acting','source','rejectedDecisionId','reviewedVoteIds','failedRunId','failedAssignmentId','disposition','remainingPrerequisite']);
  const evidence=schema.anyOf.find((item:any)=>item.properties.type.enum[0]==='project.update').properties.completionEvidence;
  expect(evidence.items.properties.sources.items.properties).toHaveProperty('id');expect(evidence.items.required).toContain('criterion');
  expect(JSON.stringify(schema)).not.toMatch(/"(?:oneOf|const)":/);expect(corporateGuide).toContain('"type":"employee.model","employeeId"');
 });
 it('retains named goal and assignment metadata in the pinned provider wire shape without depending on additionalProperties',()=>{
  // Ollama 0.32.13 ToolProperty drops unsupported keywords before rendering tools.
  function wire(schema:any):any{return Object.fromEntries(Object.entries(schema).flatMap(([key,value]):[string,any][]=>{
   if(['type','description','enum','required'].includes(key))return [[key,value]];
   if(key==='properties')return [[key,Object.fromEntries(Object.entries(value as object).map(([name,property])=>[name,wire(property)]))]];
   if(key==='items')return [[key,wire(value)]];if(key==='anyOf')return [[key,(value as any[]).map(wire)]];return [];
  }));}
  const generic=wire(brokerTools.find(tool=>tool.name==='company_command')!.inputSchema).properties.command;
  expect(generic.properties).toBeUndefined();
  const model=generic.anyOf.find((branch:any)=>branch.properties.type.enum[0]==='employee.model'),decision=generic.anyOf.find((branch:any)=>branch.properties.type.enum[0]==='decision.create');
  expect(Object.keys(model.properties)).toEqual(['type','employeeId','modelId','rationale','fallbackModelIds']);expect(model.required).toEqual(['type','employeeId','modelId','rationale']);
  expect(Object.keys(decision.properties)).toEqual(['type','kind','subject','rationale','payload']);expect(decision.required).toEqual(['type','kind','subject','rationale']);
  expect(decision.properties.payload.properties).toMatchObject({positionId:{type:'string'},employeeId:{type:'string'},name:{type:'string'},modelId:{type:'string'}});
  for(const assignmentField of ['artifactId','decisionId','sourceAssignmentId'])expect(decision.properties.payload.properties).not.toHaveProperty(assignmentField);
  for(const strategyField of ['failedRunId','failedAssignmentId','disposition','remainingPrerequisite'])expect(decision.properties.payload.properties[strategyField].type).toBe('string');
  for(const unrelated of ['content','path','environment'])expect(decision.properties).not.toHaveProperty(unrelated);
  const goals=generic.anyOf.find((branch:any)=>branch.properties.type.enum[0]==='product.goal').properties;
  expect(goals.goals.items.anyOf[0]).toEqual({type:'string'});expect(goals.goals.items.anyOf[1]).toMatchObject({type:'object',properties:{outcome:{type:'string'},measure:{type:'string'}}});
  expect(goals.goals.items.anyOf[1].required).toBeUndefined();expect(goals.roadmap.items).toEqual({type:'string'});
  const typed=wire(brokerTools.find(tool=>tool.name==='create_assignment')!.inputSchema).properties.payload;
  expect(typed).toEqual(generic.anyOf.find((branch:any)=>branch.properties.type.enum[0]==='assignment.create').properties.payload);expect(typed.additionalProperties).toBeUndefined();
  expect(Object.keys(typed.properties)).toEqual(['artifactId','decisionId','sourceAssignmentId','pullRequest']);
  expect(typed.properties.pullRequest).toMatchObject({type:'object',required:['number','headSha'],properties:{number:{type:'integer'},headSha:{type:'string'}}});
  for(const key of ['artifactId','sourceAssignmentId','decisionId'])expect(typed.properties[key].type).toBe('string');
  const browser=wire(brokerTools.find(tool=>tool.name==='browser')!.inputSchema).properties.arguments.properties;
  expect(browser.url.type).toBe('string');expect(browser.target.type).toBe('string');expect(browser.ref.type).toBe('string');expect(browser.key.enum).toContain('Tab');expect(browser.action.enum).toEqual(['list','new','close','select']);
  for(const denied of ['filename','modifiers','scale','script'])expect(browser).not.toHaveProperty(denied);
 });
 it('names missing employee.model fields before any state lookup, then preserves model authority and value validation',async()=>{
  const manager=hire('Responsible model manager'),worker=hire('Local implementation employee',manager.id,'worker'),actor=actorFor(manager),before=store.need('employees',worker.id);
  for(const command of [{type:'employee.model'},{type:'employee.model',payload:{employeeId:worker.id,modelId:model,rationale:'Nested incorrectly'}}])await expect(broker.call(actor,'company_command',{command})).rejects.toMatchObject({code:'missing_command_fields',message:expect.stringMatching(/employee.model.*employeeId, modelId, rationale.*beside type.*company_help/)});
  expect(store.need('employees',worker.id)).toEqual(before);expect(store.need('runs',actor.runId).corporateCommands??[]).toEqual([]);
  await expect(broker.call(actor,'company_command',{command:{type:'employee.model',employeeId:worker.id,modelId:'cloud-provider',rationale:'Invalid hosted value'}})).rejects.toThrow(/local|hosted/i);expect(store.need('employees',worker.id)).toEqual(before);
  const other=actorFor(hire('Unrelated model manager'));await expect(broker.call(other,'company_command',{command:{type:'employee.model',employeeId:worker.id,modelId:model,rationale:'Not my employee'}})).rejects.toThrow(/home management/);
  store.put('models',{name:'qwen3.5:4b',local:true,available:true,artifactIdentity:'fixture-small'});
  await broker.call(actor,'company_command',{command:{type:'employee.model',employeeId:worker.id,modelId:'qwen3.5:4b',rationale:'Observed bounded task fit'}});
  expect(store.need('employees',worker.id).modelId).toBe('qwen3.5:4b');expect(store.need('runs',actor.runId).corporateCommands).toHaveLength(1);
 });
 it('preserves explicit nested executive and generic assignment payload extensions while rejecting missing direct fields',async()=>{
  const actor=actorFor(ceo),position=await broker.call(actor,'company_command',{command:{type:'position.create',title:'Scoped product executive',level:'executive',responsibilities:'Own a measured product outcome'}});
  const before=store.list('decisions'),receipts=store.need('runs',actor.runId).corporateCommands;
  await expect(broker.call(actor,'company_command',{command:{type:'decision.create',kind:'executive.appoint',payload:{positionId:position.id,name:'Candidate',modelId:model}}})).rejects.toThrow(/subject, rationale/);
  await expect(broker.call(actor,'company_command',{command:{type:'decision.create',kind:'strategy',subject:'Observed failed attempt',content:'This is not the decision rationale field',path:'diagnosis.md',environment:'local'}})).rejects.toMatchObject({code:'missing_command_fields',message:expect.stringMatching(/decision.create.*rationale.*beside type/)});
  expect(store.list('decisions')).toEqual(before);expect(store.need('runs',actor.runId).corporateCommands).toEqual(receipts);
  const payload={positionId:position.id,name:'Candidate',modelId:model,role:'Own actual product work',observedEvidence:{source:'run:actual-assessment'}};
  const decision=await broker.call(actor,'company_command',{command:{type:'decision.create',kind:'executive.appoint',subject:'Appoint an accountable executive',rationale:'Observed responsibility gap',payload}});
  expect(store.need('decisions',decision.id).payload).toEqual(payload);expect(store.need('decisions',decision.id).status).toBe('pending');
  const assignment=await broker.call(actor,'company_command',{command:{type:'assignment.create',employeeId:ceo.id,title:'Read a retained management record',instructions:'Inspect and report actual evidence',acceptance:['Source-linked finding'],kind:'management',payload:{observedEvidence:{decisionId:decision.id}}}});
  expect(store.need('assignments',assignment.id).payload).toEqual({observedEvidence:{decisionId:decision.id}});
  const assignments=store.list('assignments'),commands=store.need('runs',actor.runId).corporateCommands;
  await expect(broker.call(actor,'company_command',{command:{type:'assignment.create',employeeId:ceo.id,title:'Missing instructions'}})).rejects.toThrow(/instructions, acceptance/);
  expect(store.list('assignments')).toEqual(assignments);expect(store.need('runs',actor.runId).corporateCommands).toEqual(commands);
 });
 it('retains exact strategy failure links and arbitrary metadata despite narrower advertised payloads',async()=>{
  const actor=actorFor(ceo),payload={failedRunId:'observed-failed-run',failedAssignmentId:'preserved-original',disposition:'blocked',remainingPrerequisite:'Actual independent completion evidence is still required',sourceAssignmentId:'retained-extra-trace',observedEvidence:{source:'actual-failure-log'}},command={type:'decision.create',kind:'strategy',subject:'Retain the exact failed-work diagnosis',rationale:'Observed prerequisites remain unmet',payload},unchanged=structuredClone(command);
  const receipt=await broker.call(actor,'company_command',{command});expect(command).toEqual(unchanged);expect(store.need('decisions',receipt.id).payload).toEqual(payload);
  const assignmentPayload={sourceAssignmentId:'preserved-original',observedEvidence:{decisionId:receipt.id}};
  for(const tool of ['company_command','create_assignment']){
   const input={employeeId:ceo.id,title:'Inspect retained evidence',instructions:'Read the actual source and record a scoped finding',acceptance:['Source-linked finding'],kind:'management',payload:assignmentPayload};
   const result=await broker.call(actor,tool,tool==='company_command'?{command:{type:'assignment.create',...input}}:input);expect(store.need('assignments',result.id).payload).toEqual(assignmentPayload);
  }
 });
 it('provides the derived identity effect in decision summaries, initial prompt state and full details without leaking peer votes',async()=>{
  const leader=actorFor(ceo),position=await broker.call(leader,'company_command',{command:{type:'position.create',title:'Delivery executive',level:'executive',responsibilities:'Own actual product delivery'}}),decision=await broker.call(leader,'company_command',{command:{type:'decision.create',kind:'executive.appoint',subject:'New delivery employee',rationale:'Distinct accountable staffing',payload:{positionId:position.id,name:ceo.name,modelId:model}}}),elders=store.list('employees').filter(e=>store.level(e.id)==='elder'),peer=actorFor(elders[0]),reader=actorFor(elders[1]);
  for(const actor of [peer,reader])store.update('assignments',store.need('runs',actor.runId).assignmentId,{kind:'governance',payload:{decisionId:decision.id}});
  await broker.call(peer,'company_command',{command:{type:'decision.vote',decisionId:decision.id,approve:true,rationale:'HIDDEN_PEER_RATIONALE'}});const raw=store.need('decisions',decision.id);
  const summaries=await broker.call(reader,'company_read',{collection:'decisions'}),effect=summaries.items.find((d:any)=>d.id===decision.id).appointmentEffect;expect(effect).toMatchObject({candidateKind:'new_employee',candidateEmployeeId:null,targetPositionId:position.id,derived:true});expect(effect.summary.content).toContain(ceo.id);expect(effect.summary.content).toContain('retains');expect(JSON.stringify(summaries)).not.toContain('HIDDEN_PEER_RATIONALE');
  expect(broker.promptContext(reader).assignedDecision.appointmentEffect.candidateKind).toBe('new_employee');const detail=JSON.parse((await broker.call(reader,'company_detail',{collection:'decisions',id:decision.id})).content);expect(detail.appointmentEffect.sameNameExistingEmployees[0]).toMatchObject({employeeId:ceo.id,positionId:ceo.positionId,identityAndPositionUnchanged:true});expect(store.need('decisions',decision.id)).toEqual(raw);expect(corporateGuide).toContain('names never resolve identity');
 });
 it('retains giant product evidence fully while returning bounded assessments and goals with explicit detail access',async()=>{
  const actor=actorFor(ceo),product=store.list('products')[2],body='RETAINED_REPOSITORY_SOURCE '.repeat(7000),narrative='Measured current repository finding. '.repeat(2000).trim();
  const binding={repository:'fixture/product',issues:[{number:1,body}],files:{'README.md':body}};store.update('products',product.id,{binding});
  const assessment=await broker.call(actor,'company_command',{command:{type:'product.assess',productId:product.id,assessment:narrative,rationale:narrative,priority:2}});
  const goals=[{outcome:narrative,measure:'Canonical verification and reviewed source'}],roadmap=[{title:'Observed next step',evidence:narrative}];
  const goal=await broker.call(actor,'company_command',{command:{type:'product.goal',productId:product.id,goals,roadmap,rationale:narrative}});
  for(const receipt of [assessment,goal]){expect(JSON.stringify(receipt).length).toBeLessThanOrEqual(6000);expect(receipt).toMatchObject({id:product.id,status:'active',priority:2,_receipt:{fullRecord:{collection:'products',id:product.id},omittedFields:['binding']}});expect(receipt.binding).toBeUndefined();expect(JSON.stringify(receipt)).not.toContain('RETAINED_REPOSITORY_SOURCE');expect(receipt.assessment).toMatchObject({truncated:true,totalCharacters:narrative.length});}
  expect(goal.goals).toMatchObject({format:'json',truncated:true});expect(goal.roadmap).toMatchObject({format:'json',truncated:true});
  const retained=store.need('products',product.id);expect(retained).toMatchObject({binding,assessment:narrative,goals,roadmap,rationale:narrative});
  const storedJson=JSON.stringify(retained,null,2),offset=storedJson.indexOf('RETAINED_REPOSITORY_SOURCE');const detail=await broker.call(actor,'company_detail',{...goal._receipt.fullRecord,offset});expect(detail.content).toBe(storedJson.slice(offset,offset+8000));expect(detail.content).toContain('RETAINED_REPOSITORY_SOURCE');
 });
 it('keeps returned position and decision IDs usable and vote booleans intact',async()=>{
  const actor=actorFor(ceo),position=await broker.call(actor,'company_command',{command:{type:'position.create',title:'Delivery executive',level:'executive',responsibilities:'Own the measured delivery outcome'}});
  expect(position.status).toBe('active');expect(position.level).toBe('executive');expect(position.responsibilities).toBe('Own the measured delivery outcome');
  const payload={positionId:position.id,name:'Delivery leader',modelId:model,role:'Own delivery and staffing'};
  const decision=await broker.call(actor,'company_command',{command:{type:'decision.create',kind:'executive.appoint',subject:'Appoint delivery leader',rationale:'An accountable executive is needed',payload}});
  expect(decision).toMatchObject({status:'pending',authorId:ceo.id,runId:actor.runId,payload,policyRevision:store.policy.revision});expect(decision.eligibleElders).toHaveLength(3);
  const detail=await broker.call(actor,'company_detail',decision._receipt.fullRecord);expect(JSON.parse(detail.content).payload.positionId).toBe(position.id);
  const elder=store.need('employees',decision.eligibleElders[0]),elderActor=actorFor(elder),vote=await broker.call(elderActor,'company_command',{command:{type:'decision.vote',decisionId:decision.id,approve:false,rationale:'My independent initial judgment requires narrower scope'}});
  expect(vote).toMatchObject({decisionId:decision.id,employeeId:elder.id,approve:false,phase:'initial',runId:elderActor.runId});expect(store.need('votes',vote.id).approve).toBe(false);
 });
 it('rejects missing or confused command types without guessing or persisting a decision',async()=>{
  const actor=actorFor(ceo),before=store.list('decisions').length;
  for(const command of [undefined,{kind:'executive.appoint',subject:'No type'},{type:'executive.appoint',subject:'Confused type'}])await expect(broker.call(actor,'company_command',{command})).rejects.toThrow(/requires command.type.*"type":"decision.create"/);
  expect(store.list('decisions')).toHaveLength(before);expect(store.need('runs',actor.runId).corporateCommands??[]).toEqual([]);
  const schema:any=brokerTools.find(tool=>tool.name==='company_command')!.inputSchema;for(const branch of schema.properties.command.anyOf)expect(branch.required).toContain('type');const types=schema.properties.command.anyOf.map((branch:any)=>branch.properties.type.enum[0]);expect(types).toContain('decision.create');expect(types).not.toContain('executive.appoint');
  expect(corporateGuide).toContain('"command":{"type":"position.create"');expect(corporateGuide).toContain('"command":{"type":"decision.create","kind":"executive.appoint"');expect(corporateGuide).toContain('"command":{"type":"decision.vote"');
 });
 it('rejects decision-style assignment envelopes with direct-field and acceptance guidance, then accepts the explicit flat command',async()=>{
  const manager=hire('Responsible supervisor'),worker=hire('Implementation employee',manager.id,'worker'),actor=actorFor(manager);
  const project=store.command(owner,{type:'project.create',name:'Bounded product work',productId:store.list('products')[0].id,outcome:'Actual source correction',acceptance:['Reviewed correction'],supervisorId:manager.id,rationale:'Concrete work'});
  const fields={employeeId:worker.id,projectId:project.id,title:'Finite correction',instructions:'Implement the assigned source correction and retain actual checks.',kind:'implementation'},before=store.list('assignments');
  const malformed={type:'assignment.create',payload:{...fields}},unchanged=structuredClone(malformed);
  await expect(broker.call(actor,'company_command',{command:malformed})).rejects.toMatchObject({code:'invalid_assignment_envelope',message:expect.stringMatching(/directly inside command beside type.*not inside command.payload.*acceptance.*nonempty array.*company_help assignment.create/)});
  expect(malformed).toEqual(unchanged);expect(store.list('assignments')).toEqual(before);expect(store.need('runs',actor.runId).corporateCommands??[]).toEqual([]);
  const acceptance=['Source correction committed and canonical verification retained'],created=await broker.call(actor,'company_command',{command:{type:'assignment.create',...fields,acceptance,payload:{sourceAssignmentId:'preserved-original'}}});
  expect(store.need('assignments',created.id)).toMatchObject({...fields,acceptance,supervisorId:manager.id,status:'queued',accepted:true,payload:{sourceAssignmentId:'preserved-original'}});
  expect(store.need('runs',actor.runId).corporateCommands).toEqual([expect.objectContaining({type:'assignment.create',id:created.id})]);
 });
 it('exposes retained vote details only after the reader records an independent initial judgment',async()=>{
  const elders=store.list('employees').filter(e=>store.level(e.id)==='elder'),peer=actorFor(elders[0]),reader=actorFor(elders[1]);
  const decision=store.command(owner,{type:'decision.create',kind:'executive.review',subject:'Evaluate actual leadership',rationale:'Independent evidence review',payload:{employeeId:ceo.id}});
  for(const actor of [peer,reader])store.update('assignments',store.need('runs',actor.runId).assignmentId,{kind:'governance',payload:{decisionId:decision.id}});
  const rationale='PEER_INDEPENDENT_DISSENT based on observed evidence. '.repeat(40).trim(),vote=await broker.call(peer,'company_command',{command:{type:'decision.vote',decisionId:decision.id,approve:false,rationale}});
  expect(vote._receipt.fullRecord).toEqual({collection:'votes',id:vote.id});expect(vote.rationale.truncated).toBe(true);
  expect(JSON.parse((await broker.call(peer,'company_detail',vote._receipt.fullRecord)).content)).toMatchObject({id:vote.id,decisionId:decision.id,approve:false,rationale});
  expect((await broker.call(reader,'company_read',{collection:'votes'})).items).toEqual([]);
  await expect(broker.call(reader,'company_detail',vote._receipt.fullRecord)).rejects.toThrow(/authorized scope/);
  await broker.call(reader,'company_command',{command:{type:'decision.vote',decisionId:decision.id,approve:true,rationale:'My separately formed initial judgment'}});
  const visible=await broker.call(reader,'company_read',{collection:'votes'});expect(visible.items.find((v:any)=>v.id===vote.id)).toMatchObject({decisionId:decision.id,approve:false,phase:'initial'});expect(JSON.stringify(visible).length).toBeLessThanOrEqual(12000);
  expect(JSON.parse((await broker.call(reader,'company_detail',vote._receipt.fullRecord)).content)).toMatchObject({id:vote.id,decisionId:decision.id,approve:false,rationale});
 });
 it('shows finalized vote evidence to the CEO while retaining initial blindness and denying an uninvolved worker',async()=>{
  const ceoActor=actorFor(ceo),workerActor=actorFor(hire('Uninvolved worker',ceo.id,'worker')),elders=store.list('employees').filter(e=>store.level(e.id)==='elder');
  const decision=store.command(ceoActor,{type:'decision.create',kind:'executive.review',subject:'Independent leadership review',rationale:'Evaluate actual outcomes',payload:{employeeId:ceo.id}}),votes:any[]=[];
  for(const elder of elders){
    const elderActor=actorFor(elder),vote=await broker.call(elderActor,'company_command',{command:{type:'decision.vote',decisionId:decision.id,approve:false,rationale:`Observed objection from ${elder.id}`}});votes.push(vote);
    if(votes.length<3){expect((await broker.call(ceoActor,'company_read',{collection:'votes'})).items).toEqual([]);await expect(broker.call(ceoActor,'company_detail',vote._receipt.fullRecord)).rejects.toThrow(/authorized scope/);}
  }
  expect(store.need('decisions',decision.id).status).toBe('rejected');const visible=await broker.call(ceoActor,'company_read',{collection:'votes'});expect(visible.items).toHaveLength(3);expect(visible.items.every((v:any)=>v.approve===false)).toBe(true);
  expect(JSON.parse((await broker.call(ceoActor,'company_detail',votes[0]._receipt.fullRecord)).content)).toMatchObject({id:votes[0].id,approve:false,rationale:`Observed objection from ${elders[0].id}`});
  expect((await broker.call(workerActor,'company_read',{collection:'votes'})).items).toEqual([]);await expect(broker.call(workerActor,'company_detail',votes[0]._receipt.fullRecord)).rejects.toThrow(/authorized scope/);
 });
});

describe('narrative checkpoint provenance',()=>{
 it.each(['company relative','company absolute','project relative','project absolute'])('records an owned %s path with only actual assignment custody',async scenario=>{
  const worker=hire('Narrative author',ceo.id,'worker'),project=scenario.startsWith('project')?store.command(owner,{type:'project.create',name:'Finite research',outcome:'Source-linked finding',acceptance:['Actual researched finding'],supervisorId:ceo.id,rationale:'Fixture'}):undefined;
  const workspace=join(root,'narrative-workspace');mkdirSync(workspace);if(project)project.workspace=workspace;
  const actor=actorFor(worker,project),run=store.update('runs',actor.runId,{workspace}),path=join(workspace,'finding.md'),content='# Actual newly authored finding\n';writeFileSync(path,content);
  const result=await broker.call(actor,'record_artifact',{path:scenario.endsWith('absolute')?path:'finding.md',summary:'Observed finding',projectId:'untrusted-project',assignmentId:'untrusted-assignment',employeeId:'untrusted-author',runId:'untrusted-run'});
  expect(store.need('artifacts',result.id)).toMatchObject({kind:'analysis',projectId:project?.id??null,assignmentId:run.assignmentId,employeeId:worker.id,runId:run.id,uri:realpathSync(path),identity:createHash('sha256').update(content).digest('hex'),checks:[{source:'file-observation',status:'observed',bytes:Buffer.byteLength(content)}]});
 });
 it.each(['absolute outside','relative traversal','relative symlink','absolute symlink'])('denies %s narrative paths without recording an artifact',async scenario=>{
  const actor=actorFor(ceo),workspace=join(root,'narrative-workspace'),outside=join(root,'outside.md');mkdirSync(workspace);writeFileSync(outside,'# Outside assigned workspace\n');symlinkSync(outside,join(workspace,'escape.md'));store.update('runs',actor.runId,{workspace});
  const assignment=store.need('assignments',store.need('runs',actor.runId).assignmentId),path=scenario==='absolute outside'?outside:scenario==='relative traversal'?'../outside.md':scenario==='relative symlink'?'escape.md':join(workspace,'escape.md');
  await expect(broker.call(actor,'record_artifact',{path,summary:'Forbidden file'})).rejects.toMatchObject({code:'path_denied'});
  expect(store.list('artifacts')).toEqual([]);expect(store.need('assignments',assignment.id)).toEqual(assignment);expect(store.need('runs',actor.runId).corporateCommands??[]).toEqual([]);
 });
 it('rejects unchanged tracked baseline and duplicate submissions but records newly authored findings',async()=>{
  const worker=hire('Research specialist',ceo.id,'worker');let project:Project=store.command(owner,{type:'project.create',name:'Evidence checkpoint',productId:store.list('products')[0].id,outcome:'Actual researched correction',acceptance:['Source-linked finding'],supervisorId:ceo.id,rationale:'Fixture'});
  const workspace=join(root,'workspaces',project.id),gitDir=join(root,'repositories','fixture.git');mkdirSync(workspace,{recursive:true});mkdirSync(join(root,'repositories'),{recursive:true});execFileSync('/usr/bin/git',['init','--bare',gitDir],{stdio:'pipe'});writeFileSync(join(workspace,'.git'),`gitdir: ${gitDir}\n`);
  const git=(args:string[])=>execFileSync('/usr/bin/git',['--git-dir',gitDir,'--work-tree',workspace,'-c','user.name=Fixture','-c','user.email=fixture@localhost','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null',...args],{cwd:workspace,env:{PATH:'/usr/bin:/bin',HOME:root,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'},encoding:'utf8'}).trim();
  const baseline='# Existing baseline\n\n';writeFileSync(join(workspace,'README.md'),baseline);git(['add','README.md']);git(['commit','-m','Baseline fixture']);project=store.update('projects',project.id,{workspace,gitDir,baseCommit:git(['rev-parse','HEAD'])});const actor=actorFor(worker,project);
  expect((await broker.call(actor,'company_read',{collection:'projects'})).items.find((item:any)=>item.id===project.id).productId).toBe(project.productId);
  expect(broker.promptContext(actor).projects.items.find((item:any)=>item.id===project.id).productId).toBe(project.productId);
  await expect(broker.call(actor,'record_artifact',{path:'README.md',summary:'Claim existing baseline'})).rejects.toThrow(/unchanged from the product baseline/);expect(store.list('artifacts')).toHaveLength(0);
  writeFileSync(join(workspace,'README.md'),`${baseline}Actual newly investigated finding.\n`);const artifact=await broker.call(actor,'record_artifact',{path:'README.md',summary:'Actual newly investigated finding'});
  expect(store.need('artifacts',artifact.id).baselineIdentity).toBe(createHash('sha256').update(baseline).digest('hex'));
  await expect(broker.call(actor,'record_artifact',{path:'README.md',summary:'Repeat same finding'})).rejects.toThrow(/already recorded/);
  writeFileSync(join(workspace,'findings.md'),'# Separate observed issue\nSource: current repository evidence.\n');const finding=await broker.call(actor,'record_artifact',{path:'findings.md',summary:'Separate observed issue'});expect(finding.kind).toBe('analysis');expect(store.list('artifacts')).toHaveLength(2);
 });
});

describe('typed independent vote tool',()=>{
 function governanceActor(index=0){
  const elder=store.list('employees').filter(e=>store.level(e.id)==='elder')[index],actor=actorFor(elder),decision=store.command(owner,{type:'decision.create',kind:'executive.review',subject:'Evidence-based executive review',rationale:'Inspect actual outcome',payload:{employeeId:ceo.id}});
  store.update('assignments',store.need('runs',actor.runId).assignmentId,{kind:'governance',status:'running',payload:{decisionId:decision.id}});
  return {actor,decision};
 }
 it('advertises concise evidence and voting tools only while the assigned initial vote is pending',async()=>{
  const {actor,decision}=governanceActor(),tools=(await disclosedTools(actor)),names=tools.map(tool=>tool.name);
  for(const name of ['vote_decision','company_help','company_detail','company_read','knowledge_search','repo_read','fetch_public','inspect_artifact'])expect(names).toContain(name);
  for(const name of ['company_command','communicate','propose_executive','create_assignment','commit_work','deliver_product','publish_release'])expect(names).not.toContain(name);
  expect(JSON.stringify(tools).length).toBeLessThan(10000);
  const help=await broker.call(actor,'company_help',{});expect(help.length).toBeLessThan(1600);expect(help).toContain(decision.id);expect(help).toContain('YOUR_BOOLEAN');expect(help).toContain('Source depth remains your responsibility');
  await expect(broker.call(actor,'company_command',{command:{type:'position.create',title:'Premature executive',level:'executive',responsibilities:'Not yet authorized during initial review'}})).rejects.toMatchObject({code:'initial_vote_required'});
  expect(names).not.toContain('create_workplace_event');
  await expect(broker.call(actor,'create_workplace_event',{channelId:'unused',title:'Premature',purpose:'Premature',participantIds:[],scheduledAt:'2030-01-01'})).rejects.toMatchObject({code:'initial_vote_required'});
  expect(names).not.toContain('review_candidate');
  await expect(broker.call(actor,'review_candidate',{candidateId:'unused',approve:false,rationale:'Premature review'})).rejects.toMatchObject({code:'initial_vote_required'});
  const vote=await broker.call(actor,'vote_decision',{decisionId:decision.id,approve:false,rationale:'Independent observed remit gap'});expect(store.need('votes',vote.id).approve).toBe(false);
  expect((await disclosedTools(actor)).map(tool=>tool.name)).toContain('company_command');
  expect((await disclosedTools(actorFor(ceo))).map(tool=>tool.name)).toContain('create_assignment');
 });
 it('advertises required direct voting fields without a wrapper or default judgment',()=>{
  const schema=brokerTools.find(tool=>tool.name==='vote_decision')!.inputSchema;
  expect(schema.required).toEqual(['decisionId','approve','rationale']);expect(schema.additionalProperties).toBe(false);expect(schema.properties.approve).toEqual({type:'boolean'});expect(Object.keys(schema.properties)).toEqual(['decisionId','approve','rationale']);expect(corporateGuide).toContain('Prefer the typed vote_decision tool');
 });
 it('records explicit dissent through the same immutable domain command and keeps peers blind',async()=>{
  const {actor,decision}=governanceActor(),reader=actorFor(store.list('employees').filter(e=>store.level(e.id)==='elder')[2]);store.update('assignments',store.need('runs',reader.runId).assignmentId,{kind:'governance',status:'running',payload:{decisionId:decision.id}});
  const rationale='INDEPENDENT_TYPED_DISSENT: actual evidence requires a narrower remit. '.repeat(80).trim();
  const vote=await broker.call(actor,'vote_decision',{decisionId:decision.id,approve:false,rationale,employeeId:reader.employeeId,runId:reader.runId});
  expect(vote).toMatchObject({employeeId:actor.employeeId,runId:actor.runId,decisionId:decision.id,approve:false,phase:'initial',_receipt:{command:'decision.vote',fullRecord:{collection:'votes'}}});expect(JSON.stringify(vote).length).toBeLessThanOrEqual(6000);expect(store.need('votes',vote.id).rationale).toBe(rationale);
  expect(store.need('runs',actor.runId).corporateCommands.at(-1)).toMatchObject({type:'decision.vote',id:vote.id});expect(store.need('assignments',store.need('runs',actor.runId).assignmentId).status).toBe('completed');
  await expect(broker.call(actor,'vote_decision',{decisionId:decision.id,approve:true,rationale:'Change after initial judgment'})).rejects.toMatchObject({code:'duplicate_vote'});expect(store.need('votes',vote.id).approve).toBe(false);
  expect((await broker.call(reader,'company_read',{collection:'votes'})).items).toEqual([]);await expect(broker.call(reader,'company_detail',vote._receipt.fullRecord)).rejects.toThrow(/authorized scope/);
  // Generic command compatibility remains identical after the typed peer vote.
  await broker.call(reader,'company_command',{command:{type:'decision.vote',decisionId:decision.id,approve:true,rationale:'My independently formed supporting judgment'}});
  expect((await broker.call(reader,'company_read',{collection:'votes'})).items.find((v:any)=>v.id===vote.id)?.approve).toBe(false);expect(JSON.parse((await broker.call(reader,'company_detail',vote._receipt.fullRecord)).content).rationale).toBe(rationale);
 });
 it('permits only the exact assigned initial decision and retains actionable malformed-call guidance',async()=>{
  const {actor,decision}=governanceActor(),other=store.command(owner,{type:'decision.create',kind:'executive.review',subject:'Different review',rationale:'Separate evidence',payload:{employeeId:ceo.id}});
  await expect(broker.call(actor,'vote_decision',{decisionId:other.id,approve:true,rationale:'Wrong assigned decision'})).rejects.toMatchObject({code:'initial_vote_required'});
  await expect(broker.call(actor,'vote_decision',{payload:{decisionId:decision.id,approve:false,rationale:'Wrong wrapper'}})).rejects.toThrow(/Do not nest these fields in payload/);
  await expect(broker.call(actor,'company_command',{command:{type:'decision.vote',payload:{decisionId:decision.id,approve:false,rationale:'Wrong legacy wrapper'}}})).rejects.toThrow(/fields directly inside command/);expect(store.list('votes')).toEqual([]);
 });
 it.each([undefined,null,'true','false',0,1])('does not infer a boolean vote from %s',async approve=>{
  const {actor,decision}=governanceActor();await expect(broker.call(actor,'vote_decision',{decisionId:decision.id,approve,rationale:'Independent reason supplied'})).rejects.toMatchObject({code:'invalid_vote'});expect(store.list('votes')).toEqual([]);expect(store.need('assignments',store.need('runs',actor.runId).assignmentId).status).toBe('running');
 });
 it('requires an actual independent rationale and rejects non-Elder authority regardless of argument claims',async()=>{
  const {actor,decision}=governanceActor();await expect(broker.call(actor,'vote_decision',{decisionId:decision.id,approve:true})).rejects.toThrow(/Independent rationale/);
  const executiveActor=actorFor(ceo);await expect(broker.call(executiveActor,'vote_decision',{decisionId:decision.id,approve:true,rationale:'Unauthorized vote',actor,employeeId:actor.employeeId})).rejects.toMatchObject({code:'elder_required'});expect(store.list('votes')).toEqual([]);
 });
});


it('rejects silently ignored exact-record selectors with the correct detail tool guidance',async()=>{
 const actor=actorFor(ceo);await expect(broker.call(actor,'company_read',{collection:'decisions',id:'exact-decision',view:'content'})).rejects.toMatchObject({code:'detail_tool_required'});await expect(broker.call(actor,'company_read',{collection:'decisions',id:'exact-decision'})).rejects.toThrow(/company_detail.*exact-decision/);
});

it('keeps company knowledge when a private or irrelevant correction names it',()=>{
 const actor=actorFor(ceo),worker=hire('Scoped specialist',ceo.id,'worker');
 const original=store.command(owner,{type:'knowledge.write',scope:'company',content:'RETAIN_COMPANY_LESSON',source:'observed source'});
 store.command(owner,{type:'knowledge.write',scope:'employees',scopeId:worker.id,content:'PRIVATE_CORRECTION',source:'other source',supersedes:original.id});
 expect(broker.knowledgeContext(actor,[],20000).some(note=>note.id===original.id)).toBe(true);
 expect(broker.knowledgeContext(actor,[worker.id],20000).some(note=>note.id===original.id)).toBe(true);
 const replacement=store.command(owner,{type:'knowledge.write',scope:'company',content:'APPLICABLE_COMPANY_CORRECTION',source:'corrected source',supersedes:original.id});
 const notes=broker.knowledgeContext(actor,[],20000);expect(notes.some(note=>note.id===original.id)).toBe(false);expect(notes.some(note=>note.id===replacement.id)).toBe(true);
});

describe('focused executive formation tools',()=>{
 function formation(){const actor=actorFor(ceo);store.update('assignments',store.need('runs',actor.runId).assignmentId,{schedulerKey:'formation:office:Chief Technology Officer'});return actor;}
 it('advertises concise task-specific proposal tools while keeping ordinary tools unchanged',async()=>{
  const actor=formation(),tools=(await disclosedTools(actor)),names=tools.map(tool=>tool.name);expect(names).toContain('propose_executive');expect(names).not.toContain('communicate');expect(names).toContain('repo_read');
  expect(JSON.stringify(tools).length).toBeLessThan(14000);const command=tools.find(tool=>tool.name==='company_command')!;expect(JSON.stringify(command)).not.toContain('employee.hire');
  const help=await broker.call(actor,'company_help',{});expect(help.length).toBeLessThan(2000);expect(help).toContain('propose_executive');
  expect((await disclosedTools(actorFor(hire('Ordinary manager')))).map(tool=>tool.name)).toContain('create_assignment');
 });
 it('records a real proposal checkpoint without appointing or voting for Elders',async()=>{
  const actor=formation(),position=store.command(owner,{type:'position.create',title:'Chief Technology Officer',level:'executive',responsibilities:'Own engineering delivery'}),before=store.list('employees').length;
  const proposal=await broker.call(actor,'propose_executive',{positionId:position.id,subject:'Appoint CTO',rationale:'Own the required engineering remit',name:'Chosen candidate',modelId:model,role:'Lead the engineering remit and authorized hiring.'});
  expect(proposal.status).toBe('pending');expect(proposal.kind).toBe('executive.appoint');expect(store.list('employees')).toHaveLength(before);expect(store.list('votes')).toHaveLength(0);
  const run=store.need('runs',actor.runId),assignment=store.need('assignments',run.assignmentId);expect(formationOutcome(store,assignment,run).passed).toBe(true);
 });
 it('retains proposal authority and rejects arbitrary decision kinds or malformed wrappers',async()=>{
  const position=store.command(owner,{type:'position.create',title:'Chief Technology Officer',level:'executive',responsibilities:'Engineering'}),worker=actorFor(hire('Worker',ceo.id,'worker'));
  const input={positionId:position.id,subject:'Appoint CTO',rationale:'Role need',name:'Candidate',modelId:model,role:'Own engineering'};
  await expect(broker.call(worker,'propose_executive',input)).rejects.toThrow();
  const actor=formation();await expect(broker.call(actor,'propose_executive',{...input,kind:'executive.dismiss'})).rejects.toThrow(/no wrapper or authority/);
  await expect(broker.call(actor,'propose_executive',{command:input})).rejects.toThrow(/no wrapper or authority/);
  for(const employeeId of [1,''])await expect(broker.call(actor,'propose_executive',{positionId:position.id,subject:'Appoint',rationale:'Need',employeeId})).rejects.toThrow(/no wrapper or authority/);expect(store.list('decisions')).toHaveLength(0);
 });
});

it.each(['pending','approved','rejected'])('reuses a retained %s executive proposal on resumed office work through both entrypoints',async status=>{
 const actor=actorFor(ceo),assignmentId=store.need('runs',actor.runId).assignmentId;store.update('assignments',assignmentId,{schedulerKey:'formation:office:Chief Technology Officer'});
 const position=store.command(owner,{type:'position.create',title:'Chief Technology Officer',level:'executive',responsibilities:'Engineering'});
 const input={positionId:position.id,subject:'Appoint CTO',rationale:'Required remit',name:'Original choice',modelId:model,role:'Own engineering'};
 const first=await broker.call(actor,'propose_executive',input);store.update('decisions',first.id,{status});
 const old=store.need('runs',actor.runId);store.update('runs',old.id,{status:'interrupted',tokenRevoked:true});
 const resumed=store.put('runs',{...old,id:randomUUID(),sessionId:randomUUID(),status:'running',tokenRevoked:false}),resumedActor={...actor,runId:resumed.id};
 const retained=store.need('decisions',first.id),employees=store.list('employees').length;
 const direct=await broker.call(resumedActor,'propose_executive',{...input,name:'Different candidate'});
 const generic=await broker.call(resumedActor,'company_command',{command:{type:'decision.create',kind:'executive.appoint',subject:'Different proposal',rationale:'Changed choice',payload:{positionId:position.id,employeeId:ceo.id}}});
 for(const receipt of [direct,generic]){expect(receipt.id).toBe(first.id);expect(receipt.reused).toBe(true);expect(receipt.requestApplied).toBe(false);expect(receipt.retainedProposal.runId).toBe(old.id);}
 expect(store.list('decisions')).toHaveLength(1);expect(store.need('decisions',first.id)).toEqual(retained);expect(store.list('employees')).toHaveLength(employees);expect(store.list('votes')).toHaveLength(0);
 expect(store.need('runs',resumed.id).corporateCommands).toEqual(old.corporateCommands);
 if(status==='rejected'){const correction=actorFor(ceo);store.update('assignments',store.need('runs',correction.runId).assignmentId,{schedulerKey:`appointment-rejected:${first.id}`});
  const revised=await broker.call(correction,'propose_executive',{...input,name:'Revised choice'});expect(revised.id).not.toBe(first.id);expect(revised.status).toBe('pending');expect(store.list('decisions')).toHaveLength(2);}
});

it('recruitment receipts identify the actual readable record through candidate revision and onboarding',async()=>{
 const manager=actorFor(ceo),employee=hire('Recruitment Officer',ceo.id,'worker'),recruiter=actorFor(employee);
 const department=store.command(owner,{type:'department.create',name:'Candidate department',managerId:ceo.id,responsibilities:'Scoped staffing'});
 const position=store.command(owner,{type:'position.create',title:'Specialist',level:'worker',departmentId:department.id,responsibilities:'Useful local work'});
 const call=async(actor:Extract<Actor,{kind:'employee'}>,command:any,collection:string)=>{
  const stages:Record<string,string>={'recruitment.request':'request','recruitment.candidate':'candidate','recruitment.approve':'approve','recruitment.reject':'approve','recruitment.provision':'provision','recruitment.onboard':'onboard'};
  store.update('assignments',store.need('runs',actor.runId).assignmentId,{schedulerKey:`formation:${stages[command.type]}:${command.requisitionId??command.candidateId??command.employeeId??command.positionId}`,payload:{formation:true}});
  if(command.type==='recruitment.provision'){const packet=broker.provisionPrompt(actor)!;expect(packet).toBeDefined();const tools=broker.toolsFor(actor);expect(tools.map(t=>t.name)).not.toContain('browser');expect(tools.map(t=>t.name)).not.toContain('repo_read');expect(tools.map(t=>t.name)).toEqual(expect.arrayContaining(['company_detail','company_read','company_help','skill_read','knowledge_search','send_message']));expect(packet.prompt).toContain(command.candidateId);expect(packet.system).toContain('zero unapproved spending');expect(packet.system.length+packet.prompt.length+JSON.stringify(tools).length).toBeLessThan(11000);}
  const schema=(await disclosedTools(actor)).find(t=>t.name==='company_command')!.inputSchema.properties.command;
  expect(schema.anyOf.some((branch:any)=>branch.properties.type.enum[0]===command.type)).toBe(true);
  const result=await broker.call(actor,'company_command',{command});
  expect(result._receipt.fullRecord).toEqual({collection,id:result.id});
  await expect(broker.call(actor,'company_detail',result._receipt.fullRecord)).resolves.toBeDefined();return result;
 };
 const req=await call(manager,{type:'recruitment.request',positionId:position.id,homeManagerId:ceo.id,recruiterId:employee.id,brief:'Local source adaptation',firstWork:'Inspect relevant requests'},'experiences');
 const source=store.put('experiences',{id:'a'.repeat(64),kind:'skill-source'}),sourceBody='---\nlicense: MIT\n---\nUseful source',sourceLicense='MIT License\nPermission is hereby granted, free of charge',sourceDirectory=join(root,'skills','vendor',source.id);mkdirSync(sourceDirectory,{recursive:true});writeFileSync(join(sourceDirectory,'SOURCE.md'),sourceBody);writeFileSync(join(sourceDirectory,'LICENSE'),sourceLicense);Object.assign(source,store.update('experiences',source.id,{sourcePath:join(sourceDirectory,'SOURCE.md'),sha256:createHash('sha256').update(sourceBody).digest('hex'),licenseHash:createHash('sha256').update(sourceLicense).digest('hex')}));
 store.update('runs',recruiter.runId,{skillInspections:{[source.id]:{sha256:source.sha256,ranges:[[0,10]],complete:true}}});
 const command={type:'recruitment.candidate',requisitionId:req.id,name:'Tailored specialist',role:'Perform scoped local research',modelId:model,competencies:['Research'],sourceIds:[source.id],adaptation:'Local tools only',onboarding:'Inspect actual requests'};
 const candidate=await call(recruiter,command,'experiences');
 await call(manager,{type:'recruitment.reject',candidateId:candidate.id,rationale:'Clarify request evidence'},'experiences');
 await call(recruiter,{...command,role:'Research retained request evidence'},'experiences');
 await call(manager,{type:'recruitment.approve',candidateId:candidate.id,rationale:'Matches approved remit'},'experiences');
 const hired=await call(recruiter,{type:'recruitment.provision',candidateId:candidate.id},'employees');
 expect(hired.id).not.toBe(candidate.id);
 await call(manager,{type:'recruitment.onboard',employeeId:hired.id,rationale:'Role and standby understood',standbyCondition:'Await an actual request'},'employees');
});

it('decision list distinguishes approved judgment from blocked application',()=>{
 const actor=actorFor(ceo),application={status:'blocked',error:'Position is already occupied'};
 const decision=store.put('decisions',{kind:'executive.appoint',status:'approved',subject:'Retained majority judgment',authorId:ceo.id,application});
 const page=broker.companyRead(actor,{collection:'decisions'});
 expect(page.items.find((item:any)=>item.id===decision.id)).toMatchObject({status:'approved',application});
});

it('keeps Owner-override application corrections and descendants blind to an unvoted Elder',async()=>{
 const elder=store.list('employees').find(e=>store.level(e.id)==='elder')!,reader=actorFor(elder),executive=actorFor(ceo);
 const decision=store.command(owner,{type:'decision.create',kind:'executive.review',subject:'Actual leadership review',rationale:'Inspect retained evidence',payload:{employeeId:ceo.id}});
 store.command(owner,{type:'decision.override',decisionId:decision.id,approve:true,rationale:'Owner judgment before remaining initial votes'});
 const secret='PRIVATE_APPLICATION_OUTCOME',correction=actorFor(ceo),child=actorFor(ceo),correctionId=store.need('runs',correction.runId).assignmentId,childId=store.need('runs',child.runId).assignmentId;
 store.update('assignments',correctionId,{schedulerKey:`governance-application:${decision.id}`,instructions:secret,payload:{sourceDecisionId:decision.id}});
 store.update('assignments',childId,{schedulerKey:`responsibility:${correctionId}`,instructions:secret,payload:{sourceAssignmentId:correctionId}});
 store.update('runs',correction.runId,{text:secret});store.update('runs',child.runId,{text:secret});
 const note=store.command(child,{type:'knowledge.write',scope:'company',title:'Application correction evidence',content:secret,source:`decision:${decision.id}`});
 for(const collection of ['assignments','runs','knowledge'])expect(JSON.stringify(await broker.call(reader,'company_read',{collection,limit:30}))).not.toContain(secret);
 for(const [collection,id] of [['assignments',correctionId],['assignments',childId],['runs',correction.runId],['runs',child.runId],['knowledge',note.id]]){
  await expect(broker.call(reader,'company_detail',{collection,id})).rejects.toThrow(/authorized scope/);
  expect((await broker.call(executive,'company_detail',{collection,id})).content).toContain(secret);
 }
 expect(JSON.stringify(broker.knowledgeContext(reader,[ceo.id]))).not.toContain(secret);
 expect(store.snapshot(owner).assignments.find(a=>a.id===correctionId)?.instructions).toBe(secret);
 expect(store.snapshot(owner).runs.find(r=>r.id===child.runId)?.text).toBe(secret);
 expect(store.snapshot(owner).knowledge.some(k=>k.id===note.id)).toBe(true);
});

it.each(['appointment-rejected','governance-application'])('scopes %s correction help and tools while retaining evidence and decision authority',async kind=>{
 const actor=actorFor(ceo),source=store.put('decisions',{kind:'executive.appoint',status:kind==='appointment-rejected'?'rejected':'approved',subject:'Retained original proposal',authorId:ceo.id,payload:{}});
 const elders=store.list('employees').filter(e=>store.level(e.id)==='elder');store.update('decisions',source.id,{eligibleElders:elders.map(e=>e.id),...(kind==='governance-application'?{application:{status:'blocked',code:'occupied_position',message:'Fixture occupied position'}}:{})});
 const votes=elders.map(elder=>store.put('votes',{decisionId:source.id,employeeId:elder.id,phase:'initial',approve:kind==='governance-application',rationale:'Fixture retained judgment'})),vote=votes[0],voteIds=votes.map(v=>v.id);
 const link=kind==='appointment-rejected'?'rejectedDecisionId':'sourceDecisionId',taskId=store.need('runs',actor.runId).assignmentId;
 store.update('assignments',taskId,{schedulerKey:`${kind}:${source.id}`,payload:{[link]:source.id,voteIds}});
 const tools=(await disclosedTools(actor)),names=tools.map(tool=>tool.name),schema=tools.find(tool=>tool.name==='company_command')!.inputSchema.properties.command;
 for(const name of ['company_read','company_detail','knowledge_search','repo_inspect','repo_read','repo_pr','repo_issue','fetch_public','browser','inspect_artifact','skill_read'])expect(names).toContain(name);
 for(const name of ['propose_executive','communicate','vote_decision','create_assignment','deliver_product','commit_work'])expect(names).not.toContain(name);
 expect(schema.anyOf.map((branch:any)=>branch.properties.type.enum[0])).toEqual(['owner.request','responsibility.update','position.create','decision.create']);
 const help=await broker.call(actor,'company_help',{});expect(help.length).toBeLessThan(2400);expect(help).toContain(source.id);expect(help).toContain(vote.id);expect(help).toContain(link);expect(help).toContain('reviewedVoteIds');expect(help).toContain('"withdrawn"');expect(help).not.toContain('propose_executive');
 await expect(broker.call(actor,'company_detail',{collection:'decisions',id:source.id})).resolves.toBeDefined();await expect(broker.call(actor,'company_detail',{collection:'votes',id:vote.id})).resolves.toBeDefined();
 const command={type:'decision.create',kind:'strategy',subject:'Withdraw unnecessary operation',rationale:'The underlying operation is unnecessary after reviewing retained evidence',payload:{[link]:source.id,reviewedVoteIds:voteIds,disposition:'withdrawn'}};
 const receipt=await broker.call(actor,'company_command',{command});expect(store.need('decisions',receipt.id).payload).toEqual(command.payload);
 expect(managementOutcome(store,store.need('assignments',taskId),store.need('runs',actor.runId)).passed).toBe(true);
 const worker=actorFor(hire('Unprivileged correction worker',ceo.id,'worker'));store.update('assignments',store.need('runs',worker.runId).assignmentId,{schedulerKey:`${kind}:${source.id}`,payload:{[link]:source.id,voteIds}});
 await expect(broker.call(worker,'company_command',{command:{type:'decision.create',kind:'executive.appoint',subject:'Unauthorized appointment',rationale:'No executive authority',payload:{}}})).rejects.toThrow();
 expect(withoutDescriptions((await disclosedTools(actorFor(ceo))))).toEqual(withoutDescriptions(brokerTools.filter(tool=>!['revise_and_retry_assignment','resolve_ruby_dependencies','commit_work','verify_product','deliver_product','communicate','prepare_preview','prepare_release','publish_release','inspect_artifact','review_work','import_pull_request'].includes(tool.name))));
});

it('scopes department formation to charter and position commands with a real resumable checkpoint',async()=>{
 const executivePosition=store.put('positions',{title:'Chief Technology Officer',level:'executive',status:'active'});
 const executive=store.put('employees',{name:'Formation executive',positionId:executivePosition.id,homeManagerId:ceo.id,status:'active',role:'Own engineering',modelId:model}),actor=actorFor(executive);
 const taskId=store.need('runs',actor.runId).assignmentId;store.update('assignments',taskId,{schedulerKey:'formation:department:Web Engineering'});
 const tools=(await disclosedTools(actor)),names=tools.map(t=>t.name),schema=tools.find(t=>t.name==='company_command')!.inputSchema.properties.command;
 expect(schema.anyOf.map((b:any)=>b.properties.type.enum[0])).toEqual(['owner.request','responsibility.update','department.update','position.update','department.create','position.create']);
 for(const name of ['company_read','company_detail','knowledge_search','repo_read','repo_issue','repo_pr','fetch_public','browser','inspect_artifact','skill_discover','skill_import','skill_read'])expect(names).toContain(name);
 for(const name of ['propose_executive','create_assignment','communicate','commit_work','deliver_product'])expect(names).not.toContain(name);
 const update=schema.anyOf.find((b:any)=>b.properties.type.enum[0]==='department.update'),position=schema.anyOf.find((b:any)=>b.properties.type.enum[0]==='position.create');
 for(const field of ['departmentId','rationale','charter','helpPolicy','standingDuties','relatedDepartmentIds'])expect(update.properties).toHaveProperty(field);
 expect(position.required).toEqual(expect.arrayContaining(['title','level','responsibilities']));expect(position.properties).toHaveProperty('departmentId');
 const help=await broker.call(actor,'company_help',{});expect(help.length).toBeLessThan(2200);expect(help).toContain('Web Engineering');expect(help).toContain('resume an existing partial department');expect(help).toContain('does not hire employees');
 const call=(command:any)=>broker.call(actor,'company_command',{command});
 const department=await call({type:'department.create',name:'Web Engineering',responsibilities:'Own useful web products'});
 const lead=await call({type:'position.create',title:'Web lead',level:'lead',departmentId:department.id,responsibilities:'Manage web delivery'});
 const outcome=()=>formationOutcome(store,store.need('assignments',taskId),store.need('runs',actor.runId)).passed;
 expect(outcome()).toBe(false);await expect(broker.call(actor,'company_detail',{collection:'departments',id:department.id})).resolves.toBeDefined();
 await call({type:'department.update',departmentId:department.id,rationale:'Resume the retained partial department',charter:'Useful portfolio web outcomes',helpPolicy:'Ask architecture for cross-product decisions',standingDuties:[{name:'Web quality',instructions:'Inspect actual website needs',intervalHours:24}]});
 for(const title of ['Web frontend','Web accessibility']){const mistaken=await call({type:'position.create',title,level:'manager',departmentId:department.id,responsibilities:title});expect(outcome()).toBe(false);const repaired=await call({type:'position.update',positionId:mistaken.id,level:'worker',rationale:'Correct unfilled specialist level'});expect(repaired.id).toBe(mistaken.id);}
 expect(outcome()).toBe(true);expect(store.list('positions').filter(p=>p.id===lead.id)).toHaveLength(1);expect(store.list('departments')).toHaveLength(1);expect(store.list('employees')).toHaveLength(5);
 const outsider=actorFor(hire('Other manager'));await expect(broker.call(outsider,'company_command',{command:{type:'department.update',departmentId:department.id,rationale:'Outside scope',charter:'Unauthorized'}})).rejects.toThrow();
 store.update('assignments',taskId,{schedulerKey:'duty:department:0'});expect(withoutDescriptions((await disclosedTools(actor)))).toEqual(withoutDescriptions(brokerTools.filter(tool=>!['revise_and_retry_assignment','resolve_ruby_dependencies','commit_work','verify_product','deliver_product','communicate','prepare_preview','prepare_release','publish_release','inspect_artifact','review_work','import_pull_request'].includes(tool.name))));expect(await broker.call(actor,'company_help',{})).toBe(corporateGuide);
});

it.each([
 ['recruiter-bootstrap',['position.create','employee.hire']],['request',['recruitment.request']],['candidate',['recruitment.candidate']],['approve',['recruitment.approve','recruitment.reject']],['provision',['recruitment.provision','message.send']],['onboard',['assignment.create','recruitment.onboard','department.update','employee.reassign']],
] as const)('advertises only the %s recruitment stage and its evidence tools',async(stage,commands)=>{
 const actor=actorFor(ceo);store.update('assignments',store.need('runs',actor.runId).assignmentId,{schedulerKey:`formation:${stage}:assigned-record:1`});
 const tools=(await disclosedTools(actor)),names=tools.map(t=>t.name),schema=tools.find(t=>t.name==='company_command')!.inputSchema.properties.command;
 expect(schema.anyOf.map((b:any)=>b.properties.type.enum[0]).sort()).toEqual([...commands,'responsibility.update','owner.request'].sort());
 for(const name of ['company_read','company_detail','knowledge_search','repo_inspect','repo_read','repo_pr','repo_issue','fetch_public','browser','inspect_artifact','skill_read'])expect(names).toContain(name);
 for(const name of ['communicate','propose_executive','vote_decision','deliver_product','commit_work'])expect(names).not.toContain(name);
 expect(names.includes('create_assignment')).toBe(stage==='onboard');
 expect(names.includes('skill_discover')).toBe(['recruiter-bootstrap','candidate'].includes(stage));expect(names.includes('skill_import')).toBe(['recruiter-bootstrap','candidate'].includes(stage));
 const help=await broker.call(actor,'company_help',{});expect(help.length).toBeLessThan(stage==='onboard'?2900:2200);expect(help).toContain('company_command');expect(help).toContain('existing authority');
 if(stage!=='recruiter-bootstrap')expect(help).toContain('assigned-record');
 if(stage==='candidate'){expect(help).toContain('inspectionComplete');expect(help).toContain('not catalog IDs');expect(help).toContain('query:actual pertinent competency');}
 if(stage==='approve')expect(help).toContain('your own hiring judgment');
 if(stage==='provision')expect(help).toContain('manager approval');
 if(stage==='onboard')expect(help).toContain('actually be accepted');
});

it('recruitment help resumes actual same-run inspections and targeted staffing without inventing work',async()=>{
 const actor=actorFor(ceo),run=store.need('runs',actor.runId);
 store.update('assignments',run.assignmentId,{schedulerKey:'formation:recruiter-bootstrap'});
 const department=store.command(owner,{type:'department.create',name:'Recruitment & Workforce Planning',managerId:ceo.id,responsibilities:'Source employees'});
 const position=store.command(owner,{type:'position.create',title:'Recruitment Officer',level:'worker',departmentId:department.id,responsibilities:'Adapt sourced roles'});
 const sourceId='a'.repeat(64),sha256='b'.repeat(64);store.put('experiences',{id:sourceId,kind:'skill-source',sha256,repository:'fixture/roles',commit:'c'.repeat(40)});
 store.update('runs',run.id,{skillInspections:{[sourceId]:{sha256,complete:true,ranges:[[0,100]]}}});
 const first=await broker.call(actor,'company_help',{});expect(first).toContain('inspection survives native compaction');expect(first).toContain(sourceId);expect(first).toContain('"inspectionComplete":true');expect(first).toContain(position.id);expect(first).toContain('"visibleHires":[]');expect(first.length).toBeLessThan(4000);
 const employee=store.command(owner,{type:'employee.hire',name:'Fixture actual hire',positionId:position.id,homeManagerId:ceo.id,modelId:model,role:'Fixture independently authored role'});
 const after=await broker.call(actor,'company_help',{});expect(after).toContain(employee.id);expect(after).not.toContain(employee.role);
 store.update('experiences',sourceId,{sha256:'d'.repeat(64)});expect(await broker.call(actor,'company_help',{})).toContain('"inspectionComplete":false');
 const nextActor=actorFor(ceo);store.update('assignments',store.need('runs',nextActor.runId).assignmentId,{schedulerKey:'formation:recruiter-bootstrap'});
 expect(await broker.call(nextActor,'company_help',{})).toContain('"sourceCount":0');
});

it('focuses bootstrap initial context on its target and inspections while full evidence remains readable',async()=>{
 const actor=actorFor(ceo),run=store.need('runs',actor.runId);store.update('assignments',run.assignmentId,{schedulerKey:'formation:recruiter-bootstrap'});
 const department=store.command(owner,{type:'department.create',name:'Recruitment & Workforce Planning',managerId:ceo.id,responsibilities:'Actual recruitment'});
 const position=store.command(owner,{type:'position.create',title:'Recruitment Officer',level:'worker',departmentId:department.id,responsibilities:'Adapt local profiles'});
 const source=store.put('experiences',{kind:'skill-source',repository:'fixture/roles',commit:'a'.repeat(40),sha256:'b'.repeat(64),upstreamPath:'recruitment.md',runId:run.id});
 store.update('runs',run.id,{skillInspections:{[source.id]:{sha256:source.sha256,complete:true,ranges:[[0,10]]}}});
 const unrelated=store.command(owner,{type:'assignment.create',employeeId:ceo.id,title:'OLD_BRAKEMAN_ASSIGNMENT',instructions:'Unrelated product history',acceptance:['Legacy'],kind:'management'});
 const alert=store.put('attention',{kind:'runtime',status:'open',title:'MISROUTED_COMPLETION_ALERT',detail:'Unrelated completed work'});
 for(let i=0;i<12;i++)store.command(owner,{type:'department.create',name:`Unrelated department ${i}`,managerId:ceo.id,responsibilities:'Other remit'});
 const context=broker.promptContext(actor),serialized=JSON.stringify(context);
 expect(serialized.length).toBeLessThanOrEqual(12000);expect(context.assignment.id).toBe(run.assignmentId);expect(context.employee.id).toBe(ceo.id);expect(context.target.departmentId).toBe(department.id);expect(context.target.positionId).toBe(position.id);
 expect(context.positions.items.some((p:any)=>p.id===position.id)).toBe(true);expect(context.sourceInspections.items).toContainEqual({sourceId:source.id,sha256:source.sha256,inspectionComplete:true});
 expect(context.models.items.some((m:any)=>m.name===model)).toBe(true);expect(serialized).not.toContain('OLD_BRAKEMAN_ASSIGNMENT');expect(serialized).not.toContain('MISROUTED_COMPLETION_ALERT');expect(serialized).not.toContain('Unrelated department');
 await expect(broker.call(actor,'company_detail',{collection:'assignments',id:unrelated.id})).resolves.toBeDefined();await expect(broker.call(actor,'company_detail',{collection:'attention',id:alert.id})).resolves.toBeDefined();
});

it('retains exact recruitment targets and office evidence rather than the newest unrelated records',()=>{
 const actor=actorFor(ceo),run=store.need('runs',actor.runId),department=store.command(owner,{type:'department.create',name:'Web Engineering',managerId:ceo.id,responsibilities:'Web outcomes'}),position=store.command(owner,{type:'position.create',title:'Web specialist',level:'worker',departmentId:department.id,responsibilities:'Useful web work'});
 const source=store.put('experiences',{kind:'skill-source',sha256:'sourcehash'}),req=store.put('experiences',{kind:'requisition',positionId:position.id,departmentId:department.id,homeManagerId:ceo.id,recruiterId:ceo.id}),candidate=store.put('experiences',{kind:'candidate',requisitionId:req.id,departmentId:department.id,sourceIds:[source.id],role:'Tailored role'});
 for(let i=0;i<15;i++)store.put('experiences',{kind:'candidate',role:`UNRELATED_CANDIDATE_${i}`});
 for(const [stage,id] of [['request',position.id],['candidate',req.id],['approve',candidate.id],['provision',candidate.id]]){
  store.update('assignments',run.assignmentId,{schedulerKey:`formation:${stage}:${id}`});const context=broker.promptContext(actor);
  expect(context.target.positionId).toBe(position.id);expect(context.target.departmentId).toBe(department.id);expect(context.experiences.items.some((r:any)=>r.id===req.id)).toBe(true);expect(JSON.stringify(context)).not.toContain('UNRELATED_CANDIDATE');
  if(stage!=='request'){expect(context.target.candidateId).toBe(candidate.id);expect(context.experiences.items.some((r:any)=>r.id===source.id)).toBe(true);}
 }
 const office=store.put('positions',{title:'Chief Product Officer',level:'executive',status:'active'}),decision=store.put('decisions',{kind:'executive.appoint',status:'pending',payload:{positionId:office.id},subject:'LINKED_OFFICE_PROPOSAL'});
 store.put('decisions',{kind:'strategy',status:'recorded',subject:'UNRELATED_NEW_DECISION'});store.update('assignments',run.assignmentId,{schedulerKey:'formation:office:Chief Product Officer'});
 const context=broker.promptContext(actor);expect(context.target.positionId).toBe(office.id);expect(context.decisions.items.some((d:any)=>d.id===decision.id)).toBe(true);expect(JSON.stringify(context)).not.toContain('UNRELATED_NEW_DECISION');
});

it('formation context cannot bypass blind governance evidence',()=>{
 const elders=store.list('employees').filter(e=>store.level(e.id)==='elder'),peer=actorFor(elders[0]),reader=actorFor(elders[1]),position=store.put('positions',{title:'Chief Product Officer',level:'executive',status:'active'});
 const decision=store.command(owner,{type:'decision.create',kind:'executive.appoint',subject:'Actual proposal',rationale:'Real role',payload:{positionId:position.id,name:'Candidate',modelId:model,role:'Product remit'}});
 store.update('assignments',store.need('runs',peer.runId).assignmentId,{kind:'governance',payload:{decisionId:decision.id}});store.command(peer,{type:'decision.vote',decisionId:decision.id,approve:false,rationale:'PRIVATE_INITIAL_JUDGMENT'});
 store.update('decisions',decision.id,{application:{status:'blocked',message:'PRIVATE_INITIAL_JUDGMENT'}});store.update('runs',peer.runId,{text:'PRIVATE_INITIAL_JUDGMENT'});
 store.update('assignments',store.need('runs',reader.runId).assignmentId,{schedulerKey:'formation:office:Chief Product Officer'});
 const context=broker.promptContext(reader);expect(context.decisions.items.find((d:any)=>d.id===decision.id).status).toBe('awaiting_your_independent_vote');expect(JSON.stringify(context)).not.toContain('PRIVATE_INITIAL_JUDGMENT');
});

it('candidate corrections surface only nearest historical source metadata without selecting or inspecting it',async()=>{
 const actor=actorFor(ceo),run=store.need('runs',actor.runId),department=store.command(owner,{type:'department.create',name:'Recruitment correction fixture',managerId:ceo.id,responsibilities:'Useful recruitment'}),position=store.command(owner,{type:'position.create',title:'Workforce lead',level:'lead',departmentId:department.id,responsibilities:'Own workforce planning'});
 const req=store.command(owner,{type:'recruitment.request',positionId:position.id,homeManagerId:ceo.id,recruiterId:ceo.id,brief:'Tailored workforce role',firstWork:'Inspect actual workforce needs'});
 const source=(path:string)=>store.put('experiences',{kind:'skill-source',repository:'fixture/skills',commit:'a'.repeat(40),upstreamPath:path,sha256:path});
 const current=source('talent-acquisition/SKILL.md'),previous=source('workforce-planning/SKILL.md'),older=source('OLDER_UNRELATED_SOURCE.md');
 const candidate=store.put('experiences',{kind:'candidate',status:'changes_requested',version:3,requisitionId:req.id,departmentId:department.id,sourceIds:[current.id],role:'Current tailored role',history:[{version:1,sourceIds:[older.id]},{version:2,sourceIds:[previous.id,'missing-source-id']}]});
 store.update('assignments',run.assignmentId,{schedulerKey:`formation:candidate:${req.id}:3`});
 const before=store.need('runs',run.id),context=broker.promptContext(actor);
 expect(context.historicalSourceReferences).toMatchObject({candidateId:candidate.id,version:2,sourceIds:[previous.id]});expect(context.historicalSourceReferences.note).toContain('not current source selections or completed inspections');
 expect(context.experiences.items.map((r:any)=>r.id)).toEqual(expect.arrayContaining([candidate.id,current.id,previous.id]));expect(JSON.stringify(context)).not.toContain('OLDER_UNRELATED_SOURCE');expect(JSON.stringify(context)).not.toContain('missing-source-id');
 expect(context.sourceInspections.items).toEqual([]);expect(store.need('runs',run.id)).toEqual(before);expect(store.need('experiences',candidate.id)).toEqual(candidate);
 await expect(broker.call(actor,'company_command',{command:{type:'recruitment.candidate',requisitionId:req.id,name:'Independently chosen candidate',role:'Independently authored role',modelId:model,competencies:['Workforce planning'],sourceIds:[previous.id],adaptation:'Local authority',onboarding:'Inspect actual needs'}})).rejects.toMatchObject({code:'source_inspection_required'});
 expect(store.need('experiences',candidate.id)).toEqual(candidate);
 store.update('assignments',run.assignmentId,{schedulerKey:`formation:approve:${candidate.id}:3`});expect(broker.promptContext(actor).historicalSourceReferences).toBeUndefined();
});

it.each(['json-string','malformed-string','array','null','boolean','number'])('rejects company command %s shape concisely without parsing or applying it',async shape=>{
 const actor=actorFor(ceo),department=store.command(owner,{type:'department.create',name:'Shape validation fixture',managerId:ceo.id,responsibilities:'Retained department'});
 const command={type:'department.update',departmentId:department.id,rationale:'Legitimate charter revision',charter:'New actual charter'};
 const value=shape==='json-string'?JSON.stringify(command):shape==='malformed-string'?JSON.stringify(command).slice(0,-1):shape==='array'?[command]:shape==='null'?null:shape==='boolean'?true:3;
 let failure:Error|undefined;try{await broker.call(actor,'company_command',{command:value});}catch(error){failure=error as Error;}
 expect(failure?.message).toContain('must be a JSON object');expect(failure?.message).toContain('company_help');expect(failure!.message.length).toBeLessThan(400);expect(failure?.message).not.toContain('executive.appoint');expect(failure?.message).not.toContain('recruitment.request');
 expect(store.need('departments',department.id)).toEqual(department);expect(store.need('runs',actor.runId).corporateCommands??[]).toEqual([]);
 await broker.call(actor,'company_command',{command});expect(store.need('departments',department.id).charter).toBe(command.charter);
});

it('keeps missing command type and required field validation for actual objects',async()=>{
 const actor=actorFor(ceo);
 await expect(broker.call(actor,'company_command',{command:{}})).rejects.toThrow(/requires command.type/);
 await expect(broker.call(actor,'company_command',{command:{type:'department.update'}})).rejects.toMatchObject({code:'missing_command_fields'});
});

it('onboarding advertises separate internal and exclusive product proof shapes, while backend routes remain valid',async()=>{
 const manager=actorFor(ceo),employee=hire('Onboarding teammate',ceo.id,'worker'),req=store.put('experiences',{kind:'requisition',status:'filled',employeeId:employee.id,homeManagerId:ceo.id});
 store.update('employees',employee.id,{requisitionId:req.id,onboarding:{status:'pending'}});store.update('assignments',store.need('runs',manager.runId).assignmentId,{schedulerKey:`formation:onboard:${employee.id}`});
 const schema=(await disclosedTools(manager)).find(t=>t.name==='company_command')!.inputSchema;
 const validate=fromJSONSchema(schema as any),base={type:'assignment.create',employeeId:employee.id,title:'Inspect retained staffing needs',instructions:'Read current department vacancies and report actual unmet staffing needs.',acceptance:['Current vacancies identified from retained positions'],kind:'management'};
 expect(validate.safeParse({command:base}).success).toBe(true);expect(validate.safeParse({command:{...base,kind:'assessment'}}).success).toBe(true);
 for(const patch of [{kind:undefined},{completionSource:'artifact'},{completionRequirements:[]},{projectId:'unneeded-project'},{kind:'implementation'},{kind:'implementation',projectId:'product-project',rationale:'Actual product work',completionSource:'artifact',completionRequirements:[{criterion:base.acceptance[0],source:'artifact'}]}])expect(validate.safeParse({command:{...base,...patch}}).success,JSON.stringify(patch)).toBe(false);
 expect(broker.toolsFor(manager).map(t=>t.name)).toContain('create_assignment');
 expect(JSON.stringify(broker.toolsFor(manager)).length).toBeLessThan(30000);
 expect(await broker.call(manager,'company_help',{commandType:'assignment.create'})).toMatchObject({preferredTool:'create_assignment'});
 await expect(broker.call(manager,'company_command',{command:{type:'assignment.create',employeeId:employee.id}})).rejects.toMatchObject({code:'missing_command_fields',message:expect.stringContaining('Prefer create_assignment with direct employeeId, title, instructions, acceptance and kind arguments')});
 const created=await broker.call(manager,'create_assignment',Object.fromEntries(Object.entries(base).filter(([key])=>key!=='type')));expect(store.need('assignments',created.id)).toMatchObject({kind:'management',projectId:null,accepted:true});expect(store.need('assignments',created.id).completionRequirements).toBeUndefined();
 await broker.call(manager,'company_command',{command:{type:'recruitment.onboard',employeeId:employee.id,rationale:'Accepted first work matches current department needs'}});expect(store.need('employees',employee.id).onboarding.status).toBe('accepted');
 const project=store.command(owner,{type:'project.create',name:'Actual product first work',productId:store.list('products')[0].id,supervisorId:ceo.id,outcome:'Useful product change',acceptance:['Reviewed actual artifact'],rationale:'Genuine product need'});
 for(const proof of [{completionSource:'artifact'},{completionRequirements:[{criterion:base.acceptance[0],source:'artifact'}]}]){
  const command={...base,kind:'implementation',projectId:project.id,rationale:'Actual product acceptance needs reviewed evidence',...proof};expect(validate.safeParse({command}).success).toBe(true);
  const result=await broker.call(manager,'company_command',{command});expect(store.need('assignments',result.id).completionRequirements).toEqual([{criterion:base.acceptance[0],source:'artifact'}]);
 }
 await expect(broker.call(manager,'company_command',{command:{...base,kind:'implementation',projectId:project.id,rationale:'Conflicting modes',completionSource:'artifact',completionRequirements:[{criterion:base.acceptance[0],source:'artifact'}]}})).rejects.toMatchObject({code:'invalid_completion_requirements'});
 const directProduct=await broker.call(manager,'create_assignment',{employeeId:employee.id,title:'Actual delivered first work',instructions:'Implement and deliver the actual scoped change',acceptance:['First criterion','Second criterion'],kind:'implementation',projectId:project.id,rationale:'Useful product assignment',completionSource:'delivery'});
 expect(store.need('assignments',directProduct.id).completionRequirements).toEqual([{criterion:'First criterion',source:'delivery'},{criterion:'Second criterion',source:'delivery'}]);
 await expect(broker.call(manager,'create_assignment',{employeeId:employee.id,title:'Invalid internal proof',instructions:'Internal task',acceptance:['Actual outcome'],kind:'management',completionSource:'artifact'})).rejects.toMatchObject({code:'invalid_completion_requirements'});
 const ordinary=actorFor(ceo);expect(withoutDescriptions((await disclosedTools(ordinary)))).toEqual(withoutDescriptions(brokerTools.filter(tool=>!['revise_and_retry_assignment','resolve_ruby_dependencies','commit_work','verify_product','deliver_product','communicate','prepare_preview','prepare_release','publish_release','inspect_artifact','review_work','import_pull_request'].includes(tool.name))));
 const help=await broker.call(manager,'company_help',{});expect(help).toContain('pre-hire instruction to fill this now-filled role is stale');expect(help).toContain('never copy schema descriptions as values');expect(help).toContain('use create_assignment with direct arguments');
 store.update('assignments',store.need('runs',manager.runId).assignmentId,{schedulerKey:'formation:candidate:fixture:0'});expect(broker.toolsFor(manager).map(t=>t.name)).not.toContain('create_assignment');
 await expect(broker.call(manager,'create_assignment',base)).rejects.toMatchObject({code:'command_help_unavailable'});
});

 it('candidate batch context provides every authorized brief without granting inspections or approval',async()=>{
 const actor=actorFor(ceo),run=store.need('runs',actor.runId);
 const reqs=['First distinct brief','Second distinct brief'].map(brief=>store.put('experiences',{kind:'requisition',status:'open',homeManagerId:ceo.id,recruiterId:ceo.id,brief}));
 store.update('assignments',run.assignmentId,{schedulerKey:`formation:candidate:${reqs[0].id}:0`,payload:{formation:true,candidateRequisitionIds:reqs.map(r=>r.id)}});
 const context=broker.promptContext(actor);expect(context.candidateBatch.members.map((m:any)=>m.brief)).toEqual(reqs.map(r=>r.brief));expect(context.candidateBatch.members.every((m:any)=>m.recordedForAssignment===false)).toBe(true);expect(context.sourceInspections.items).toEqual([]);
 const guide=await broker.call(actor,'company_help',{});expect(guide).toContain('author each candidate separately');expect(guide).toContain('no automatic approval or hire');
 const schema=(await disclosedTools(actor)).find(t=>t.name==='company_command')!.inputSchema.properties.command;
 expect(schema.anyOf.some((branch:any)=>branch.properties.type.enum[0]==='recruitment.approve')).toBe(false);
 store.update('experiences',reqs[0].id,{status:'cancelled',supersession:{replacementRequisitionId:'replacement'}});
 const after=broker.promptContext(actor);expect(after.candidateBatch.members[0]).toMatchObject({status:'cancelled',replacementRequisitionId:'replacement'});expect(after.candidateBatch.members[1].brief).toBe('Second distinct brief');
 });

it('ordinary workplace help explains channel identity and honest event scheduling',async()=>{
 const help=await broker.call(actorFor(ceo),'company_help',{});
 expect(help).toContain('A department ID is not a channelId');expect(help).toContain('type:"workplace.channel.create"');expect(help).toContain('create_workplace_event {channelId:returned channel ID');expect(help).toContain('Future scheduling does not mean an event occurred');expect(help).toContain('actual attributed employee turns');
});

it('points visible wrong-collection event IDs to experiences without substituting a read',async()=>{
 const actor=actorFor(ceo),event=store.put('experiences',{kind:'workplace.event',title:'PRIVATE_EVENT_CONTENT_FIXTURE',status:'scheduled'});
 for(const collection of ['assignments','decisions']){
  let failure:any;try{await broker.call(actor,'company_detail',{collection,id:event.id});}catch(error){failure=error;}
  expect(failure).toMatchObject({code:'evidence_collection_mismatch'});expect(failure.message).toContain(`company_detail ${JSON.stringify({collection:'experiences',id:event.id})}`);expect(failure.message).not.toContain(event.title);
 }
 expect(store.need('experiences',event.id)).toEqual(event);
 expect((await broker.call(actor,'company_detail',{collection:'experiences',id:event.id})).content).toContain(event.title);
});

it('repo_read labels and character-pages managed directory listings',async()=>{
 const actor=actorFor(ceo),product=store.list('products')[0],content=JSON.stringify([{name:'docs',kind:'directory'},...Array.from({length:200},(_,i)=>({name:`file-${i}.md`,kind:'file'}))]);
 vi.spyOn(broker.workspaces,'readProduct').mockResolvedValue({sourceKind:'directory',baseCommit:'a'.repeat(40),content});
 const page=await broker.call(actor,'repo_read',{productId:product.id,path:'.',offset:20,limit:100});expect(page).toMatchObject({sourceKind:'directory',baseCommit:'a'.repeat(40),units:'characters',content:content.slice(20,120),nextOffset:120});
 expect(page.nextCall.arguments.path).toBe('.');
});

describe('explicit bounded collection continuation',()=>{
 it('explains the 30-record cap and returns an exact continuation for a request of 100',async()=>{
  const actor=actorFor(ceo);
  for(let i=0;i<53;i++)store.put('experiences',{kind:'pagination-fixture',employeeId:ceo.id,title:`Record ${i}`});
  const page=await broker.call(actor,'company_read',{collection:'experiences',offset:0,limit:100});
  expect(page.requestedLimit).toBe(100);expect(page.returned).toBe(30);expect(page.items).toHaveLength(30);
  expect(page.paginationGuidance).toContain('at most 30');expect(page.paginationGuidance).toContain('company_detail');
  expect(page.nextCall).toEqual({tool:'company_read',arguments:{collection:'experiences',offset:30,limit:30}});
  const next=await broker.call(actor,page.nextCall.tool,page.nextCall.arguments);
  expect(next.items).toHaveLength(23);expect(next.nextCall).toBeNull();
  expect(new Set([...page.items,...next.items].map(item=>item.id)).size).toBe(53);
 });
 it('advances by fitted item count and retains every large record across bounded pages',async()=>{
  const actor=actorFor(ceo),ids:string[]=[];
  for(let i=0;i<18;i++)ids.push(store.put('experiences',{kind:'pagination-fixture',employeeId:ceo.id,title:`Large ${i}`,summary:'s'.repeat(4000),rationale:'r'.repeat(4000),payload:{body:'p'.repeat(4000)},verification:{body:'v'.repeat(4000)}}).id);
  const seen:string[]=[];let offset=0;
  for(let count=0;count<18;count++){
   const page=await broker.call(actor,'company_read',{collection:'experiences',offset,limit:100});
   expect(JSON.stringify(page).length).toBeLessThanOrEqual(12000);expect(page.returned).toBeGreaterThan(0);expect(page.returned).toBeLessThan(18);
   seen.push(...page.items.map((item:{id:string})=>item.id));
   if(!page.nextCall)break;
   expect(page.nextCall.arguments.offset).toBe(offset+page.returned);offset=page.nextCall.arguments.offset;
  }
  expect(seen).toEqual(ids);expect(new Set(seen).size).toBe(ids.length);
 });
});

it('compact advertisement preserves scoped command discovery and exact optional help without mutating schemas',async()=>{
 const canonical=JSON.stringify(brokerTools),actor=actorFor(ceo),tools=broker.toolsFor(actor);
 const command=tools.find(t=>t.name==='company_command')!.inputSchema.properties.command;
 const original=brokerTools.find(t=>t.name==='company_command')!.inputSchema.properties.command;
 expect(command.properties.type.enum).toEqual(original.anyOf.map((branch:any)=>branch.properties.type.enum[0]));
 expect(command).not.toHaveProperty('anyOf');expect(command.additionalProperties).toBe(true);
 expect(JSON.stringify(tools).length).toBeLessThan(30000);
 expect(JSON.stringify(brokerTools).length-JSON.stringify(tools).length).toBeGreaterThan(24000);
 const disclosed=await broker.call(actor,'company_help',{commandType:'employee.model'});
 expect(disclosed.inputSchema).toEqual(original.anyOf.find((branch:any)=>branch.properties.type.enum[0]==='employee.model'));
 expect(disclosed.requiredFields).toEqual(disclosed.inputSchema.required);
 expect(disclosed).not.toHaveProperty('envelope');
 for(const branch of original.anyOf)for(const [name,schema] of Object.entries(branch.properties)){
  if(name==='type')continue;
  const advertised=command.properties[name];
  expect(advertised===undefined).toBe(false);
  expect(advertised.anyOf??[advertised]).toContainEqual(withoutDescriptions(schema));
 }
 disclosed.inputSchema.properties.employeeId.type='number';disclosed.requiredFields.push('inventedRequirement');
 expect((await broker.call(actor,'company_help',{commandType:'employee.model'})).inputSchema).toEqual(original.anyOf.find((branch:any)=>branch.properties.type.enum[0]==='employee.model'));
 expect(JSON.stringify(brokerTools)).toBe(canonical);
 expect(await broker.call(actor,'company_help',{})).toBe(corporateGuide);
 store.update('assignments',store.need('runs',actor.runId).assignmentId,{schedulerKey:'formation:department:Scoped department'});
 const scoped=broker.toolsFor(actor).find(t=>t.name==='company_command')!.inputSchema.properties.command.properties.type.enum;
 expect(scoped).not.toContain('employee.hire');
 await expect(broker.call(actor,'company_help',{commandType:'employee.hire'})).rejects.toMatchObject({code:'command_help_unavailable'});
 const scopedHelp=await broker.call(actor,'company_help',{commandType:'department.update'});
 expect(scopedHelp.inputSchema).toEqual(original.anyOf.find((branch:any)=>branch.properties.type.enum[0]==='department.update'));
 expect(store.need('runs',actor.runId).corporateCommands??[]).toEqual([]);
 expect(JSON.stringify(brokerTools)).toBe(canonical);
});

it('department batch context exposes both remits and partial records without widening tools',async()=>{
 const actor=actorFor(ceo),run=store.need('runs',actor.runId),names=['Product Management','User Research'];
 store.update('assignments',run.assignmentId,{schedulerKey:`formation:department:${names[0]}`,payload:{formation:true,departmentNames:names}});
 const department=store.command(owner,{type:'department.create',name:names[1],managerId:ceo.id,responsibilities:'Existing second partial department'});
 const position=store.command(owner,{type:'position.create',title:'Research lead',level:'lead',departmentId:department.id,responsibilities:'Actual user evidence'});
 const context=broker.promptContext(actor);expect(context.departmentBatch.names).toEqual(names);expect(context.departments.items.map((d:any)=>d.id)).toContain(department.id);expect(context.positions.items.map((p:any)=>p.id)).toContain(position.id);
 const guide=await broker.call(actor,'company_help',{});expect(guide).toContain('BOTH departments');expect(guide).toContain('end only after both actual departments');
 const schema=(await disclosedTools(actor)).find(t=>t.name==='company_command')!.inputSchema.properties.command;expect(schema.anyOf.some((b:any)=>b.properties.type.enum[0]==='employee.hire')).toBe(false);
});

it('places the current authorized assignment first while paging every other assignment in stored order',async()=>{
 const earlier=Array.from({length:4},()=>actorFor(ceo)).map(actor=>store.need('runs',actor.runId).assignmentId);
 const actor=actorFor(ceo),current=store.need('runs',actor.runId).assignmentId;
 const stored=store.list('assignments').map(a=>a.id);
 expect(stored.slice(-1)).toEqual([current]);
 const first=await broker.call(actor,'company_read',{collection:'assignments',offset:0,limit:1});
 expect(first.items.map((item:any)=>item.id)).toEqual([current]);expect(first.ordering).toContain('Current authorized assignment first');
 const ids=[current];let next=first.nextCall;
 while(next){const page=await broker.call(actor,next.tool,next.arguments);ids.push(...page.items.map((item:any)=>item.id));next=page.nextCall;}
 expect(ids).toEqual([current,...stored.filter(id=>id!==current)]);expect(new Set(ids).size).toBe(stored.length);
 expect(ids.slice(1)).toEqual(earlier);
 expect(store.list('assignments').map(a=>a.id)).toEqual(stored);
 expect((await broker.call(actor,'company_read',{collection:'assignments',offset:0,limit:1})).items[0].id).toBe(current);
});
it('current-assignment ordering preserves employee scope and leaves other collection ordering alone',async()=>{
 const manager=hire('Scoped manager'),unrelated=hire('Unrelated manager');
 const hidden=actorFor(unrelated),hiddenId=store.need('runs',hidden.runId).assignmentId;
 const prior=actorFor(manager),priorId=store.need('runs',prior.runId).assignmentId;
 const actor=actorFor(manager),current=store.need('runs',actor.runId).assignmentId;
 const page=await broker.call(actor,'company_read',{collection:'assignments',limit:30});
 expect(page.items.map((item:any)=>item.id)).toEqual([current,priorId]);expect(page.total).toBe(2);
 expect(JSON.stringify(page)).not.toContain(hiddenId);
 const employees=await broker.call(actor,'company_read',{collection:'employees',limit:30});expect(employees).not.toHaveProperty('ordering');
 const listed=employees.items.find((employee:any)=>employee.id===manager.id);
 expect(listed).toMatchObject({positionId:manager.positionId,positionTitle:'Scoped manager',modelId:manager.modelId,roleVersion:manager.roleVersion});
 expect(listed).not.toHaveProperty('role');
 const detail=await broker.call(actor,'company_detail',{collection:'employees',id:manager.id,view:'record'});
 expect(JSON.parse(detail.content).role).toBe(manager.role);
 store.update('positions',manager.positionId,{title:'Long position title '.repeat(5000)});
 const bounded=await broker.call(actor,'company_read',{collection:'employees',limit:30});
 expect(bounded.items.map((employee:any)=>employee.id)).toEqual(employees.items.map((employee:any)=>employee.id));
 expect(JSON.stringify(bounded.items.find((employee:any)=>employee.id===manager.id).positionTitle).length).toBeLessThan(500);
});

it('direct staffing tools retain required fields, receipts and executive authority',async()=>{
 const actor=actorFor(ceo),tools=broker.toolsFor(actor);
 expect(tools.find(t=>t.name==='create_position')!.inputSchema.required).toEqual(['title','level','responsibilities']);
 await expect(broker.call(actor,'create_position',{title:'Engineer',level:'worker'})).rejects.toMatchObject({code:'missing_command_fields'});
 await expect(broker.call(actor,'create_position',{type:'employee.dismiss',title:'Engineer',level:'worker',responsibilities:'Inspect actual source'})).rejects.toMatchObject({code:'command_arguments'});
 const position=await broker.call(actor,'create_position',{title:'Engineer',level:'worker',responsibilities:'Inspect actual source'});
 const employee=await broker.call(actor,'hire_employee',{name:'Specialist',positionId:position.id,modelId:model,role:'Inspect source and report actual findings within granted authority.'});
 expect(store.need('employees',employee.id).homeManagerId).toBe(ceo.id);
 const project=await broker.call(actor,'create_project',{name:'Useful inspection',outcome:'Source-linked finding',acceptance:['Actual finding'],rationale:'Evidence supports bounded inspection'});
 expect(store.need('projects',project.id).supervisorId).toBe(ceo.id);
 const executive=await broker.call(actor,'create_position',{title:'Executive',level:'executive',responsibilities:'Executive accountability'});
 await expect(broker.call(actor,'hire_employee',{name:'Unapproved executive',positionId:executive.id,modelId:model})).rejects.toThrow();
});

it('retains per-command required fields in the advertised flattened tool',()=>{
 const actor=actorFor(ceo),tool=broker.toolsFor(actor).find(t=>t.name==='company_command')!;
 expect(tool.description).toContain('project.create: name, outcome, acceptance, rationale');
 expect(tool.description).toContain('employee.hire: name, positionId, modelId');
 expect(tool.inputSchema.properties.command.required).toEqual(['type']);
 expect(broker.toolsFor(actor).map(t=>t.name)).not.toContain('deliver_product');
 expect(broker.toolsFor(actor).map(t=>t.name)).toContain('record_artifact');
 const project=store.command(owner,{type:'project.create',name:'Scoped product work',supervisorId:ceo.id,productId:store.list('products')[0].id,outcome:'Reviewed change',acceptance:['Actual artifact'],rationale:'Tool scope regression'});
 expect(broker.toolsFor(actorFor(ceo,project)).map(t=>t.name)).toContain('deliver_product');
});

it('preserves direct legacy calls without prior help, including nullable project IDs and structured roadmaps',async()=>{
 const actor=actorFor(ceo),product=store.list('products')[0];
 const assignment=await broker.call(actor,'company_command',{command:{type:'assignment.create',employeeId:ceo.id,projectId:null,title:'Valid company work',instructions:'Inspect current staffing needs',acceptance:['Actual unmet needs recorded'],kind:'management'}});
 expect(store.need('assignments',assignment.id).projectId).toBeNull();
 const roadmap=[{phase:'now',outcome:'Maintain the existing executable',ownerId:ceo.id}];
 await broker.call(actor,'company_command',{command:{type:'product.assess',productId:product.id,assessment:'Actual assessment fixture',rationale:'Preserve supported structured roadmap',roadmap}});
 expect(store.need('products',product.id).roadmap).toEqual(roadmap);
 const employee=hire('Legacy model selection',ceo.id,'worker');
 store.update('assignments',store.need('runs',actor.runId).assignmentId,{schedulerKey:'formation:department:Current remit'});
 expect(broker.toolsFor(actor).find(t=>t.name==='company_command')!.inputSchema.properties.command.properties.type.enum).not.toContain('employee.model');
 await broker.call(actor,'company_command',{command:{type:'employee.model',employeeId:employee.id,modelId:model,rationale:'Existing manager authority remains unchanged'}});
 expect(store.need('employees',employee.id).modelRationale).toBe('Existing manager authority remains unchanged');
 await expect(broker.call(actor,'company_help',{commandType:'employee.model'})).rejects.toMatchObject({code:'command_help_unavailable'});
});
it('optional field help grants no authority and does not replace required-field checks',async()=>{
 const worker=hire('Worker without hiring authority',ceo.id,'worker'),actor=actorFor(worker),before=store.list('employees');
 await broker.call(actor,'company_help',{commandType:'employee.hire'});
 await expect(broker.call(actor,'company_command',{command:{type:'employee.hire'}})).rejects.toMatchObject({code:'missing_command_fields'});
 await expect(broker.call(actor,'company_command',{command:{type:'employee.hire',name:'Unauthorized',positionId:worker.positionId,modelId:model}})).rejects.toThrow();
 expect(store.list('employees')).toEqual(before);expect(store.need('runs',actor.runId).corporateCommands??[]).toEqual([]);
});


it('direct role tool retains authored content and history under existing management authority',async()=>{
 const employee=hire('Role recipient'),actor=actorFor(ceo),before=store.need('employees',employee.id).roleVersion;
 const schema=broker.toolsFor(actor).find(t=>t.name==='update_role')!.inputSchema;
 expect(schema.required).toEqual(['employeeId','content','source','rationale']);
 const args={employeeId:employee.id,content:'Own API integration boundaries and coordinate dependency changes with Web Engineering.',source:'Original management instructions from department needs.',rationale:'Clarify specialist responsibilities.'};
 await expect(broker.call(actor,'update_role',{...args,content:undefined})).rejects.toMatchObject({code:'role_arguments'});
 await expect(broker.call(actor,'update_role',{...args,summary:'Wrong field'})).rejects.toMatchObject({code:'role_arguments'});
 expect(store.need('employees',employee.id).roleVersion).toBe(before);
 await broker.call(actor,'update_role',args);
 expect(store.need('employees',employee.id)).toMatchObject({id:employee.id,role:args.content,roleVersion:before+1});
 expect(store.list('roleVersions').filter(r=>r.employeeId===employee.id).map(r=>r.version)).toEqual([before,before+1]);
 const peer=hire('Unrelated manager'),peerActor=actorFor(peer);
 await expect(broker.call(peerActor,'update_role',args)).rejects.toThrow();
 expect(store.need('employees',employee.id).roleVersion).toBe(before+1);
 store.update('assignments',store.need('runs',actor.runId).assignmentId,{schedulerKey:'formation:department:Scoped department'});
 expect(broker.toolsFor(actor).map(t=>t.name)).not.toContain('update_role');
 await expect(broker.call(actor,'update_role',args)).rejects.toMatchObject({code:'command_help_unavailable'});
});


it('direct knowledge tool requires authored body and retains normal scope and correction checks',async()=>{
 const actor=actorFor(ceo);
 expect(broker.toolsFor(actor).find(t=>t.name==='write_knowledge')!.inputSchema.required).toEqual(['content','source']);
 const args={content:'Actual source restrictions override an old import label.',source:'Observed retained source license correction.',scope:'company',title:'Source eligibility correction'};
 const before=store.list('knowledge').length;
 await expect(broker.call(actor,'write_knowledge',{path:'company/empty.md'})).rejects.toMatchObject({code:'knowledge_arguments'});
 await expect(broker.call(actor,'write_knowledge',{...args,command:{type:'knowledge.write'}})).rejects.toMatchObject({code:'knowledge_arguments'});
 expect(store.list('knowledge')).toHaveLength(before);
 await broker.call(actor,'write_knowledge',args);
 const recorded=store.list('knowledge').find(k=>k.title===args.title)!;expect(recorded.provenance.source).toBe(args.source);
 expect(store.readKnowledge(recorded.id).content).toContain(args.content);
 await expect(broker.call(actor,'write_knowledge',{...args,scope:'invalid-scope'})).rejects.toThrow();
 await expect(broker.call(actor,'write_knowledge',{...args,supersedes:'missing-knowledge'})).rejects.toThrow();
 store.update('assignments',store.need('runs',actor.runId).assignmentId,{schedulerKey:'formation:department:Scoped department'});
 expect(broker.toolsFor(actor).map(t=>t.name)).not.toContain('write_knowledge');
 await expect(broker.call(actor,'write_knowledge',args)).rejects.toMatchObject({code:'command_help_unavailable'});
});


it.each([undefined,'record'])('pages current candidate fields before all historical versions for view %s',async view=>{
 const actor=actorFor(ceo);
 const history=[{version:1,role:'Superseded title-only role',onboarding:'Old onboarding '+ 'h'.repeat(18000),sourceIds:['old-source'],runId:'old-run'}];
 const candidate=store.put('experiences',{kind:'candidate',history,requisitionId:'fixture-requisition',employeeId:ceo.id,version:2,status:'proposed',authorId:ceo.id,runId:actor.runId,name:'Current candidate',role:'Current tailored operating instructions',onboarding:'Current useful first work',sourceIds:['current-source'],adaptation:'Current local adaptation'});
 const before=store.need('experiences',candidate.id);
 let page=await broker.call(actor,'company_detail',{collection:'experiences',id:candidate.id,view,offset:0});
 expect(page.content).toContain('Current tailored operating instructions');
 expect(page.content.indexOf('"version": 2')).toBeLessThan(page.content.indexOf('"history"'));
 expect(page.content.indexOf('"runId"')).toBeLessThan(page.content.indexOf('"history"'));
 let content=page.content;
 while(page.nextOffset!==null){const offset=page.nextOffset;page=await broker.call(actor,'company_detail',{collection:'experiences',id:candidate.id,view,offset});expect(page.offset).toBe(offset);expect(page.content.length).toBeLessThanOrEqual(8000);content+=page.content;}
 for(const field of ['role','onboarding','sourceIds','adaptation'])expect(content.indexOf(`"${field}"`)).toBeLessThan(content.indexOf('"history"'));
 expect(JSON.parse(content)).toEqual(before);
 expect(JSON.parse(content).history).toEqual(history);
 expect(store.need('experiences',candidate.id)).toEqual(before);
});

it.each([true,false])('direct candidate review preserves actual manager judgment %s and audit',async approve=>{
 const actor=actorFor(ceo),department=store.command(owner,{type:'department.create',name:'Review team',managerId:ceo.id,responsibilities:'Useful work'});
 const position=store.command(owner,{type:'position.create',title:'Specialist',level:'worker',departmentId:department.id,responsibilities:'Useful specialization'});
 const req=store.command(actor,{type:'recruitment.request',positionId:position.id,homeManagerId:ceo.id,recruiterId:ceo.id,brief:'Specific need',firstWork:'Useful task'});
 const candidate=store.put('experiences',{kind:'candidate',requisitionId:req.id,version:2,status:'proposed',role:'Current tailored role'});
 const args={candidateId:candidate.id,approve,rationale:'My actual current-version judgment'};
 const schema=broker.toolsFor(actor).find(t=>t.name==='review_candidate')!.inputSchema;
 expect(schema.required).toEqual(['candidateId','approve','rationale']);expect(fromJSONSchema(schema as any).safeParse(args).success).toBe(true);
 for(const invalid of [{...args,approve:undefined},{...args,approve:'false'},{...args,rationale:' '},{candidateId:candidate.id,approve,summary:'No rationale'}])await expect(broker.call(actor,'review_candidate',invalid)).rejects.toMatchObject({code:'candidate_review_arguments'});
 const peer=actorFor(hire('Unrelated reviewer'));await expect(broker.call(peer,'review_candidate',args)).rejects.toThrow(/Responsible home management/);
 expect(store.need('experiences',candidate.id).status).toBe('proposed');
 expect(await broker.call(actor,'company_help',{commandType:approve?'recruitment.approve':'recruitment.reject'})).toMatchObject({preferredTool:'review_candidate',directFields:['candidateId','approve','rationale']});
 await broker.call(actor,'review_candidate',args);
 const retained=store.need('experiences',candidate.id);expect(retained.status).toBe(approve?'approved':'changes_requested');expect(retained[approve?'approval':'feedback']).toMatchObject({authorId:ceo.id,runId:actor.runId,rationale:args.rationale});
 expect(store.need('runs',actor.runId).corporateCommands.some((receipt:any)=>receipt.type===(approve?'recruitment.approve':'recruitment.reject'))).toBe(true);
 store.update('assignments',store.need('runs',actor.runId).assignmentId,{schedulerKey:'formation:department:Review team'});
 expect(broker.toolsFor(actor).map(t=>t.name)).not.toContain('review_candidate');await expect(broker.call(actor,'review_candidate',args)).rejects.toMatchObject({code:'command_help_unavailable'});
});

it('direct candidate review enforces the selected verdict branch independently',async()=>{
 const actor=actorFor(ceo),original=(broker as any).scopedToolsFor(actor);
 vi.spyOn(broker as any,'scopedToolsFor').mockReturnValue(original.map((tool:any)=>tool.name==='company_command'?{...tool,inputSchema:{...tool.inputSchema,properties:{command:{...tool.inputSchema.properties.command,anyOf:tool.inputSchema.properties.command.anyOf.filter((branch:any)=>branch.properties.type.enum[0]==='recruitment.reject')}}}}:tool));
 expect(broker.toolsFor(actor).map(t=>t.name)).toContain('review_candidate');
 await expect(broker.call(actor,'review_candidate',{candidateId:'unused',approve:true,rationale:'Actual judgment'})).rejects.toMatchObject({code:'command_help_unavailable'});
 expect(await broker.call(actor,'company_help',{commandType:'recruitment.reject'})).toMatchObject({preferredTool:'review_candidate'});
});

it('direct internal message requires authored content and an existing recipient with normal attribution',async()=>{
 const worker=hire('Handoff sender',ceo.id,'worker'),actor=actorFor(worker),args={recipientId:ceo.id,content:'Actual retained hire is ready for your onboarding acceptance.'};
 const schema=broker.toolsFor(actor).find(t=>t.name==='send_message')!.inputSchema;
 expect(schema.required).toEqual(['recipientId','content']);expect(fromJSONSchema(schema as any).safeParse(args).success).toBe(true);
 const before=store.list('messages');
 for(const invalid of [{recipientId:ceo.id},{...args,content:' '},{content:args.content},{...args,projectId:''},{...args,summary:'Wrong field'},{...args,channelId:'not-a-workplace-tool'}])await expect(broker.call(actor,'send_message',invalid)).rejects.toMatchObject({code:'message_arguments'});
 await expect(broker.call(actor,'send_message',{...args,recipientId:'nonexistent-employee'})).rejects.toThrow();
 const req=store.put('experiences',{kind:'requisition',status:'open'});
 await expect(broker.call(actor,'send_message',{...args,projectId:req.id})).rejects.toThrow();
 expect(store.list('messages')).toEqual(before);
 expect(await broker.call(actor,'company_help',{commandType:'message.send'})).toMatchObject({preferredTool:'send_message',directFields:['recipientId','content','projectId','wake','channel']});
 const result=await broker.call(actor,'send_message',args);
 expect(store.need('messages',result.id)).toMatchObject({...args,senderId:worker.id,runId:actor.runId,projectId:null});
 expect(store.need('runs',actor.runId).corporateCommands.some((receipt:any)=>receipt.type==='message.send'&&receipt.id===result.id)).toBe(true);
 const peer=actorFor(hire('Unrelated reader',ceo.id,'worker'));
 await expect(broker.call(peer,'company_detail',{collection:'messages',id:result.id})).rejects.toMatchObject({code:'evidence_forbidden'});
 const project=store.command(owner,{type:'project.create',name:'Actual project',productId:store.list('products')[0].id,outcome:'Useful work',acceptance:['Useful result'],supervisorId:ceo.id,rationale:'Actual project'});
 const linked=await broker.call(actor,'send_message',{...args,projectId:project.id});expect(store.need('messages',linked.id).projectId).toBe(project.id);
 const generic=await broker.call(actor,'company_command',{command:{type:'message.send',content:'Existing generic default recipient preserved'}});expect(store.need('messages',generic.id).recipientId).toBe(ceo.id);
});

it('direct internal messaging follows provision scope without becoming a candidate or initial-vote mutation escape',async()=>{
 const actor=actorFor(ceo),assignmentId=store.need('runs',actor.runId).assignmentId,args={recipientId:ceo.id,content:'Actual scoped handoff'};
 store.update('assignments',assignmentId,{schedulerKey:'formation:provision:fixture',payload:{formation:true},projectId:null});
 expect(broker.toolsFor(actor).map(t=>t.name)).toContain('send_message');await expect(broker.call(actor,'send_message',args)).resolves.toBeDefined();
 store.update('assignments',assignmentId,{schedulerKey:'formation:candidate:fixture:0'});
 expect(broker.toolsFor(actor).map(t=>t.name)).not.toContain('send_message');await expect(broker.call(actor,'send_message',args)).rejects.toMatchObject({code:'command_help_unavailable'});
 const elder=store.list('employees').find(e=>store.level(e.id)==='elder')!,elderActor=actorFor(elder),decision=store.command(owner,{type:'decision.create',kind:'executive.review',subject:'Independent review',rationale:'Actual judgment required',payload:{employeeId:ceo.id}});
 store.update('assignments',store.need('runs',elderActor.runId).assignmentId,{kind:'governance',payload:{decisionId:decision.id}});
 expect(broker.toolsFor(elderActor).map(t=>t.name)).not.toContain('send_message');await expect(broker.call(elderActor,'send_message',args)).rejects.toMatchObject({code:'initial_vote_required'});
});

it('direct workplace creation retains authored gathering/calendar records without claiming occurrence or rewriting history',async()=>{
 const employee=hire('Culture coordinator',ceo.id,'worker'),actor=actorFor(employee),channel=store.command(actor,{type:'workplace.channel.create',name:'Fixture gathering'});
 const args={channelId:channel.id,title:'Declared demonstration',purpose:'Discuss one actual onboarding improvement',participantIds:[ceo.id],scheduledAt:'2030-01-05T12:00:00Z',eventType:'gathering',recurrence:'none',durationMinutes:5,maxTurnsPerParticipant:1};
 const schema=broker.toolsFor(actor).find(t=>t.name==='create_workplace_event')!.inputSchema;
 expect(schema.required).toEqual(['channelId','title','purpose','participantIds','scheduledAt']);expect(fromJSONSchema(schema as any).safeParse(args).success).toBe(true);
 const before=store.list('experiences');
 for(const field of schema.required)await expect(broker.call(actor,'create_workplace_event',{...args,[field]:undefined})).rejects.toMatchObject({code:'workplace_event_arguments'});
 for(const extra of [{status:'active'},{supersedes:'old-event'},{content:'Wrong purpose field'},{hostId:ceo.id}])await expect(broker.call(actor,'create_workplace_event',{...args,...extra})).rejects.toMatchObject({code:'workplace_event_arguments'});
 for(const invalid of [{scheduledAt:'not-a-date'},{channelId:'missing-channel'},{participantIds:['missing-employee']},{maxTurnsPerParticipant:3}])await expect(broker.call(actor,'create_workplace_event',{...args,...invalid})).rejects.toThrow();
 expect(store.list('experiences')).toEqual(before);
 expect(await broker.call(actor,'company_help',{commandType:'workplace.event.create'})).toMatchObject({preferredTool:'create_workplace_event'});
 const gathering=await broker.call(actor,'create_workplace_event',args),retained=store.need('experiences',gathering.id);
 expect(retained).toMatchObject({title:args.title,purpose:args.purpose,hostId:employee.id,participantIds:[employee.id,ceo.id],status:'scheduled',occurrence:0,createdByRunId:actor.runId});
 const formed=new Date(employee.createdAt),anniversary=new Date(formed);anniversary.setUTCFullYear(formed.getUTCFullYear()+1);
 await expect(broker.call(actor,'create_workplace_event',{...args,eventType:'formation_anniversary',subjectEmployeeId:employee.id,scheduledAt:employee.createdAt})).rejects.toMatchObject({code:'invalid_anniversary_date'});
 const calendar=await broker.call(actor,'create_workplace_event',{...args,title:'Actual formation anniversary',eventType:'formation_anniversary',subjectEmployeeId:employee.id,scheduledAt:anniversary.toISOString(),recurrence:'annual'});
 expect(store.need('experiences',calendar.id)).toMatchObject({formationDate:employee.createdAt,status:'scheduled',fictional:false,recurrence:'annual'});
 expect(store.need('experiences',gathering.id)).toEqual(retained);expect(store.list('messages')).toEqual([]);
 expect(store.need('runs',actor.runId).corporateCommands.filter((receipt:any)=>receipt.type==='workplace.event.create')).toHaveLength(2);
 store.update('assignments',store.need('runs',actor.runId).assignmentId,{schedulerKey:'formation:provision:fixture',payload:{formation:true},projectId:null});
 expect(broker.toolsFor(actor).map(t=>t.name)).not.toContain('create_workplace_event');await expect(broker.call(actor,'create_workplace_event',args)).rejects.toMatchObject({code:'command_help_unavailable'});
});


it('a workplace host reads participant channel replies while direct/project messages and invalid channel tags remain private',async()=>{
 const host=actorFor(hire('Culture host',ceo.id,'worker')),participant=actorFor(hire('Participant',ceo.id,'worker')),other=hire('Private recipient',ceo.id,'worker');
 const channel=store.command(host,{type:'workplace.channel.create',name:'Hosted conversation'});
 const event=store.command(host,{type:'workplace.event.create',channelId:channel.id,title:'Fixture gathering',purpose:'Discuss useful coordination',participantIds:[participant.employeeId],scheduledAt:'2030-01-01T12:00:00Z'});
 const reply=store.command(participant,{type:'workplace.message.send',channelId:channel.id,content:'Actual participant reply'});
 const omitted=store.put('messages',{senderId:participant.employeeId,channelId:channel.id,runId:participant.runId,content:'Legacy channel reply without recipient/project fields'});
 const direct=store.command(participant,{type:'message.send',recipientId:other.id,content:'Private message'});
 const forged=store.put('messages',{senderId:participant.employeeId,recipientId:other.id,projectId:null,channelId:channel.id,runId:participant.runId,content:'Private message with forged channel tag'});
 const projectTagged=store.put('messages',{senderId:participant.employeeId,recipientId:null,projectId:'unrelated-project',channelId:channel.id,runId:participant.runId,content:'Project-only message'});
 const missing=store.put('messages',{senderId:participant.employeeId,recipientId:null,projectId:null,channelId:'missing-channel',runId:participant.runId,content:'Unknown channel'});
 const nonchannel=store.put('messages',{senderId:participant.employeeId,recipientId:null,projectId:null,channelId:event.id,runId:participant.runId,content:'Event ID is not a channel'});
 const untagged=store.put('messages',{senderId:participant.employeeId,recipientId:null,projectId:null,runId:participant.runId,content:'No channel'});
 expect((await broker.call(host,'company_read',{collection:'messages',limit:30})).items.map((m:any)=>m.id)).toEqual([reply.id,omitted.id]);
 for(const record of [reply,omitted])expect((await broker.call(host,'company_detail',{collection:'messages',id:record.id})).content).toContain(record.content);
 for(const record of [direct,forged,projectTagged,missing,nonchannel,untagged])await expect(broker.call(host,'company_detail',{collection:'messages',id:record.id})).rejects.toMatchObject({code:'evidence_forbidden'});
});


it('compact message pages retain actual sender/channel/event attribution without inventing fields on direct messages',async()=>{
 const host=actorFor(hire('Conversation host',ceo.id,'worker')),participant=hire('Conversation participant',ceo.id,'worker');
 const channel=store.command(host,{type:'workplace.channel.create',name:'Attribution fixture'});
 const message=store.put('messages',{senderId:participant.id,recipientId:null,projectId:null,channelId:channel.id,eventId:'retained-event',occurrence:2,fictionalContext:false,runId:'retained-participant-run',content:'Attributed reply '+ 'r'.repeat(800)});
 const direct=store.command(host,{type:'message.send',recipientId:participant.id,content:'Private coordination'});
 const first=await broker.call(host,'company_read',{collection:'messages',limit:1});
 expect(first.items).toHaveLength(1);expect(first.items[0]).toMatchObject({id:message.id,senderId:participant.id,recipientId:null,projectId:null,channelId:channel.id,eventId:'retained-event',occurrence:2,fictionalContext:false,runId:'retained-participant-run'});
 expect(first.items[0].content.content.length).toBe(350);expect(first.items[0].content.truncated).toBe(true);
 const second=await broker.call(host,first.nextCall.tool,first.nextCall.arguments);
 expect(second.items).toHaveLength(1);expect(second.items[0]).toMatchObject({id:direct.id,senderId:host.employeeId,recipientId:participant.id,projectId:null,runId:host.runId});
 for(const field of ['channelId','eventId','occurrence','fictionalContext'])expect(second.items[0]).not.toHaveProperty(field);
 expect(second.nextCall).toBeNull();expect(JSON.stringify(first).length).toBeLessThanOrEqual(12000);
 expect(JSON.parse((await broker.call(host,'company_detail',{collection:'messages',id:message.id})).content)).toEqual(message);
});


it('employee name/title lookup preserves filtered pagination without searching role bodies',async()=>{
 const actor=actorFor(ceo),first=hire('Quality lead'),second=hire('Quality analyst'),other=hire('Unrelated specialist');
 store.update('employees',first.id,{name:'Uma Fixture'});store.update('employees',other.id,{role:'Quality keyword appears only in full role content.'});
 const query=' QUALITY ',page=await broker.call(actor,'company_read',{collection:'employees',query,limit:1});
 expect(page.total).toBe(2);expect(page.items.map((e:any)=>e.id)).toEqual([first.id]);expect(page.nextCall.arguments.query).toBe(query);
 const next=await broker.call(actor,page.nextCall.tool,page.nextCall.arguments);
 expect(next.items.map((e:any)=>e.id)).toEqual([second.id]);expect(next.nextCall).toBeNull();
 expect((await broker.call(actor,'company_read',{collection:'employees',query:'uma fixture'})).items.map((e:any)=>e.id)).toEqual([first.id]);
 expect((await broker.call(actor,'company_read',{collection:'employees',query:'no matching employee'})).total).toBe(0);
 for(const args of [{query:'Quality'},{collection:'summary',query:'Quality'},{collection:'assignments',query:'Quality'},{collection:'employees',query:' '},{collection:'employees',query:[]},{collection:'employees',query:'x'.repeat(201)}])await expect(broker.call(actor,'company_read',args)).rejects.toMatchObject({code:'employee_query_filter'});
});

it('exact experience kind filters authorized records before pagination and retains continuation scope',async()=>{
 const reader=actorFor(hire('Scoped requisition reader',ceo.id,'worker')),other=hire('Other requisition owner',ceo.id,'worker');
 const ids:string[]=[];
 for(let i=0;i<5;i++){
  store.put('experiences',{kind:'skill-source',summary:'Unrelated catalog entry'});
  ids.push(store.put('experiences',{kind:'requisition',homeManagerId:reader.employeeId,status:i===0?'filled':'open',brief:`Visible ${i}`}).id);
  store.put('experiences',{kind:'requisition',homeManagerId:other.id,status:'open',brief:'Private requisition'});
 }
 const first=await broker.call(reader,'company_read',{collection:'experiences',kind:'requisition',limit:2});
 expect(first.total).toBe(5);expect(first.offset).toBe(0);expect(first.items.map((r:any)=>r.id)).toEqual(ids.slice(0,2));expect(first.items[0].status).toBe('filled');
 const seen=first.items.map((r:any)=>r.id);let page=first;
 while(page.nextCall){expect(page.nextCall.arguments.kind).toBe('requisition');expect(page.nextCall.arguments.offset).toBe(seen.length);page=await broker.call(reader,page.nextCall.tool,page.nextCall.arguments);expect(page.total).toBe(5);seen.push(...page.items.map((r:any)=>r.id));}
 expect(seen).toEqual(ids);
 expect((await broker.call(reader,'company_read',{collection:'experiences',kind:'Requisition'})).total).toBe(0);
 expect((await broker.call(reader,'company_read',{collection:'experiences'})).total).toBe(10);
 for(const invalid of [{collection:'messages',kind:'requisition'},{kind:'requisition'},{collection:'summary',kind:'requisition'},{collection:'experiences',kind:[]},{collection:'experiences',kind:' '}])await expect(broker.call(reader,'company_read',invalid)).rejects.toMatchObject({code:'experience_kind_filter'});
});


it('direct onboarding retains manager judgment and requires actual first work or authored standby',async()=>{
 const manager=actorFor(ceo),employee=hire('New recruited teammate',ceo.id,'worker');
 store.update('employees',employee.id,{requisitionId:'retained-requisition',onboarding:{status:'pending'}});
 store.update('assignments',store.need('runs',manager.runId).assignmentId,{schedulerKey:`formation:onboard:${employee.id}`});
 const args={employeeId:employee.id,rationale:'Observed readiness for scoped first work'};
 expect(broker.toolsFor(manager).find(t=>t.name==='accept_onboarding')!.inputSchema.required).toEqual(['employeeId','rationale']);
 expect(await broker.call(manager,'company_help',{commandType:'recruitment.onboard'})).toMatchObject({preferredTool:'accept_onboarding'});
 expect(await broker.call(manager,'company_help',{})).toContain('Then use accept_onboarding');
 await expect(broker.call(manager,'company_command',{command:{type:'recruitment.onboard',employeeId:employee.id,standbyCondition:'Misplaced acceptance prose'}})).rejects.toMatchObject({code:'missing_command_fields',message:expect.stringContaining('Prefer accept_onboarding')});
 for(const invalid of [{employeeId:employee.id,standbyCondition:'Await useful work'},{...args,rationale:' '},{...args,status:'accepted'},{...args,standbyCondition:[]}])await expect(broker.call(manager,'accept_onboarding',invalid)).rejects.toMatchObject({code:'onboarding_arguments'});
 await expect(broker.call(manager,'accept_onboarding',args)).rejects.toMatchObject({code:'first_work_required'});
 const outsider=actorFor(hire('Other home manager'));
 await expect(broker.call(outsider,'accept_onboarding',{...args,standbyCondition:'Cannot accept another manager employee'})).rejects.toThrow(/Responsible home management/);
 expect(store.need('employees',employee.id).onboarding.status).toBe('pending');
 const first=await broker.call(manager,'create_assignment',{employeeId:employee.id,title:'Read actual vacancies',instructions:'Identify current staffing needs',acceptance:['Current vacancies reported'],kind:'management'});
 await broker.call(manager,'accept_onboarding',args);
 expect(store.need('employees',employee.id).onboarding).toMatchObject({status:'accepted',authorId:ceo.id,runId:manager.runId,rationale:args.rationale,standbyCondition:null});
 expect(store.need('assignments',first.id)).toMatchObject({status:'queued',accepted:true});
 const standby=hire('Standby recruited teammate',ceo.id,'worker');store.update('employees',standby.id,{requisitionId:'other-retained-requisition',onboarding:{status:'pending'}});
 await broker.call(manager,'accept_onboarding',{employeeId:standby.id,rationale:'No useful vacancy work currently',standbyCondition:'Await a manager-authorized requisition'});
 expect(store.need('employees',standby.id).onboarding.standbyCondition).toBe('Await a manager-authorized requisition');
 expect(store.need('runs',manager.runId).corporateCommands.filter((r:any)=>r.type==='recruitment.onboard')).toHaveLength(2);
 store.update('assignments',store.need('runs',manager.runId).assignmentId,{schedulerKey:'formation:provision:fixture'});
 expect(broker.toolsFor(manager).map(t=>t.name)).not.toContain('accept_onboarding');await expect(broker.call(manager,'accept_onboarding',args)).rejects.toMatchObject({code:'command_help_unavailable'});
});


it('direct assignment requires an explicit kind without mutating work while generic defaults remain compatible',async()=>{
 const actor=actorFor(ceo),worker=hire('Bounded coordination worker',ceo.id,'worker');
 const args={employeeId:worker.id,title:'Read current requisition',instructions:'Read the current requisition and report its scope to the lead.',acceptance:['Accurate scope message sent to the lead']};
 const before=store.list('assignments'),schema=broker.toolsFor(actor).find(t=>t.name==='create_assignment')!.inputSchema;
 expect(fromJSONSchema(schema as any).safeParse(args).success).toBe(false);
 for(const kind of [undefined,'','bogus'])await expect(broker.call(actor,'create_assignment',{...args,kind})).rejects.toMatchObject({code:'invalid_assignment_arguments',message:expect.stringContaining('explicit kind')});
 expect(store.list('assignments')).toEqual(before);expect(store.need('runs',actor.runId).corporateCommands??[]).toEqual([]);
 expect(await broker.call(actor,'company_help',{commandType:'assignment.create'})).toMatchObject({directRequiredFields:['employeeId','title','instructions','acceptance','kind']});
 const direct=await broker.call(actor,'create_assignment',{...args,kind:'management'});
 expect(store.need('assignments',direct.id)).toMatchObject({...args,kind:'management',projectId:null,status:'queued',accepted:true});
 const generic=await broker.call(actor,'company_command',{command:{type:'assignment.create',...args}});expect(store.need('assignments',generic.id).kind).toBe('implementation');
});


it('explains and rejects summary-kind misuse with actionable collection reads, without silently executing it',async()=>{
 const reader=actorFor(ceo),schema=brokerTools.find(tool=>tool.name==='company_read')!.inputSchema;
 expect(schema.properties.collection.description).toContain('Overview: omit or summary');
 expect(schema.properties.kind.description).toContain('omit for other collections');
 for(const collection of ['employees','positions','departments']){
  const corrected={collection,offset:0,limit:30};
  await expect(broker.call(reader,'company_read',{...corrected,kind:'summary'})).rejects.toMatchObject({code:'experience_kind_filter',message:expect.stringContaining(`Omit kind to list this collection: company_read ${JSON.stringify(corrected)}`)});
  const page=await broker.call(reader,'company_read',corrected);
  expect(page.items).toBeInstanceOf(Array);expect(page.total).toBeGreaterThanOrEqual(0);
 }
 await expect(broker.call(reader,'company_read',{kind:'summary'})).rejects.toMatchObject({code:'experience_kind_filter',message:expect.stringContaining('company_read {}')});
 expect(await broker.call(reader,'company_read',{})).toHaveProperty('company');
 expect(await broker.call(reader,'company_read',{collection:'summary'})).toHaveProperty('company');
});


it('filters authorized workplace channel messages before pagination without including private tagged messages',async()=>{
 const host=actorFor(hire('Channel page reader',ceo.id,'worker')),participant=actorFor(hire('Channel contributor',ceo.id,'worker'));
 const channel=store.command(host,{type:'workplace.channel.create',name:'Target conversation'}),other=store.command(host,{type:'workplace.channel.create',name:'Other conversation'}),ids:string[]=[];
 for(let i=0;i<5;i++){
  store.command(participant,{type:'message.send',recipientId:host.employeeId,content:`Private ${i}`});
  store.put('messages',{senderId:participant.employeeId,channelId:other.id,content:`Other ${i}`});
  ids.push(store.put('messages',{senderId:participant.employeeId,channelId:channel.id,content:`Target ${i}`}).id);
 }
 const forged=store.put('messages',{senderId:participant.employeeId,recipientId:host.employeeId,channelId:channel.id,content:'Visible private DM with channel tag'});
 store.put('messages',{senderId:host.employeeId,projectId:'tagged-project',channelId:channel.id,content:'Visible own project message'});
 let page=await broker.call(host,'company_read',{collection:'messages',channelId:channel.id,limit:2});
 expect(page.total).toBe(5);const found=page.items.map((m:any)=>m.id);
 while(page.nextCall){expect(page.nextCall.arguments.channelId).toBe(channel.id);expect(page.nextCall.arguments.offset).toBe(found.length);page=await broker.call(host,page.nextCall.tool,page.nextCall.arguments);found.push(...page.items.map((m:any)=>m.id));}
 expect(found).toEqual(ids);
 expect((await broker.call(host,'company_read',{collection:'messages',limit:30})).items.map((m:any)=>m.id)).toContain(forged.id);
 for(const channelId of ['missing-channel',store.list('employees')[0].id])expect((await broker.call(host,'company_read',{collection:'messages',channelId})).total).toBe(0);
 for(const args of [{collection:'employees',channelId:channel.id},{collection:'summary',channelId:channel.id},{channelId:channel.id},{collection:'messages',channelId:' '},{collection:'messages',channelId:[]}])await expect(broker.call(host,'company_read',args)).rejects.toMatchObject({code:'message_channel_filter'});
});
it('focused provision context requires the exact current recruiter and trusted formation task; keeps full evidence and source gates',async()=>{
 const actor=actorFor(ceo),assignmentId=store.need('runs',actor.runId).assignmentId,req=store.put('experiences',{kind:'requisition',recruiterId:ceo.id,homeManagerId:ceo.id,firstWork:'Inspect actual staffing'}),candidate=store.put('experiences',{kind:'candidate',status:'approved',version:2,requisitionId:req.id,name:'Approved candidate',onboarding:'Inspect responsibilities',sourceIds:[]});
 store.put('knowledge',{scope:'company',content:'UNRELATED_LONG_COMPANY_NOTE',path:'unused'});
 store.update('assignments',assignmentId,{schedulerKey:`formation:provision:${candidate.id}`,kind:'management',projectId:null,payload:{formation:true}});
 const packet=broker.provisionPrompt(actor)!;expect(packet.prompt).toContain(candidate.id);expect(packet.prompt).not.toContain('UNRELATED_LONG_COMPANY_NOTE');expect(packet.prompt).not.toContain('history');
 await expect(broker.call(actor,'company_detail',{collection:'experiences',id:candidate.id})).resolves.toMatchObject({record:{id:candidate.id,version:2}});
 store.put('projects',{id:'some-project',name:'Excluded project'});
 for(const patch of [{payload:{}},{kind:'implementation'},{projectId:'some-project'},{schedulerKey:'formation:provision:other'}]){const original=store.need('assignments',assignmentId);store.update('assignments',assignmentId,patch);expect(broker.provisionPrompt(actor)).toBeUndefined();store.update('assignments',assignmentId,original);}
 store.update('experiences',req.id,{recruiterId:'another-recruiter'});expect(broker.provisionPrompt(actor)).toBeUndefined();
});

it('lets the trusted fault supervisor read only the assigned original outside the home-management chain',async()=>{
 const supervisor=hire('Shared work supervisor'),home=hire('Other home manager'),worker=hire('Shared worker',home.id,'worker');
 const original=store.command(owner,{type:'assignment.create',employeeId:worker.id,supervisorId:supervisor.id,kind:'management',title:'Shared internal work',instructions:'Inspect assigned department',acceptance:['Actual responsibilities reported']});
 store.update('assignments',original.id,{status:'blocked'});
 const failed=store.put('runs',{assignmentId:original.id,employeeId:worker.id,status:'failed',tokenHash:'PRIVATE_FAILURE_TOKEN'}),other=actorFor(worker),actor=actorFor(supervisor),taskId=store.need('runs',actor.runId).assignmentId;
 store.update('assignments',taskId,{status:'running',schedulerKey:`fault:${failed.id}`,payload:{failedRunId:failed.id,failedAssignmentId:original.id}});
 expect(store.canManage(actor,worker.id)).toBe(false);expect(store.faultContext(actor.runId)?.assignment.id).toBe(original.id);
 expect((await broker.call(actor,'company_read',{collection:'assignments'})).items.map((r:any)=>r.id)).toEqual([taskId,original.id]);
 await expect(broker.call(actor,'company_detail',{collection:'assignments',id:original.id})).resolves.toMatchObject({record:{id:original.id}});
 const detail=await broker.call(actor,'company_detail',{collection:'runs',id:failed.id});expect(detail.record).toEqual({id:failed.id});expect(JSON.parse(detail.content).id).toBe(failed.id);expect(JSON.stringify(detail)).not.toContain('PRIVATE_FAILURE_TOKEN');
 await expect(broker.call(actor,'company_detail',{collection:'assignments',id:store.need('runs',other.runId).assignmentId})).rejects.toMatchObject({code:'evidence_forbidden'});
 const payload=store.need('assignments',taskId).payload;
 store.update('assignments',taskId,{payload:{...payload,failedAssignmentId:'forged'}});
 await expect(broker.call(actor,'company_detail',{collection:'assignments',id:original.id})).rejects.toMatchObject({code:'evidence_forbidden'});
 store.update('assignments',taskId,{payload});store.put('runs',{assignmentId:original.id,employeeId:worker.id,status:'failed'});
 await expect(broker.call(actor,'company_detail',{collection:'assignments',id:original.id})).rejects.toMatchObject({code:'evidence_forbidden'});
 await expect(broker.call(actor,'company_detail',{collection:'runs',id:failed.id})).rejects.toMatchObject({code:'evidence_forbidden'});
});

it('candidate new and resumed reuse receipts identify the missing batch member until its actual authoring',async()=>{
 const recruiter=actorFor(ceo),run=store.need('runs',recruiter.runId),department=store.command(owner,{type:'department.create',name:'Batch team',managerId:ceo.id,responsibilities:'Actual staffing'});
 const reqs=[0,1].map(i=>{const position=store.command(owner,{type:'position.create',title:`Specialist ${i}`,level:'worker',departmentId:department.id,responsibilities:'Useful local work'});return store.command(owner,{type:'recruitment.request',positionId:position.id,homeManagerId:ceo.id,recruiterId:ceo.id,brief:`Distinct remit ${i}`,firstWork:'Inspect actual needs'});});
 store.update('assignments',run.assignmentId,{schedulerKey:`formation:candidate:${reqs[0].id}:0`,payload:{formation:true,candidateRequisitionIds:reqs.map(r=>r.id)}});
 const source=store.put('experiences',{id:'a'.repeat(64),kind:'skill-source'}),body='---\nlicense: MIT\n---\nUseful source',license='MIT License\nPermission is hereby granted, free of charge',directory=join(root,'skills','vendor',source.id);mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'SOURCE.md'),body);writeFileSync(join(directory,'LICENSE'),license);const sha256=createHash('sha256').update(body).digest('hex');store.update('experiences',source.id,{sourcePath:join(directory,'SOURCE.md'),sha256,licenseHash:createHash('sha256').update(license).digest('hex')});
 const inspections={[source.id]:{sha256,ranges:[[0,body.length]],complete:true}};store.update('runs',run.id,{skillInspections:inspections});
 const command={type:'recruitment.candidate',requisitionId:reqs[0].id,name:'First candidate',role:'Perform scoped local research',modelId:model,competencies:['Research'],sourceIds:[source.id],adaptation:'Local tools only',onboarding:'Inspect actual requests'};
 const first=await broker.call(recruiter,'company_command',{command});expect(first.batchProgress).toMatchObject({completed:false,completedRequisitionIds:[reqs[0].id],missingRequisitionIds:[reqs[1].id],nextCall:{tool:'company_detail',arguments:{collection:'experiences',id:reqs[1].id}}});expect(Object.keys(first)[0]).toBe('batchProgress');
 store.update('runs',run.id,{status:'interrupted'});const resumed=store.put('runs',{...run,id:randomUUID(),sessionId:randomUUID(),status:'running',skillInspections:{}}),actor={...recruiter,runId:resumed.id};
 const reused=await broker.call(actor,'company_command',{command:{...command,name:'Must not replace retained name'}});expect(reused.id).toBe(first.id);expect(reused.name).toBe('First candidate');expect(reused.batchProgress).toEqual(first.batchProgress);expect(store.need('experiences',first.id).authorship.runId).toBe(run.id);
 store.update('runs',resumed.id,{skillInspections:inspections});const second=await broker.call(actor,'company_command',{command:{...command,requisitionId:reqs[1].id,name:'Second candidate'}});expect(second.id).not.toBe(first.id);expect(second.batchProgress).toMatchObject({completed:true,completedRequisitionIds:reqs.map(r=>r.id),missingRequisitionIds:[]});expect(second.batchProgress.nextCall).toBeUndefined();expect(store.need('experiences',second.id).status).toBe('proposed');expect(store.need('experiences',second.id).authorship.runId).toBe(resumed.id);
});


it('discloses actual responsibility kinds and rejects the observed management kind without changing the obligation',async()=>{
 const actor=actorFor(ceo),original=store.command(owner,{type:'assignment.create',employeeId:ceo.id,kind:'management',title:'Original tool obligation',instructions:'Delegate useful implementation and retain continuation',acceptance:['Actual staffing and follow-through']});
 const before=store.need('assignments',original.id),help=await broker.call(actor,'company_help',{commandType:'responsibility.update'});
 expect(help.inputSchema.properties.kind.enum).toEqual(['changed_approach','specialist_help','reassignment','prerequisite_work','scheduled_recheck','owner_decision']);expect(help.inputSchema.properties.kind.description).not.toContain('assignment.create:');
 const command={type:'responsibility.update',assignmentId:original.id,kind:'management',action:'Check the retained implementation',ownerId:ceo.id,nextCheckAt:new Date(Date.now()+3600_000).toISOString()};
 await expect(broker.call(actor,'company_command',{command})).rejects.toThrow(/Use changed_approach, specialist_help, reassignment, prerequisite_work, scheduled_recheck or owner_decision/);
 expect(store.need('assignments',original.id)).toEqual(before);
 await broker.call(actor,'company_command',{command:{...command,kind:'scheduled_recheck'}});
 expect(store.need('assignments',original.id)).toMatchObject({status:before.status,acceptance:before.acceptance,continuation:{kind:'scheduled_recheck',action:command.action,runId:actor.runId,authorId:ceo.id}});
});

it('focuses trusted responsibility context on the authorized original obligation and its linked knowledge',async()=>{
 const manager=hire('Responsible manager'),worker=hire('Assigned specialist',manager.id,'worker'),actor=actorFor(manager),taskId=store.need('runs',actor.runId).assignmentId;
 const original=store.command(owner,{type:'assignment.create',employeeId:worker.id,supervisorId:manager.id,title:'Preserved commitment',instructions:'Retain exact original work',acceptance:['Exact original acceptance'],kind:'management'});
 const project=store.command(owner,{type:'project.create',name:'Linked obligation project',productId:store.list('products')[0].id,outcome:'Retained useful work',acceptance:['Actual work'],supervisorId:manager.id,rationale:'Linked original work'});store.update('assignments',original.id,{projectId:project.id});
 const attention=store.put('attention',{kind:'owner_decision',assignmentId:original.id,ownerId:manager.id,status:'open',title:'Actual prerequisite'}),diagnosis=store.put('assignments',{...store.need('assignments',taskId),id:'prior-diagnosis',schedulerKey:'fault:failed-run',payload:{failedAssignmentId:original.id,failedRunId:'failed-run'},status:'blocked'});
 const broadCatalogBytes=JSON.stringify(broker.toolsFor(actor)).length;
 const continuation={ownerId:manager.id,kind:'management_followup',action:'Resolve retained obligation',followupAssignmentId:taskId,nextCheckAt:new Date(Date.now()+60000).toISOString()};store.update('assignments',original.id,{status:'blocked',continuation});store.update('assignments',taskId,{projectId:null,schedulerKey:`responsibility:${original.id}:${manager.id}`,payload:{sourceAssignmentId:original.id}});
 const linked=store.command(owner,{type:'knowledge.write',scope:'company',content:'LINKED_OBLIGATION_FINDING',source:`Observed ${original.id}`}),unrelated=store.command(owner,{type:'knowledge.write',scope:'company',content:'UNRELATED_GLOBAL_REPORT',source:'Unrelated work'}),personal=store.command(owner,{type:'knowledge.write',scope:'employees',scopeId:manager.id,content:'UNRELATED_PERSONAL_LOG',source:'Personal activity'});
 const scopedTools=broker.toolsFor(actor),commands=scopedTools.find(t=>t.name==='company_command')!.inputSchema.properties.command.properties.type.enum;
 expect(JSON.stringify(scopedTools).length).toBeLessThan(broadCatalogBytes);expect(commands).toEqual(expect.arrayContaining(['responsibility.update','owner.request','assignment.create','assignment.update','message.send']));expect(commands).not.toContain('recruitment.candidate');
 expect(scopedTools.map(t=>t.name)).toEqual(expect.arrayContaining(['company_detail','repo_read','inspect_artifact','skill_read','skill_discover','skill_import','create_assignment','send_message']));expect(scopedTools.some(t=>['record_blocked_diagnosis','revise_and_retry_assignment'].includes(t.name))).toBe(false);
 const help=await broker.call(actor,'company_help',{});expect(help).toContain(`assignmentId:"${original.id}"`);expect(help).toContain('nonterminal');expect(help).toContain('nextCheckAt');expect(help.length).toBeLessThan(1800);
 const context=broker.promptContext(actor);expect(context.originalAssignment).toMatchObject({id:original.id,acceptance:original.acceptance,continuation});expect(context.followup.id).toBe(taskId);expect(context.policy.spendingLimit).toBe(store.policy.spendingLimit);expect(context.policy.directFreeModels).toEqual(store.policy.directFreeModels);expect(context.policy).not.toHaveProperty('productiveConcurrencyQualification');
 expect(context.products.items.map((p:any)=>p.id)).toEqual([project.productId]);expect(context.projects.items.map((p:any)=>p.id)).toEqual([project.id]);expect(context.attention.items.map((a:any)=>a.id)).toEqual([attention.id]);expect(context.priorDiagnoses.items.map((a:any)=>a.id)).toEqual([diagnosis.id]);expect(broker.knowledgeContext(actor,[manager.id],20000).map(n=>n.id)).toEqual([linked.id]);expect((await broker.call(actor,'company_detail',{collection:'knowledge',id:unrelated.id})).content).toBe('UNRELATED_GLOBAL_REPORT');expect((await broker.call(actor,'company_detail',{collection:'knowledge',id:personal.id})).content).toBe('UNRELATED_PERSONAL_LOG');
 const generated=store.command(owner,{type:'knowledge.write',scope:'company',content:'GENERATED_OBLIGATION_MIRROR',source:original.id});store.update('knowledge',generated.id,{generated:true});expect(broker.knowledgeContext(actor,[],20000).map(n=>n.id)).not.toContain(generated.id);
 store.command(owner,{type:'knowledge.write',scope:'company',content:'Withdrawn unrelated finding',source:'Unrelated new source',supersedes:linked.id});expect(broker.knowledgeContext(actor,[],20000)).toEqual([]);
 const hidden=store.command(owner,{type:'assignment.create',employeeId:ceo.id,title:'Private leadership obligation',instructions:'Unrelated authority',acceptance:['Private'],kind:'management'});store.update('assignments',taskId,{schedulerKey:`responsibility:${hidden.id}:${manager.id}`,payload:{sourceAssignmentId:hidden.id}});expect(broker.promptContext(actor).originalAssignment).toBeUndefined();await expect(broker.call(actor,'company_detail',{collection:'assignments',id:hidden.id})).rejects.toMatchObject({code:'evidence_forbidden'});
 store.update('assignments',taskId,{schedulerKey:`responsibility:${original.id}:${manager.id}`,payload:{sourceAssignmentId:hidden.id}});expect(broker.promptContext(actor).originalAssignment).toBeUndefined();
});

it('explains exact concurrent profiles while preserving authorized solo model selection',async()=>{
 const local=store.list('models').find(m=>m.name===model)!,localHash='a'.repeat(64),remoteHash='b'.repeat(64),remoteId='vendor/shared:free';
 store.update('models',local.id,{artifactIdentity:localHash});const solo=store.put('models',{name:'Solo alternative',local:true,available:true,artifactIdentity:'c'.repeat(64),capabilities:['tools']});
 store.put('models',{id:remoteId,name:remoteId,provider:'openrouter',local:false,available:true,freeOnly:true,artifactIdentity:remoteHash,endpoint:'https://openrouter.ai/api/v1/chat/completions',pricingVerifiedAt:new Date().toISOString(),pricing:{prompt:'0',completion:'0'}});
 store.command(owner,{type:'policy.update',openRouterFreeModels:[remoteId],maxInference:5,concurrencyQualification:{passed:true,stableMaxInference:5,largePlusSmall:true,evidence:'Synthetic fixture'},maxProductiveTurns:5,productiveConcurrencyQualification:{mode:'local-remotes',passed:true,artifactIdentity:localHash,stableMaxProductiveTurns:5,remoteProfiles:[{modelId:remoteId,artifactIdentity:remoteHash,maxConcurrentTurns:4}],providerCaps:[{provider:'openrouter',maxConcurrentTurns:4}],evidence:'Synthetic fixture only'}});
 const employee=hire('Model choice subject'),actor=actorFor(ceo),help=await broker.call(actor,'company_help',{commandType:'employee.model'}),listed=broker.companyRead(actor,{collection:'models'});
 expect(help.modelRouting.qualifiedConcurrentModelIds).toEqual([local.id,remoteId]);expect(listed.modelRouting).toEqual(help.modelRouting);expect(listed.items.some((m:any)=>m.id===solo.id)).toBe(true);expect(help.modelRouting.guidance).toContain('may wait until all other productive runs finish');
 await broker.call(actor,'company_command',{command:{type:'employee.model',employeeId:employee.id,modelId:solo.id,rationale:'Evidence supports a deliberately serialized alternative'}});expect(store.need('employees',employee.id).modelId).toBe(solo.id);
 store.update('models',remoteId,{artifactIdentity:'d'.repeat(64)});expect((await broker.call(actor,'company_help',{commandType:'employee.model'})).modelRouting.qualifiedConcurrentModelIds).toEqual([local.id]);
});


it('rejects author review before diff inspection and directs canonical verification without recording a review',async()=>{
 const project=store.command(owner,{type:'project.create',name:'Actual authored tool',outcome:'Useful verified implementation',acceptance:['Actual reviewed output'],supervisorId:ceo.id,rationale:'Independent review required'}),actor=actorFor(ceo,project);
 const artifact=store.put('artifacts',{kind:'commit',employeeId:ceo.id,runId:actor.runId,assignmentId:store.need('runs',actor.runId).assignmentId,projectId:project.id,identity:'a'.repeat(40),checks:[],uri:'fixture'}),before=store.need('artifacts',artifact.id),inspect=vi.spyOn(broker.workspaces,'artifact');
 await expect(broker.call(actor,'review_work',{artifactId:artifact.id,verdict:'approved',rationale:'Authored code is ready'})).rejects.toMatchObject({code:'independent_review_required',status:403,message:expect.stringContaining('Use verify_product')});
 expect(inspect).not.toHaveBeenCalled();expect(store.list('reviews')).toHaveLength(0);expect(store.need('artifacts',artifact.id)).toEqual(before);expect(store.need('runs',actor.runId).artifactInspections).toBeUndefined();
});

it('commits exact selected files while preserving unrelated staged and unstaged work',async()=>{
 const product=store.command(owner,{type:'product.register_internal',name:'Scoped commit fixture',managerId:ceo.id,verificationCommand:'node --test',rationale:'Test isolated source selection'});
 const project=store.command(owner,{type:'project.create',name:'Scoped files',productId:product.id,outcome:'Actual implementation',acceptance:['Selected changes only'],supervisorId:ceo.id,rationale:'Test commit ownership'});
 await broker.workspaces.ensure(project);const current=store.need('projects',project.id),actor=actorFor(ceo,current),workspace=current.workspace!;
 const git=(...args:string[])=>execFileSync('git',['-C',workspace,...args],{encoding:'utf8'});
 writeFileSync(join(workspace,'staged.txt'),'baseline');writeFileSync(join(workspace,'unstaged.txt'),'baseline');git('add','--all');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','Fixture baseline');
 writeFileSync(join(workspace,'staged.txt'),'unrelated staged');git('add','staged.txt');writeFileSync(join(workspace,'unstaged.txt'),'unrelated unstaged');writeFileSync(join(workspace,'selected.txt'),'actual selected work');
 const status=git('status','--porcelain'),head=git('rev-parse','HEAD');
 await expect(broker.call(actor,'commit_work',{summary:'Missing explicit selection'})).rejects.toThrow('commit_work requires paths');
 for(const paths of [[],['../escape'],['/absolute'],['.'],['*.txt'],['staged.txt','staged.txt'],['missing.txt'],['selected.txt\nother']])await expect(broker.call(actor,'commit_work',{summary:'Invalid selection',paths})).rejects.toThrow();
 expect(git('status','--porcelain')).toBe(status);expect(git('rev-parse','HEAD')).toBe(head);expect(store.list('artifacts')).toHaveLength(0);
 const artifact=await broker.call(actor,'commit_work',{summary:'Commit selected implementation',paths:['selected.txt']});
 expect(artifact.artifactId).toBe(artifact.id);expect(artifact.nextCall).toEqual({name:'corporate_verify_product',arguments:{artifactId:artifact.id}});expect(artifact.identity).not.toBe(artifact.id);await expect(broker.call(actor,'verify_product',{artifactId:artifact.identity})).rejects.toMatchObject({code:'not_found'});
 expect(git('diff-tree','--no-commit-id','--name-only','-r',artifact.identity).trim()).toBe('selected.txt');
 expect(git('diff','--cached','--name-only').trim()).toBe('staged.txt');expect(git('diff','--name-only').trim()).toBe('unstaged.txt');expect(git('show','HEAD:staged.txt')).toBe('baseline');expect(git('show','HEAD:unstaged.txt')).toBe('baseline');
 git('mv','staged.txt','renamed.txt');const renamed=await broker.call(actor,'commit_work',{summary:'Intentional rename only',paths:['staged.txt','renamed.txt']});expect(git('diff-tree','--no-renames','--no-commit-id','--name-only','-r',renamed.identity).trim().split('\n')).toEqual(['renamed.txt','staged.txt']);expect(git('diff','--name-only').trim()).toBe('unstaged.txt');
 rmSync(join(workspace,'selected.txt'));const deleted=await broker.call(actor,'commit_work',{summary:'Intentional deletion only',paths:['selected.txt']});expect(git('diff-tree','--no-commit-id','--name-status','-r',deleted.identity).trim()).toBe('D\tselected.txt');expect(git('diff','--name-only').trim()).toBe('unstaged.txt');


});

it('advertises Ruby resolution only for current paletteWOW implementation and refuses other scopes',async()=>{
 const manager=actorFor(ceo);expect(broker.toolsFor(manager).map(t=>t.name)).not.toContain('resolve_ruby_dependencies');await expect(broker.call(manager,'resolve_ruby_dependencies',{gems:['rack'],rationale:'Scope test'})).rejects.toMatchObject({code:'dependency_resolution_scope'});
 const product=store.list('products').find(p=>p.name==='paletteWOW')!,project=store.command(owner,{type:'project.create',name:'Scoped Ruby repair',productId:product.id,outcome:'Repair actual dependency',acceptance:['Verified update'],supervisorId:ceo.id,rationale:'Test resolver scope'}),actor=actorFor(ceo,project),assignmentId=store.need('runs',actor.runId).assignmentId;
 expect(broker.toolsFor(actor).map(t=>t.name)).toContain('resolve_ruby_dependencies');
 for(const update of [{kind:'review'},{kind:'implementation',payload:{pullRequest:{number:1,headSha:'a'.repeat(40)}}}]){store.update('assignments',assignmentId,update);expect(broker.toolsFor(actor).map(t=>t.name)).not.toContain('resolve_ruby_dependencies');await expect(broker.call(actor,'resolve_ruby_dependencies',{gems:['rack'],rationale:'Scope test'})).rejects.toMatchObject({code:'dependency_resolution_scope'});}
});

it('withholds confidential assignments and derived runs from hosted summaries and detail reads',async()=>{
 const confidential=store.command(owner,{type:'assignment.create',employeeId:ceo.id,title:'SYNTHETIC_PRIVATE_TITLE',instructions:'SYNTHETIC_PRIVATE_INSTRUCTIONS',acceptance:['Private fixture'],kind:'management',dataClass:'confidential'});
 const failed=store.put('runs',{assignmentId:confidential.id,employeeId:ceo.id,modelId:model,status:'failed',text:'SYNTHETIC_PRIVATE_RESULT'});
 const diagnosis=store.put('assignments',{...confidential,id:randomUUID(),dataClass:undefined,title:'SYNTHETIC_PRIVATE_DIAGNOSIS',schedulerKey:`fault:${failed.id}`,payload:{failedAssignmentId:confidential.id},status:'queued'});
 const actor=actorFor(ceo);store.update('runs',actor.runId,{modelId:'free-pool'});
 expect(JSON.stringify(broker.companyRead(actor))).not.toContain('SYNTHETIC_PRIVATE');
 for(const [collection,id] of [['assignments',confidential.id],['assignments',diagnosis.id],['runs',failed.id]])await expect(broker.call(actor,'company_detail',{collection,id})).rejects.toMatchObject({code:'evidence_forbidden'});
 expect(store.confidentialAssignments().has(diagnosis.id)).toBe(true);
 store.update('runs',actor.runId,{modelId:model});
 expect(JSON.stringify(await broker.call(actor,'company_detail',{collection:'assignments',id:confidential.id}))).toContain('SYNTHETIC_PRIVATE_INSTRUCTIONS');
});

it('keeps unassigned Telegram intake out of hosted context while sharing it with the local CEO',async()=>{
 const message=store.put('messages',{senderId:'owner',recipientId:ceo.id,projectId:null,runId:null,content:'SYNTHETIC_PRIVATE_TELEGRAM',telegram:{direction:'incoming'}});
 const actor=actorFor(ceo);
 store.update('assignments',store.need('runs',actor.runId).assignmentId,{kind:'conversation'});
 expect(JSON.stringify(broker.promptContext(actor))).toContain('SYNTHETIC_PRIVATE_TELEGRAM');
 store.update('runs',actor.runId,{modelId:'synthetic-hosted-route'});
 expect(JSON.stringify(broker.promptContext(actor))).not.toContain('SYNTHETIC_PRIVATE_TELEGRAM');
 await expect(broker.call(actor,'company_detail',{collection:'messages',id:message.id})).rejects.toMatchObject({code:'evidence_forbidden'});
});

it('keeps conversation tool aliases bounded while retaining authorized command access',()=>{
 const actor=actorFor(ceo);store.update('assignments',store.need('runs',actor.runId).assignmentId,{kind:'conversation'});
 const tools=broker.toolsFor(actor);
 expect(tools.map(t=>t.name)).not.toContain('hire_employee');
 expect(tools.map(t=>t.name)).toEqual(expect.arrayContaining(['company_detail','company_help','create_assignment','send_message']));
 expect(tools.find(t=>t.name==='company_command')!.inputSchema.properties.command.properties.type.enum).toContain('employee.hire');
});

it('starts conversation history with newest scoped records and preserves ordinary ordering',async()=>{
 const actor=actorFor(ceo),assignmentId=store.need('runs',actor.runId).assignmentId;
 const older=store.put('messages',{senderId:'owner',recipientId:ceo.id,content:'Earlier status',projectId:null}),newer=store.put('messages',{senderId:'owner',recipientId:ceo.id,content:'Current status',projectId:null});
 const ordinary=await broker.call(actor,'company_read',{collection:'messages',limit:1});expect(ordinary.items[0].id).toBe(older.id);
 store.update('assignments',assignmentId,{kind:'conversation'});
 const recent=await broker.call(actor,'company_read',{collection:'messages',limit:1});expect(recent.items[0].id).toBe(newer.id);
 const next=await broker.call(actor,recent.nextCall.tool,recent.nextCall.arguments);expect(next.items[0].id).toBe(older.id);
});
it('withholds Owner proposal decisions and unassigned email replies from hosted employee reads',async()=>{
 const proposal=store.command(owner,{type:'owner.propose',title:'SYNTHETIC_PRIVATE_PROPOSAL',content:'Private scope',proposalScope:'Record only.',expiresAt:new Date(Date.now()+3600000).toISOString(),channel:'email'});
 const incoming=store.put('messages',{senderId:'owner',recipientId:ceo.id,content:'SYNTHETIC_PRIVATE_REPLY',email:{direction:'incoming'},projectId:null,runId:null});
 const actor=actorFor(ceo);store.update('runs',actor.runId,{modelId:'synthetic-hosted-route'});
 for(const [collection,id] of [['attention',proposal.id],['messages',proposal.messageId],['messages',incoming.id]])await expect(broker.call(actor,'company_detail',{collection,id})).rejects.toThrow();
 store.update('runs',actor.runId,{modelId:model});expect(JSON.stringify(await broker.call(actor,'company_detail',{collection:'attention',id:proposal.id}))).toContain('SYNTHETIC_PRIVATE_PROPOSAL');
});

it('serves bounded shared inspection to local home management without exposing it through project or hosted access',async()=>{
 const manager=hire('Diagnostic manager'),worker=hire('Diagnostic worker',manager.id,'worker'),peer=hire('Project peer',ceo.id,'worker');
 const project=store.command(owner,{type:'project.create',name:'Shared diagnostic project',outcome:'Recover useful work',acceptance:['Useful result'],supervisorId:manager.id,rationale:'Concrete recovery'});
 const subject=actorFor(worker,project),managing=actorFor(manager),projectPeer=actorFor(peer,project);
 const capture=new RunInspection(root,subject.runId,['synthetic-inspection-secret']);
 capture.record('tool.started',{name:'repo_read',input:'synthetic-inspection-secret',context:'x'.repeat(10000)});
 capture.record('runtime.tool',{tool:'corporate_repo_read',state:{status:'completed',output:'retained useful result'}});
 const args={collection:'runs',id:subject.runId,view:'inspection',offset:0};
 const index=await broker.call(managing,'company_detail',args);
 expect(JSON.parse(index.content).map((e:any)=>e.eventIndex)).toEqual([1,0]);
 expect(JSON.parse(index.content)[0]).toMatchObject({tool:'corporate_repo_read',status:'completed'});
 const first=await broker.call(managing,'company_detail',{...args,eventIndex:0});
 expect(first.available).toBe(true);expect(first.content.length).toBeLessThanOrEqual(8000);expect(first.content).not.toContain('synthetic-inspection-secret');
 const next=await broker.call(managing,'company_detail',{...args,eventIndex:0,offset:first.nextOffset});
 expect(next.content).toContain('xxx');
 expect((await broker.call(managing,'company_detail',{...args,eventIndex:1})).content).toContain('retained useful result');
 await expect(broker.call(managing,'company_detail',{...args,eventIndex:2})).rejects.toMatchObject({code:'inspection_event'});
 expect((await broker.call(subject,'company_detail',args)).available).toBe(true);
 expect((await broker.call(projectPeer,'company_detail',{...args,view:'record'})).record.id).toBe(subject.runId);
 await expect(broker.call(projectPeer,'company_detail',args)).rejects.toMatchObject({code:'inspection_forbidden'});
 store.update('runs',managing.runId,{modelId:'hosted-fixture'});
 await expect(broker.call(managing,'company_detail',args)).rejects.toMatchObject({code:'inspection_forbidden'});
 const outsider=actorFor(hire('Unrelated worker',ceo.id,'worker'));
 await expect(broker.call(outsider,'company_detail',args)).rejects.toMatchObject({code:'evidence_forbidden'});
});
