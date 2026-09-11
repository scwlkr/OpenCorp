import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { DomainError, type Actor, type Artifact, type Project, type Assignment, type AssignmentRequirement, type CorporateCommand, type TableName, type Tables, type CompanySnapshot, type CompanyEvent, type Employee, type PositionLevel, type EmployeeRun, type ExternalAction } from '../core/types.js';
import { deliveryFor, projectDispatchAllowed } from '../core/delivery.js';
import { employeeNarrativeProjection } from '../core/runtime-protocol.js';
import { reviewScopeIssue } from '../core/review-scope.js';
import { migrate, TABLES } from './schema.js';
import { KnowledgeVault } from './vault.js';

const NOW = () => new Date().toISOString();
const LARGE = 'wlkr-management-qwen3.8-27b-q4-k-m:latest';
const ALTERNATIVE = 'wlkr-management-nemotron-3.5-lightning-30b-a3b-q4-0:latest';
const LEVEL: Record<PositionLevel, number> = {elder: 0, ceo: 1, executive: 2, lead: 3, manager: 4, worker: 5, support: 5};
const TERMINAL = new Set(['succeeded', 'failed', 'interrupted', 'uncertain']);

function required(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 100_000) throw new DomainError('invalid_input', `${label} must be nonempty text`);
  return value.trim();
}
function finite(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? value : fallback; }
export const instructionsHash=(instructions:string)=>createHash('sha256').update(instructions).digest('hex');

/** The sole application writer. Public commands validate authority; put/update are trusted supervisor APIs. */
export class CompanyStore {
  readonly dataRoot: string;
  readonly db: Database.Database;
  readonly events = new EventEmitter();
  readonly vault: KnowledgeVault;

  constructor(dataRoot: string) {
    this.dataRoot = resolve(dataRoot);
    for (const dir of ['', 'workspaces', 'runtime', 'logs', 'backups']) mkdirSync(resolve(this.dataRoot, dir), {recursive: true, mode: 0o700});
    this.db = new Database(resolve(this.dataRoot, 'company.sqlite'));
    migrate(this.db);
    try { this.vault = new KnowledgeVault(this); } catch (error) { this.db.close(); throw error; }
  }

  get<T extends TableName>(table: T, id: string): Tables[T] | undefined {
    this.table(table);
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id) as {data: string} | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  need<T extends TableName>(table: T, id: string): Tables[T] { const item = this.get(table, id); if (!item) throw new DomainError('not_found', `${table} record ${id} does not exist`, 404); return item; }
  list<T extends TableName>(table: T): Tables[T][] {
    this.table(table);
    return (this.db.prepare(`SELECT data FROM ${table} ORDER BY created_at,rowid`).all() as {data: string}[]).map(row => JSON.parse(row.data));
  }
  put<T extends TableName>(table: T, value: Partial<Tables[T]> & Record<string, any>): Tables[T] {
    this.table(table);
    const record = { ...value, id: value.id ?? randomUUID(), createdAt: value.createdAt ?? NOW(), updatedAt: NOW() } as Tables[T];
    this.db.prepare(`INSERT INTO ${table}(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(record.id, JSON.stringify(record));
    return record;
  }
  update<T extends TableName>(table: T, id: string, patch: Partial<Tables[T]> & Record<string, any>): Tables[T] {
    const old = this.need(table, id);
    return this.put(table, {...old, ...patch, id: old.id, createdAt: old.createdAt});
  }
  private table(table: TableName) { if (!TABLES.includes(table)) throw new DomainError('invalid_table', 'Unknown state collection'); }
  get company() { const value = this.list('company')[0]; if (!value) throw new DomainError('uninitialized', 'Initialize company first'); return value; }
  get policy() { const value = this.list('policy')[0]; if (!value) throw new DomainError('uninitialized', 'Initialize policy first'); return value; }

  bootstrap(): CompanySnapshot {
    this.db.transaction(() => {
      if (this.list('company').length) return;
      const company = this.put('company', {name: 'OpenCorp', state: 'forming', bootstrap: 'founders-created', mandate: 'Independently manage and develop WalkLang, paletteWOW, and OpenJob. Leadership chooses strategy, staffing and subsequent useful work. Autonomous reviewed merges, zero-incremental-cost releases and product communications are authorized. New spending requires explicit Owner approval. All employee inference runs locally.'});
      this.put('policy', {companyId: company.id, revision: 1, spendingLimit: 0, localOnly: true, maxInference: 1, nativeJobs: 1, maxRetries: 1, maxCorrections: 2, reassessMinutes: 30, allowedRepositories: [resolve(homedir(), 'Desktop/dev/WalkLang'), resolve(homedir(), 'Desktop/dev/paletteWOW'), resolve(homedir(), 'Desktop/dev/openjob')]});
      for (const [name, repository] of [['WalkLang',resolve(homedir(), 'Desktop/dev/WalkLang')], ['paletteWOW',resolve(homedir(), 'Desktop/dev/paletteWOW')], ['OpenJob',resolve(homedir(), 'Desktop/dev/openjob')]]) this.put('products', {name, repository, assessment: '', goals: [], roadmap: [], status: 'unassessed', priority: 0, rationale: ''});
      for (const [name, title, level, modelId] of [['Mara Chen','Elder — Product Judgment','elder',LARGE], ['Elias Stone','Elder — Engineering Judgment','elder',ALTERNATIVE], ['Priya Shah','Elder — Operational Judgment','elder',LARGE], ['Alex Mercer','Chief Executive Officer','ceo',LARGE]] as const) {
        const position = this.put('positions', {title, level, departmentId: null, responsibilities: level === 'elder' ? 'Independently assess executive judgment and product outcomes. Form initial votes before reading other Elders. Appoint executives by two of three votes.' : 'Choose and execute useful portfolio strategy through persistent specialists. Propose executives to Elders. Lead concrete product delivery and subsequent work.', status: 'active'});
        const employee = this.put('employees', {name, badge: `OC-${String(this.list('employees').length + 1).padStart(4,'0')}`, status: 'active', positionId: position.id, departmentId: null, homeManagerId: null, modelId, role: position.responsibilities, roleVersion: 1});
        this.put('appointments', {employeeId: employee.id, positionId: position.id, startedAt: NOW(), endedAt: null, decisionId: null, acting: false, basis: 'Owner founding mandate'});
        this.put('roleVersions', {employeeId: employee.id, version: 1, content: employee.role, source: 'Owner build contract', authorId: 'owner'});
      }
      this.emit('company.founded', {companyId: company.id});
    })();
    this.vault.initialize();
    return this.snapshot();
  }

  emit(type: string, payload: any): CompanyEvent {
    const event = {id: 0, type, payload, createdAt: NOW()};
    event.id = Number(this.db.prepare('INSERT INTO events(type,payload,created_at) VALUES(?,?,?)').run(type, JSON.stringify(payload), event.createdAt).lastInsertRowid);
    // Emission follows the current synchronous transaction's commit before listeners read state.
    queueMicrotask(() => this.events.emit('event', event));
    return event;
  }
  eventLog(after = 0, limit = 200): CompanyEvent[] {
    return (this.db.prepare('SELECT * FROM events WHERE id>? ORDER BY id LIMIT ?').all(after, Math.min(2000,limit)) as {id:number;type:string;payload:string;created_at:string}[]).map(row => ({id:row.id,type:row.type,payload:JSON.parse(row.payload),createdAt:row.created_at}));
  }
  snapshot(actor?: Actor): CompanySnapshot {
    const output: any = {};
    for (const table of TABLES) output[table] = ['company','policy'].includes(table) ? this.list(table)[0] : this.list(table);
    Object.assign(output, employeeNarrativeProjection(output));
    if (actor?.kind === 'employee') {
      this.validateActor(actor);
      const voted = new Set(output.votes.filter((vote: any) => vote.employeeId === actor.employeeId).map((vote: any) => vote.decisionId));
      const finalizedForCEO = new Set(this.level(actor.employeeId)==='ceo'?output.decisions.filter((decision:any)=>['approved','rejected'].includes(decision.status)&&decision.eligibleElders?.length===3&&decision.eligibleElders.every((id:string)=>output.votes.some((vote:any)=>vote.decisionId===decision.id&&vote.employeeId===id&&vote.phase==='initial'))).map((decision:any)=>decision.id):[]);
      output.votes = output.votes.filter((vote: any) => vote.employeeId === actor.employeeId || voted.has(vote.decisionId) || finalizedForCEO.has(vote.decisionId));
      const blind=new Set(output.decisions.filter((decision:any)=>decision.eligibleElders?.includes(actor.employeeId)&&!voted.has(decision.id)).map((decision:any)=>decision.id));
      const blindPeers=new Set(output.decisions.filter((decision:any)=>blind.has(decision.id)).flatMap((decision:any)=>(decision.eligibleElders??[]).filter((id:string)=>id!==actor.employeeId)));
      output.employees=output.employees.map((employee:any)=>blindPeers.has(employee.id)?{...employee,modelRationale:undefined,modelChange:undefined}:employee);
      const hiddenAssignments=new Set(output.assignments.filter((assignment:any)=>assignment.employeeId!==actor.employeeId&&assignment.kind==='governance'&&blind.has(assignment.payload?.decisionId)).map((assignment:any)=>assignment.id));
      const recoveryOrigin=(assignment:any)=>assignment.schedulerKey?.startsWith('fault:')?assignment.payload?.failedAssignmentId:assignment.schedulerKey?.startsWith('dependency-wait:')?assignment.payload?.blockedAssignmentId:undefined;
      const hiddenRuns=new Set(output.runs.filter((run:any)=>hiddenAssignments.has(run.assignmentId)).map((run:any)=>run.id));
      // A peer may propose follow-up work after voting. Its proposal can disclose
      // that initial judgment, so withhold it from Elders who have not voted yet.
      // Legacy decision records retain an auditable run link in corporateCommands.
      const decisionRuns=new Map(output.runs.flatMap((run:any)=>(run.corporateCommands??[]).filter((command:any)=>command.type==='decision.create').map((command:any)=>[command.id,run.id])));
      // Follow-up governance tasks can carry the hidden judgment in their title,
      // then produce further decisions. Carry that origin through descendants.
      let hiddenChanged=true;
      while(hiddenChanged){
        const before=hiddenAssignments.size+hiddenRuns.size;
        const hiddenDecisions=new Set(output.decisions.filter((decision:any)=>hiddenRuns.has(decision.runId??decisionRuns.get(decision.id))).map((decision:any)=>decision.id));
        for(const assignment of output.assignments)if(assignment.kind==='governance'&&hiddenDecisions.has(assignment.payload?.decisionId)||hiddenAssignments.has(recoveryOrigin(assignment)))hiddenAssignments.add(assignment.id);
        for(const run of output.runs)if(hiddenAssignments.has(run.assignmentId))hiddenRuns.add(run.id);
        hiddenChanged=before!==hiddenAssignments.size+hiddenRuns.size;
      }
      output.decisions=output.decisions.filter((decision:any)=>!hiddenRuns.has(decision.runId??decisionRuns.get(decision.id)));
      // Before the Elder's initial vote, even outcome counts and rationale from peers stay hidden.
      output.decisions = output.decisions.map((decision: any) => decision.eligibleElders?.includes(actor.employeeId) && !voted.has(decision.id) ? {...decision, status: 'awaiting_your_independent_vote', result: undefined} : decision);
    }
    output.decisions=output.decisions.map((decision:any)=>['executive.appoint','executive.replace'].includes(decision.kind)?{...decision,appointmentEffect:this.appointmentEffect(decision,output.employees,output.positions,output.appointments)}:decision);
    const recent = this.db.prepare('SELECT id FROM events ORDER BY id DESC LIMIT 1').get() as {id:number} | undefined;
    output.events = this.eventLog(Math.max(0,(recent?.id ?? 0)-200));
    if (actor?.kind === 'employee') output.events = output.events.filter((event: CompanyEvent) => !event.type.startsWith('decision.'));
    output.resources = {activeRuns: output.runs.filter((r: EmployeeRun) => r.status === 'running').length, inferenceSlots: output.policy.maxInference, nativeJobs: output.policy.nativeJobs, localOnly: true, spendingLimit: output.policy.spendingLimit};
    return output;
  }

  /** Read-time explanation of the same explicit-ID branch used by applyGovernance.
   * Display-name matches never select an identity or change the retained proposal. */
  private appointmentEffect(decision:any,employees:Employee[],positions:Tables['positions'][],appointments:Tables['appointments'][]){
    const payload=decision.payload??{},candidateKind=payload.employeeId?'existing_employee':'new_employee',candidate=payload.employeeId?employees.find(e=>e.id===payload.employeeId):undefined,position=positions.find(p=>p.id===payload.positionId);
    const display=(value:unknown)=>typeof value==='string'&&value.length>120?`${value.slice(0,120)}…`:String(value??'unspecified');
    const name=candidateKind==='existing_employee'?candidate?.name??null:typeof payload.name==='string'?payload.name.trim():payload.name??null,appliedIds=new Set(appointments.filter(a=>a.decisionId===decision.id).map(a=>a.employeeId));
    const matches=candidateKind==='new_employee'?employees.filter(e=>e.status==='active'&&e.name===name&&!appliedIds.has(e.id)).map(e=>({employeeId:e.id,badge:e.badge,name:e.name,positionId:e.positionId,positionTitle:positions.find(p=>p.id===e.positionId)?.title??null,identityAndPositionUnchanged:!(decision.kind==='executive.replace'&&e.positionId===payload.positionId)})):[];
    const target=`${display(position?.title)} (${display(payload.positionId)})`;
    let summary=candidateKind==='new_employee'?`Approval would create a new employee named ${display(name)} with a new employee ID in ${target}.`:`Approval would appoint existing employee ${display(name)} (${display(payload.employeeId)}) to ${target}, preserving that employee ID.`;
    if(decision.kind==='executive.replace')summary+=' The current target-position occupant, if any, would be dismissed first.';
    for(const match of matches.slice(0,3))summary+=match.identityAndPositionUnchanged?` Existing ${display(match.name)} (${match.badge}, ${match.employeeId}) retains ${display(match.positionTitle)} (${match.positionId}) and the same employee ID.`:` Existing ${display(match.name)} (${match.badge}, ${match.employeeId}) occupies the replacement target and would be dismissed.`;
    if(matches.length>3)summary+=` ${matches.length-3} additional same-name identities are listed in the retained decision detail view.`;
    return {candidateKind,candidateEmployeeId:payload.employeeId||null,candidateName:name,targetPositionId:payload.positionId??null,targetPositionTitle:position?.title??null,summary,sameNameExistingEmployees:matches,derived:true,validation:'This explains candidate identity semantics; normal appointment validation still applies.'};
  }

  level(employeeId: string): PositionLevel { const employee = this.need('employees',employeeId); return this.need('positions',employee.positionId).level; }
  validateActor(actor: Actor, effect = false): Employee | undefined {
    if (actor.kind === 'owner') return undefined;
    const employee = this.need('employees', actor.employeeId);
    const run = this.need('runs', actor.runId);
    if (employee.status !== 'active' || run.employeeId !== employee.id || run.tokenRevoked || run.status !== 'running') throw new DomainError('revoked_authority', 'Employee run is inactive or execution authority was revoked',403);
    if (actor.policyRevision !== this.policy.revision || run.policyRevision !== this.policy.revision) throw new DomainError('stale_policy', 'Run policy is stale; management must redispatch',403);
    if (this.company.state !== 'running') throw new DomainError('company_not_running', `Company is ${this.company.state}; ${effect ? 'external effects' : 'worker commands'} are paused`,409);
    return employee;
  }
  private requireLevel(actor: Actor, levels: PositionLevel[]) {
    if (actor.kind !== 'owner' && !levels.includes(this.level(actor.employeeId))) throw new DomainError('forbidden', 'Organizational position does not authorize this operation',403);
  }
  canManage(actor: Actor, employeeId: string): boolean {
    if (actor.kind === 'owner') return true;
    if (employeeId === actor.employeeId || this.level(actor.employeeId) === 'elder') return false;
    let subject: Employee | undefined = this.need('employees',employeeId);
    const seen = new Set<string>();
    while (subject?.homeManagerId) {
      if (seen.has(subject.id)) break;
      seen.add(subject.id);
      if (subject.homeManagerId === actor.employeeId) return true;
      subject = this.get('employees',subject.homeManagerId);
    }
    return this.level(actor.employeeId) === 'ceo' && !['ceo','elder'].includes(this.level(employeeId));
  }
  private manager(actor: Actor, employeeId: string) { if (!this.canManage(actor, employeeId)) throw new DomainError('forbidden','Only the responsible home management chain may change this employee',403); }
  /** Only the scheduler can write schedulerKey; a caller-authored payload grants no authority. */
  faultContext(runId:string){
    const run=this.get('runs',runId),diagnosis=run?this.get('assignments',run.assignmentId):undefined;
    const failedRun=diagnosis?.payload?.failedRunId?this.get('runs',diagnosis.payload.failedRunId):undefined;
    const assignment=failedRun?this.get('assignments',failedRun.assignmentId):undefined;
    if(!run||!diagnosis||diagnosis.kind!=='management'||!failedRun||failedRun.status!=='failed'||diagnosis.schedulerKey!==`fault:${failedRun.id}`||!assignment||assignment.schedulerKey?.startsWith('fault:')||diagnosis.payload.failedAssignmentId!==assignment.id||assignment.supervisorId!==run.employeeId||diagnosis.employeeId!==run.employeeId||this.list('runs').filter(r=>r.assignmentId===assignment.id).at(-1)?.id!==failedRun.id)return;
    if(['completed','cancelled'].includes(assignment.status))return;
    if(assignment.kind==='governance'&&this.list('votes').some(v=>v.decisionId===assignment.payload?.decisionId&&v.employeeId===failedRun.employeeId))return;
    return {diagnosis,failedRun,assignment};
  }
  private projectAuthority(actor: Actor, projectId: string) {
    const project = this.need('projects',projectId);
    if (actor.kind !== 'owner' && actor.employeeId !== project.supervisorId && !this.canManage(actor,project.supervisorId)) throw new DomainError('forbidden','Only the project supervisor or supervising management may direct this project',403);
    return project;
  }
  private reporting(employeeId: string, managerId: string | null) {
    let cursor = managerId;
    const seen = new Set<string>([employeeId]);
    while (cursor) {
      if (seen.has(cursor)) throw new DomainError('management_cycle','Reporting relationships cannot contain cycles');
      seen.add(cursor);
      const manager = this.need('employees',cursor);
      if (manager.status !== 'active' || !['ceo','executive','lead','manager'].includes(this.level(cursor))) throw new DomainError('invalid_manager','Home manager must be active in a management position');
      cursor = manager.homeManagerId;
    }
  }
  private localModel(modelId: string) {
    if (/cloud|openai|anthropic|openrouter|https?:/i.test(modelId)) throw new DomainError('hosted_inference_denied','All inference must use an installed permitted local model',403);
    const model = this.list('models').find(item => item.id === modelId || item.name === modelId);
    if (!model || !model.local || !model.available || !model.artifactIdentity) throw new DomainError('unavailable_model','Model must be an available verified local artifact',409);
  }

  command(actor: Actor, command: CorporateCommand): any {
    if (!command || typeof command.type !== 'string') throw new DomainError('invalid_command','Command type is required');
    this.validateActor(actor);
    const result = this.db.transaction(() => this.executeCommand(actor,command))();
    if (actor.kind==='employee') { const run=this.need('runs',actor.runId); this.update('runs',run.id,{corporateCommands:[...(run.corporateCommands ?? []),{type:command.type,id:result?.id ?? null,at:NOW()}]}); }
    this.emit(command.type, {actorId: actor.kind === 'owner' ? 'owner' : actor.employeeId, runId:actor.kind==='employee'?actor.runId:null, id: result?.id ?? null});
    if (/employee|role|department|project/.test(command.type)) this.vault.syncProfiles();
    return result;
  }

  recordBlockedDiagnosis(actor:Actor,input:{blockedReason:string;rationale:string;remainingPrerequisite:string}){
    const result=this.db.transaction(()=>{
      this.validateActor(actor);
      if(actor.kind!=='employee')throw new DomainError('diagnosis_required','An active supervisor diagnosis run is required',403);
      const fault=this.faultContext(actor.runId);
      if(!fault||fault.diagnosis.status!=='running'||fault.assignment.status!=='blocked')throw new DomainError('diagnosis_required','This run must be the active trusted diagnosis of its latest failed assignment, which must still be blocked',403);
      const blockedReason=required(input.blockedReason,'Precise blocked reason'),rationale=required(input.rationale,'Diagnosis rationale'),remainingPrerequisite=required(input.remainingPrerequisite,'Remaining prerequisite');
      if(blockedReason===fault.diagnosis.payload.baselineBlockedReason||blockedReason===fault.assignment.blockedReason)throw new DomainError('unchanged_diagnosis','Record a new precise blocked reason from observed evidence, not the existing or initial failure reason');
      const assignment=this.executeCommand(actor,{type:'assignment.update',assignmentId:fault.assignment.id,blockedReason,rationale});
      const decision=this.executeCommand(actor,{type:'decision.create',kind:'strategy',subject:`Blocked diagnosis: ${fault.assignment.title}`,rationale,payload:{failedRunId:fault.failedRun.id,failedAssignmentId:fault.assignment.id,disposition:'blocked',remainingPrerequisite}});
      const run=this.need('runs',actor.runId);
      this.update('runs',run.id,{corporateCommands:[...(run.corporateCommands??[]),{type:'assignment.update',id:assignment.id,at:NOW()},{type:'decision.create',id:decision.id,at:NOW()}]});
      return {assignment,decision};
    })();
    // Notify only after both records and their current-run receipts have committed.
    for(const [type,record] of [['assignment.update',result.assignment],['decision.create',result.decision]] as const)this.emit(type,{actorId:actor.kind==='employee'?actor.employeeId:'owner',runId:actor.kind==='employee'?actor.runId:null,id:record.id});
    return result;
  }

  private executeCommand(actor: Actor, c: CorporateCommand): any {
    const authorId = actor.kind === 'owner' ? 'owner' : actor.employeeId;
    switch (c.type) {
      case 'control': {
        if (actor.kind !== 'owner') throw new DomainError('owner_required','Lifecycle is an Owner control',403);
        const states: Record<string,string> = {start:'running',resume:'running',pause:'paused',stop:'stopped'};
        if (!states[c.action]) throw new DomainError('invalid_control','Use start, resume, pause or stop');
        this.update('company',this.company.id,{state: states[c.action] as any});
        if (c.action === 'pause' || c.action === 'stop') for (const run of this.list('runs').filter(item => item.status === 'running' || item.status === 'queued')) this.revokeRun(run.id,c.action);
        return this.snapshot();
      }
      case 'policy.update': {
        if (actor.kind !== 'owner') throw new DomainError('owner_required','Owner policy cannot be changed by employees',403);
        if (c.localOnly === false || (c.spendingLimit !== undefined && c.spendingLimit !== 0) || c.allowedRepositories !== undefined) throw new DomainError('reserved_policy','Initial release remains local-only with $0 unapproved allowance and its registered access envelope; approve a concrete action separately',403);
        const patch: any = {revision:this.policy.revision+1};
        for (const [key,max] of [['maxInference',2],['nativeJobs',1],['maxRetries',1],['maxCorrections',2],['reassessMinutes',1440]] as const) if (c[key] !== undefined) { if (!Number.isInteger(c[key]) || c[key] < (key === 'maxRetries' ? 0 : 1) || c[key] > max) throw new DomainError('invalid_limit',`${key} is outside permitted release limits`); patch[key] = c[key]; }
        if (patch.maxInference===2 && (!this.policy.concurrencyQualification?.passed || !this.policy.concurrencyQualification?.largePlusSmall || !this.policy.concurrencyQualification?.evidence)) throw new DomainError('qualification_required','Two inference slots require a retained realistic large-plus-small local qualification first');
        return this.update('policy',this.policy.id,patch);
      }
      case 'product.assess':
      case 'product.goal': {
        this.requireLevel(actor,['ceo','executive','lead','manager']);
        const product = this.need('products',c.productId);
        const rationale = required(c.rationale,'Rationale');
        const patch: any = {rationale, lastAssessedAt:NOW()};
        if (c.type === 'product.assess') { patch.assessment=required(c.assessment,'Assessment'); patch.status=c.status ?? 'active'; }
        else { if (!Array.isArray(c.goals) || c.goals.length === 0) throw new DomainError('invalid_goals','Goals must include concrete success measures'); patch.goals=c.goals; }
        if (c.roadmap !== undefined) { if (!Array.isArray(c.roadmap)) throw new DomainError('invalid_roadmap','Roadmap must be an array'); patch.roadmap=c.roadmap; }
        if (c.priority !== undefined) patch.priority=finite(c.priority,0);
        this.put('decisions',{authorId,subject:product.name,rationale,kind:c.type,payload:patch,status:'recorded',policyRevision:this.policy.revision});
        return this.update('products',product.id,patch);
      }
      case 'department.create': {
        this.requireLevel(actor,['ceo','executive']);
        const managerId = c.managerId ?? (actor.kind === 'employee' ? actor.employeeId : undefined);
        if (!managerId || !['ceo','executive','lead'].includes(this.level(managerId))) throw new DomainError('invalid_manager','A department needs active executive or lead responsibility');
        if (actor.kind !== 'owner' && actor.employeeId !== managerId) this.manager(actor,managerId);
        return this.put('departments',{name:required(c.name,'Name'),managerId,responsibilities:required(c.responsibilities,'Responsibilities')});
      }
      case 'position.create': {
        this.requireLevel(actor,['ceo','executive','lead','manager']);
        const level = c.level as PositionLevel;
        if (typeof level!=='string' || !Object.hasOwn(LEVEL,level) || level === 'elder' || level === 'ceo') throw new DomainError('reserved_position','Founding governance positions cannot be created through ordinary staffing');
        if (actor.kind !== 'owner' && LEVEL[level] <= LEVEL[this.level(actor.employeeId)] && !(this.level(actor.employeeId)==='ceo' && level==='executive')) throw new DomainError('forbidden','Cannot create a position above your organizational authority',403);
        if (c.departmentId) { const department=this.need('departments',c.departmentId); if (actor.kind!=='owner' && department.managerId!==actor.employeeId) this.manager(actor,department.managerId); }
        return this.put('positions',{title:required(c.title,'Title'),level,departmentId:c.departmentId ?? null,responsibilities:required(c.responsibilities,'Responsibilities'),status:'active'});
      }
      case 'employee.hire': {
        this.requireLevel(actor,['ceo','executive','lead','manager']);
        const position=this.need('positions',c.positionId);
        if (['elder','ceo','executive'].includes(position.level)) throw new DomainError('governance_required','Executive appointments require independent Elder majority',403);
        const managerId=c.homeManagerId ?? (actor.kind==='employee'?actor.employeeId:null);
        if (!managerId) throw new DomainError('invalid_manager','Nonexecutive staff require a home manager');
        if (actor.kind!=='owner' && managerId!==actor.employeeId) this.manager(actor,managerId);
        if (position.departmentId) { const department=this.need('departments',position.departmentId); if (actor.kind!=='owner' && department.managerId!==actor.employeeId) this.manager(actor,department.managerId); }
        if (LEVEL[position.level] <= LEVEL[this.level(managerId)]) throw new DomainError('invalid_position','Staff position must report below its manager');
        this.localModel(required(c.modelId,'Local model'));
        return this.hire(c,position.id,managerId,null);
      }
      case 'employee.appoint': {
        const employee=this.need('employees',c.employeeId); this.manager(actor,employee.id);
        if (employee.status!=='active') throw new DomainError('inactive_employee','Dismissed employees cannot be promoted');
        const position=this.need('positions',c.positionId);
        if (['elder','ceo','executive'].includes(position.level) || ['elder','ceo','executive'].includes(this.level(employee.id))) throw new DomainError('governance_required','Executive appointment changes require Elders; Elder changes require Owner',403);
        if (actor.kind!=='owner' && LEVEL[position.level] <= LEVEL[this.level(actor.employeeId)]) throw new DomainError('forbidden','Cannot promote someone to your own or higher authority',403);
        const managerId=c.homeManagerId ?? employee.homeManagerId;
        this.reporting(employee.id,managerId);
        return this.appoint(employee.id,position.id,managerId,null,Boolean(c.acting));
      }
      case 'employee.reassign': {
        const employee=this.need('employees',c.employeeId); this.manager(actor,employee.id);
        if (['elder','ceo','executive'].includes(this.level(employee.id))) throw new DomainError('governance_required','Executive relationships require governance',403);
        const managerId=required(c.homeManagerId,'Home manager'); this.reporting(employee.id,managerId);
        if (actor.kind!=='owner' && managerId!==actor.employeeId) this.manager(actor,managerId);
        const manager=this.need('employees',managerId);
        return this.update('employees',employee.id,{homeManagerId:managerId,departmentId:c.departmentId ?? manager.departmentId});
      }
      case 'employee.model': {
        const fault=actor.kind==='employee'?this.faultContext(actor.runId):undefined;
        const selfDiagnosis=actor.kind==='employee'&&c.employeeId===actor.employeeId&&['ceo','elder'].includes(this.level(actor.employeeId))&&fault?.assignment.status==='blocked'&&fault.failedRun.employeeId===actor.employeeId&&fault.assignment.employeeId===actor.employeeId;
        if(!selfDiagnosis)this.manager(actor,c.employeeId); this.localModel(required(c.modelId,'Local model'));
        if (this.need('employees',c.employeeId).status!=='active') throw new DomainError('inactive_employee','Dismissed employees cannot be reassigned');
        return this.update('employees',c.employeeId,{modelId:c.modelId,modelRationale:required(c.rationale,'Rationale'),modelChange:{priorModelId:this.need('employees',c.employeeId).modelId,modelId:c.modelId,runId:actor.kind==='employee'?actor.runId:null,at:NOW()}});
      }
      case 'employee.dismiss': {
        this.manager(actor,c.employeeId);
        if (['elder','ceo','executive'].includes(this.level(c.employeeId))) throw new DomainError('governance_required','Executive dismissal requires Elders; Elder replacement requires Owner',403);
        return this.dismiss(c.employeeId,required(c.rationale,'Rationale'));
      }
      case 'elder.replace': {
        if (actor.kind!=='owner') throw new DomainError('owner_required','Only Owner may replace an Elder',403);
        const previous=this.need('employees',c.employeeId);
        if (this.level(previous.id)!=='elder') throw new DomainError('invalid_elder','Employee does not hold an Elder seat');
        this.localModel(required(c.modelId,'Local model'));
        this.dismiss(previous.id,required(c.rationale,'Rationale'));
        const replacement=this.hire(c,previous.positionId,null,null);
        for (const decision of this.list('decisions').filter(d=>d.status==='pending' && d.eligibleElders?.includes(previous.id))) this.update('decisions',decision.id,{status:'superseded',rationale:`${decision.rationale}\nElder membership changed; create a fresh independent decision.`});
        return replacement;
      }
      case 'project.create': {
        this.requireLevel(actor,['ceo','executive','lead','manager']);
        if (c.productId) this.need('products',c.productId);
        const supervisorId=c.supervisorId ?? (actor.kind==='employee'?actor.employeeId:null);
        if (!supervisorId || !['ceo','executive','lead','manager'].includes(this.level(supervisorId))) throw new DomainError('invalid_supervisor','Project needs an active manager');
        if (actor.kind!=='owner' && actor.employeeId!==supervisorId) this.manager(actor,supervisorId);
        return this.put('projects',{name:required(c.name,'Name'),productId:c.productId ?? null,outcome:required(c.outcome,'Outcome'),acceptance:this.acceptance(c.acceptance),supervisorId,status:'active',priority:finite(c.priority,0),rationale:required(c.rationale,'Rationale')});
      }
      case 'project.update': {
        const project=this.projectAuthority(actor,c.projectId);
        const patch: any={rationale:required(c.rationale,'Rationale')};
        for (const field of ['outcome','priority','status','acceptance']) if (c[field]!==undefined) patch[field]=c[field];
        if (c.supervisorId) { const supervisor=this.need('employees',c.supervisorId); if (supervisor.status!=='active'||!['ceo','executive','lead','manager'].includes(this.level(supervisor.id))) throw new DomainError('invalid_supervisor','Select an active project manager'); if (actor.kind!=='owner'&&actor.employeeId!==supervisor.id) this.manager(actor,supervisor.id); patch.supervisorId=supervisor.id; }
        if (patch.status && !['active','parked','blocked','completed','cancelled'].includes(patch.status)) throw new DomainError('invalid_status','Invalid project status');
        if (patch.acceptance) this.acceptance(patch.acceptance);
        const acceptance=patch.acceptance??project.acceptance;
        const acceptanceChanged=JSON.stringify(acceptance)!==JSON.stringify(project.acceptance);
        if(acceptanceChanged){patch.acceptanceHistory=[...(project.acceptanceHistory??[]),{acceptance:project.acceptance,rationale:patch.rationale,actorId:authorId,runId:actor.kind==='employee'?actor.runId:null,at:NOW()}];patch.completionEvidence=[];if(project.status==='completed'&&!patch.status)patch.status='active';}
        if(c.completionEvidence!==undefined||patch.status==='completed'){
          const submitted=c.completionEvidence??(acceptanceChanged?[]:project.completionEvidence??[]);
          if(!Array.isArray(submitted))throw new DomainError('invalid_completion_evidence','completionEvidence must be an array of criterion, rationale and retained sources');
          const seen=new Set<string>();
          patch.completionEvidence=submitted.map((entry:any)=>{
            if(!entry||typeof entry.criterion!=='string'||!acceptance.includes(entry.criterion)||seen.has(entry.criterion))throw new DomainError('invalid_completion_evidence','Each evidence entry must name a distinct exact current project acceptance criterion');
            seen.add(entry.criterion);
            if(!Array.isArray(entry.sources)||!entry.sources.length)throw new DomainError('invalid_completion_evidence',`Retained outcome sources are required for ${entry.criterion}`);
            return {criterion:entry.criterion,rationale:required(entry.rationale,'Completion rationale'),sources:entry.sources.map((source:any)=>this.completionSource(project,entry.criterion,source))};
          });
          if((patch.status??project.status)==='completed'){
            const missing=acceptance.filter((criterion:string)=>!seen.has(criterion));
            if(missing.length)throw new DomainError('project_acceptance_unmet',`Project remains incomplete; evidence is required for: ${missing.join('; ')}`);
            patch.completion={actorId:authorId,runId:actor.kind==='employee'?actor.runId:null,at:NOW(),acceptance:[...acceptance]};
          }
        }
        if (patch.status==='completed' && (!this.list('assignments').some(a=>a.projectId===project.id && this.assignmentCompleted(a)) || this.list('assignments').some(a=>a.projectId===project.id && a.status!=='cancelled'&&!this.assignmentCompleted(a)))) throw new DomainError('unfinished_work','Complete and review project assignments before completing its outcome');
        if(patch.completionEvidence!==undefined)patch.completionHistory=[...(project.completionHistory??[]),{evidence:project.completionEvidence??[],completion:project.completion??null,actorId:authorId,runId:actor.kind==='employee'?actor.runId:null,rationale:patch.rationale,at:NOW()}];
        if(patch.status&&patch.status!=='completed')patch.completion=null;
        if (patch.status==='cancelled') for (const assignment of this.list('assignments').filter(a=>a.projectId===project.id&&!['completed','cancelled'].includes(a.status))) this.changeAssignment({kind:'owner'},{type:'assignment.update',assignmentId:assignment.id,status:'cancelled'});
        return this.update('projects',project.id,patch);
      }
      case 'assignment.create': {
        if(c.kind==='review'&&(typeof c.projectId!=='string'||!c.projectId.trim()||typeof c.payload?.artifactId!=='string'||!c.payload.artifactId.trim()))throw new DomainError('invalid_review_scope','A review requires explicit projectId and payload.artifactId for the same existing artifact. Read company_detail artifacts with view:"record", then supply projectId and payload:{artifactId} along with employeeId, kind:"review", title, instructions and acceptance.');
        if (c.projectId) this.projectAuthority(actor,c.projectId); else this.requireLevel(actor,['ceo','executive','lead','manager','elder']);
        if(c.kind==='review'){
          const issue=this.reviewScopeIssue({kind:'review',projectId:c.projectId,employeeId:c.employeeId,payload:c.payload});
          if(issue)throw new DomainError(issue.code,issue.reason,issue.code==='independent_review_required'?403:400);
        }
        const employee=this.need('employees',c.employeeId);
        if (employee.status!=='active') throw new DomainError('inactive_employee','Cannot assign dismissed employee');
        const supervisorId=c.supervisorId ?? (c.projectId?this.need('projects',c.projectId).supervisorId:(actor.kind==='employee'?actor.employeeId:c.employeeId));
        if (actor.kind!=='owner' && supervisorId!==actor.employeeId) this.manager(actor,supervisorId);
        const dependencies=this.dependencies(c.dependencies===undefined?[]:c.dependencies);
        if(c.payload?.pullRequest!==undefined){
          const pr=c.payload.pullRequest;
          if(!c.projectId||!this.need('projects',c.projectId).productId||(c.kind??'implementation')!=='implementation'||!pr||!Number.isSafeInteger(pr.number)||pr.number<1||typeof pr.headSha!=='string'||!/^[a-f0-9]{40,64}$/.test(pr.headSha))throw new DomainError('invalid_pull_request_assignment','An existing PR requires a finite product implementation assignment with payload.pullRequest {number,headSha} observed through repo_pr');
          if(actor.kind!=='owner'&&!['ceo','executive','lead','manager'].includes(this.level(actor.employeeId)))throw new DomainError('manager_required','Supervising management must explicitly select an existing product PR',403);
        }
        const accepted=actor.kind==='owner' || employee.id===authorId || this.canManage(actor,employee.id);
        if(c.completionRequirements!==undefined&&(c.kind??'implementation')!=='implementation')throw new DomainError('invalid_completion_requirements','Structured completion requirements apply to implementation assignments');
        const acceptance=this.acceptance(c.acceptance),completionRequirements=c.completionRequirements===undefined?undefined:this.assignmentRequirements(acceptance,c.completionRequirements);
        if(completionRequirements&&actor.kind==='employee'){this.requireLevel(actor,['ceo','executive','lead','manager']);if(this.need('assignments',this.need('runs',actor.runId).assignmentId).kind==='review')throw new DomainError('requirements_manager_required','Review assignments cannot declare completion requirements',403);}
        return this.put('assignments',{projectId:c.projectId ?? null,employeeId:employee.id,supervisorId,title:required(c.title,'Title'),instructions:required(c.instructions,'Instructions'),acceptance,dependencies,status:'queued',priority:finite(c.priority,0),attempts:0,corrections:0,kind:c.kind ?? 'implementation',availableAt:NOW(),accepted,payload:c.payload ?? {},...(completionRequirements?{completionRequirements,requirementsDeclaration:{actorId:authorId,runId:actor.kind==='employee'?actor.runId:null,at:NOW(),rationale:required(c.rationale,'Completion requirement rationale')}}:{})});
      }
      case 'assignment.accept': {
        const assignment=this.need('assignments',c.assignmentId); this.manager(actor,assignment.employeeId);
        if (!['queued','blocked'].includes(assignment.status) || this.need('employees',assignment.employeeId).status!=='active') throw new DomainError('invalid_transition','Staffing decisions require queued or blocked work for an active employee');
        const approved=c.accept!==false, rationale=approved?(c.rationale ?? 'Home management accepted the shared assignment'):required(c.rationale,'Reason for declining shared staffing');
        const decision={approved,employeeId:assignment.employeeId,managerId:authorId,runId:actor.kind==='employee'?actor.runId:null,rationale,at:NOW()};
        const result=this.update('assignments',assignment.id,{accepted:approved,...(!approved?{status:'blocked',blockedReason:rationale}:{}),staffingDecision:decision,staffingDecisions:[...(assignment.staffingDecisions??[]),decision]});
        if(actor.kind==='employee'){const request=this.need('assignments',this.need('runs',actor.runId).assignmentId);if(request.schedulerKey?.startsWith('staffing:')&&request.payload?.staffingAssignmentId===assignment.id&&request.payload?.staffingEmployeeId===assignment.employeeId)this.update('assignments',request.id,{status:'completed',completedAt:NOW(),completionEvidence:{staffingAssignmentId:assignment.id,runId:actor.runId}});}
        return result;
      }
      case 'assignment.update': return this.changeAssignment(actor,c);
      case 'decision.create': {
        this.requireLevel(actor,['ceo','executive','lead','manager','elder']);
        const kind=required(c.kind,'Decision kind');
        if (kind.startsWith('executive.')) this.requireLevel(actor,['ceo','elder']);
        if (kind.startsWith('elder.') || kind.startsWith('policy.')) throw new DomainError('owner_required','Reserved Owner decisions cannot be delegated',403);
        const eligibleElders=kind.startsWith('executive.')?this.list('employees').filter(e=>e.status==='active' && this.level(e.id)==='elder').map(e=>e.id):undefined;
        if (eligibleElders && eligibleElders.length!==3) throw new DomainError('governance_unavailable','Exactly three active Elders are required');
        return this.put('decisions',{authorId,runId:actor.kind==='employee'?actor.runId:null,subject:required(c.subject,'Subject'),rationale:required(c.rationale,'Rationale'),kind,payload:c.payload ?? {},status:eligibleElders?'pending':'recorded',policyRevision:this.policy.revision,eligibleElders});
      }
      case 'decision.vote': return this.vote(actor,c);
      case 'decision.override': {
        if (actor.kind!=='owner') throw new DomainError('owner_required','Only Owner may override governance',403);
        const decision=this.need('decisions',c.decisionId);
        if (!['pending','rejected'].includes(decision.status)) throw new DomainError('closed_decision','Decision has already been applied or superseded');
        if (c.approve) this.applyGovernance(decision.id);
        return this.update('decisions',decision.id,{status:c.approve?'approved':'rejected',override:{actorId:'owner',rationale:required(c.rationale,'Rationale')}});
      }
      case 'artifact.record': {
        if (actor.kind==='owner') throw new DomainError('employee_run_required','Artifacts must be attributed to the employee run that produced them');
        const run=this.need('runs',actor.runId), assignment=this.need('assignments',run.assignmentId);
        if (c.assignmentId && c.assignmentId!==assignment.id) throw new DomainError('forbidden','Artifact must belong to the active assignment',403);
        const artifact=this.put('artifacts',{assignmentId:assignment.id,projectId:assignment.projectId,employeeId:actor.employeeId,runId:run.id,uri:required(c.uri,'Actual artifact URI'),identity:required(c.identity,'Exact artifact identity'),kind:c.kind ?? 'commit',summary:required(c.summary,'Summary'),checks:Array.isArray(c.checks)?c.checks:[]});
        if (assignment.kind!=='review') this.update('assignments',assignment.id,{status:'awaiting_review'});
        return artifact;
      }
      case 'review.record': return this.review(actor,c);
      case 'message.send': {
        if (c.projectId) this.need('projects',c.projectId);
        const recipientId=c.recipientId ?? this.list('employees').find(e=>e.status==='active'&&this.level(e.id)==='ceo')?.id ?? null;
        if (recipientId) this.need('employees',recipientId);
        return this.put('messages',{senderId:authorId,recipientId,projectId:c.projectId ?? null,content:required(c.content,'Content'),runId:actor.kind==='employee'?actor.runId:null});
      }
      case 'role.update': {
        this.manager(actor,c.employeeId); const employee=this.need('employees',c.employeeId);
        const content=required(c.content,'Role instructions');
        const role=this.put('roleVersions',{employeeId:employee.id,version:employee.roleVersion+1,content,source:required(c.source,'Source evidence'),rationale:required(c.rationale,'Rationale'),authorId});
        this.update('employees',employee.id,{role:content,roleVersion:role.version}); return role;
      }
      case 'experience.record': {
        const employeeId=c.employeeId ?? authorId;
        if (actor.kind==='employee' && employeeId!==actor.employeeId) this.manager(actor,employeeId);
        this.need('employees',employeeId);
        return this.put('experiences',{employeeId,runId:actor.kind==='employee'?actor.runId:null,summary:required(c.summary,'What happened'),source:required(c.source,'Source'),modelId:c.modelId ?? this.need('employees',employeeId).modelId,environment:c.environment ?? '',learned:required(c.learned,'What should change'),authorId});
      }
      case 'knowledge.write': return this.vault.write({...c,generated:false,authorId,runId:actor.kind==='employee'?actor.runId:null});
      case 'attention.resolve': {
        if (actor.kind!=='owner') throw new DomainError('owner_required','Owner prerequisites may only be marked resolved by Owner',403);
        return this.update('attention',c.attentionId,{status:'resolved',resolution:required(c.resolution,'Resolution')});
      }
      case 'action.approveCost': {
        if (actor.kind!=='owner') throw new DomainError('owner_required','New spending requires explicit Owner approval',403);
        const action=this.need('actions',c.actionId);
        if (action.status!=='blocked' || typeof c.amount!=='number' || c.amount<0 || action.cost===null || c.amount<action.cost) throw new DomainError('invalid_approval','Approval requires a prepared concrete action and its stated cost');
        const description=required(c.description,'Approved expenditure');
        const approved=this.update('actions',action.id,{status:'prepared',costApproval:{amount:c.amount,description,approvedAt:NOW(),actionId:action.id}});
        for (const attention of this.list('attention').filter(a=>a.actionId===action.id&&a.kind==='spending'&&a.status==='open')) this.update('attention',attention.id,{status:'resolved',resolution:`Owner approved this action up to ${c.amount}: ${description}`,resolvedAt:NOW()});
        return approved;
      }
      default: throw new DomainError('unknown_command',`Unknown corporate command: ${c.type}`);
    }
  }

  private acceptance(value: unknown): string[] { if (!Array.isArray(value) || !value.length || value.some(v=>typeof v!=='string'||!v.trim())) throw new DomainError('invalid_acceptance','Nonempty concrete acceptance conditions are required'); return value; }
  private dependencies(value:unknown,assignmentId?:string):string[] {
    if(!Array.isArray(value)||value.some(id=>typeof id!=='string'||!id.trim())||new Set(value).size!==value.length)throw new DomainError('invalid_dependencies','Dependencies must be an explicit array of distinct existing assignment IDs; use [] for no completion prerequisites');
    const visiting=new Set<string>(),visited=new Set<string>();
    const visit=(id:string)=>{
      if(id===assignmentId||visiting.has(id))throw new DomainError('dependency_cycle','Dependencies cannot include this assignment or form a transitive cycle');
      if(visited.has(id))return;
      const prerequisite=this.need('assignments',id);visiting.add(id);
      if(!Array.isArray(prerequisite.dependencies))throw new DomainError('invalid_dependencies',`Prerequisite ${id} has invalid retained dependencies; supervising management must repair them`);
      for(const dependency of prerequisite.dependencies)visit(dependency);
      visiting.delete(id);visited.add(id);
    };
    for(const id of value)visit(id);
    return [...value];
  }
  private hire(c: CorporateCommand, positionId: string, managerId: string | null, decisionId: string | null): Employee {
    const position=this.need('positions',positionId);
    if (this.list('appointments').some(a=>a.positionId===positionId && !a.endedAt)) throw new DomainError('occupied_position','Position already has an active appointment');
    const employee=this.put('employees',{name:required(c.name,'Name'),badge:`OC-${String(this.list('employees').length+1).padStart(4,'0')}`,status:'active',positionId,departmentId:position.departmentId,homeManagerId:managerId,modelId:required(c.modelId,'Model'),role:c.role ?? position.responsibilities,roleVersion:1});
    this.reporting(employee.id,managerId);
    this.put('appointments',{employeeId:employee.id,positionId,startedAt:NOW(),endedAt:null,decisionId,acting:Boolean(c.acting)});
    this.put('roleVersions',{employeeId:employee.id,version:1,content:employee.role,source:c.source ?? 'Leadership appointment',authorId:decisionId ?? managerId ?? 'owner'});
    return employee;
  }
  private appoint(employeeId: string, positionId: string, managerId: string | null, decisionId: string | null, acting=false): Employee {
    if (this.need('employees',employeeId).status!=='active') throw new DomainError('inactive_employee','Dismissed employees cannot hold new appointments');
    const position=this.need('positions',positionId);
    if (this.list('appointments').some(a=>a.positionId===positionId && !a.endedAt && a.employeeId!==employeeId)) throw new DomainError('occupied_position','Position already has an active employee');
    this.reporting(employeeId,managerId);
    for (const appointment of this.list('appointments').filter(a=>a.employeeId===employeeId&&!a.endedAt)) this.update('appointments',appointment.id,{endedAt:NOW()});
    this.put('appointments',{employeeId,positionId,startedAt:NOW(),endedAt:null,decisionId,acting});
    return this.update('employees',employeeId,{positionId,departmentId:position.departmentId,homeManagerId:managerId});
  }
  private dismiss(employeeId: string, rationale: string): Employee {
    const employee=this.need('employees',employeeId);
    if (employee.status!=='active') throw new DomainError('inactive_employee','Employee already dismissed');
    for (const appointment of this.list('appointments').filter(a=>a.employeeId===employeeId&&!a.endedAt)) this.update('appointments',appointment.id,{endedAt:NOW()});
    for (const run of this.list('runs').filter(r=>r.employeeId===employeeId&&!TERMINAL.has(r.status))) this.revokeRun(run.id,'dismissed');
    for (const assignment of this.list('assignments').filter(a=>a.employeeId===employeeId&&!['completed','cancelled'].includes(a.status))) this.update('assignments',assignment.id,{status:'blocked',blockedReason:'Employee dismissed; supervisor must reassign preserved work',accepted:false});
    for (const direct of this.list('employees').filter(e=>e.status==='active'&&e.homeManagerId===employeeId)) this.update('employees',direct.id,{homeManagerId:employee.homeManagerId,managerVacancy:true,previousManagerId:employeeId});
    this.put('attention',{kind:'staffing',title:`Reassign unfinished responsibilities from ${employee.name}`,detail:rationale,status:'open',employeeId});
    return this.update('employees',employeeId,{status:'dismissed',dismissedAt:NOW(),dismissalRationale:rationale});
  }
  private changeAssignment(actor: Actor,c: CorporateCommand) {
    const assignment=this.need('assignments',c.assignmentId);
    if (actor.kind!=='owner' && actor.employeeId!==assignment.supervisorId && !this.canManage(actor,assignment.supervisorId)) throw new DomainError('forbidden','Only supervising management may revise assignments',403);
    if(Object.hasOwn(c,'projectId')||Object.hasOwn(c,'payload'))throw new DomainError('immutable_assignment_scope','assignment.update does not support projectId or payload changes. Supervising management can cancel the old assignment with a reason and create a new correctly scoped assignment; retained history and acceptance are not rebound.');
    const patch: any={};
    if(c.completionRequirements!==undefined||c.completionEvidence!==undefined||c.status==='completed')this.requireLevel(actor,['ceo','executive','lead','manager']);
    if(c.completionRequirements!==undefined){
      if(assignment.kind!=='implementation')throw new DomainError('invalid_completion_requirements','Only implementation assignments have artifact completion requirements');
      if(actor.kind==='employee'&&this.need('assignments',this.need('runs',actor.runId).assignmentId).kind==='review')throw new DomainError('requirements_manager_required','A reviewer cannot declare or change the original completion requirements',403);
      const requirements=this.assignmentRequirements(assignment.acceptance,c.completionRequirements);
      if(assignment.completionRequirements&&JSON.stringify(requirements)!==JSON.stringify(assignment.completionRequirements))throw new DomainError('immutable_completion_requirements','Declared evidence requirements cannot be weakened or changed. Preserve this assignment and create separately scoped work when needed.');
      if(!assignment.completionRequirements){patch.completionRequirements=requirements;patch.requirementsDeclaration={actorId:actor.kind==='owner'?'owner':actor.employeeId,runId:actor.kind==='employee'?actor.runId:null,at:NOW(),rationale:required(c.rationale,'Completion requirement rationale')};}
    }
    if(c.completionEvidence!==undefined||c.status==='completed'){
      if(assignment.kind!=='implementation')throw new DomainError('invalid_completion_evidence','assignment.update status completed/completionEvidence applies only to original implementation outcomes. Finish any required corporate actions and provide your final response; the scheduler handles completion. Final prose cannot replace a required tool action.');
      if(actor.kind==='employee'&&this.need('assignments',this.need('runs',actor.runId).assignmentId).kind==='review')throw new DomainError('completion_manager_required','A review records coverage; supervising management separately confirms completion',403);
      patch.completionEvidence=this.assignmentCompletionEvidence({...assignment,...patch},c.completionEvidence??assignment.completionEvidence??[],(c.status??assignment.status)==='completed');
      patch.completionHistory=[...(assignment.completionHistory??[]),{status:assignment.status,completedAt:assignment.completedAt??null,evidence:assignment.completionEvidence??[],completion:assignment.completion??null,actorId:actor.kind==='owner'?'owner':actor.employeeId,runId:actor.kind==='employee'?actor.runId:null,at:NOW(),rationale:required(c.rationale,'Completion rationale')}];
      if(c.status==='completed')patch.completion={actorId:actor.kind==='owner'?'owner':actor.employeeId,runId:actor.kind==='employee'?actor.runId:null,at:NOW(),acceptance:[...assignment.acceptance],requirements:patch.completionRequirements??assignment.completionRequirements};
    }
    let dependencyRationale:string|undefined;
    if(c.dependencies!==undefined){
      if(!['queued','blocked','needs_changes'].includes(assignment.status))throw new DomainError('invalid_dependency_transition','Dependencies may be revised only while an assignment is queued, blocked or needs_changes');
      dependencyRationale=required(c.rationale,'Dependency rationale');
      patch.dependencies=this.dependencies(c.dependencies,assignment.id);
    }
    if (c.employeeId) { const employee=this.need('employees',c.employeeId); if (employee.status!=='active') throw new DomainError('inactive_employee','Select an active employee'); if(assignment.kind==='review'&&this.need('artifacts',assignment.payload?.artifactId).employeeId===employee.id)throw new DomainError('independent_review_required','Select an independent employee: the artifact author cannot review its own output.',403); patch.employeeId=employee.id; patch.accepted=employee.id===assignment.employeeId?assignment.accepted:actor.kind==='owner'||this.canManage(actor,employee.id); }
    for (const key of ['priority','availableAt','blockedReason']) if (c[key]!==undefined) patch[key]=c[key];
    if(c.instructions!==undefined)patch.instructions=required(c.instructions,'Revised instructions');
    const fault=actor.kind==='employee'?this.faultContext(actor.runId):undefined;
    const request=actor.kind==='employee'?this.need('assignments',this.need('runs',actor.runId).assignmentId):undefined;
    if(request?.schedulerKey?.startsWith(`acceptance:${assignment.id}:`)&&request.payload?.acceptanceAssignmentId===assignment.id&&request.payload.sourceProjectId===assignment.projectId&&['blocked','cancelled'].includes(c.status??assignment.status)&&typeof patch.blockedReason==='string'&&patch.blockedReason.trim()&&patch.blockedReason!==assignment.blockedReason){
      patch.acceptanceDisposition={actorId:actor.kind==='employee'?actor.employeeId:'owner',runId:actor.kind==='employee'?actor.runId:null,at:NOW(),status:c.status??assignment.status,blockedReason:patch.blockedReason,rationale:required(c.rationale,'Acceptance disposition rationale')};
    }
    if(request?.schedulerKey===`review-scope:${assignment.id}`&&request.projectId===null&&request.payload?.invalidReviewAssignmentId===assignment.id&&assignment.reviewScopeIssue&&['blocked','cancelled'].includes(c.status??assignment.status)&&typeof patch.blockedReason==='string'&&patch.blockedReason.trim()&&patch.blockedReason!==assignment.blockedReason){
      patch.reviewScopeDisposition={actorId:actor.kind==='employee'?actor.employeeId:'owner',runId:actor.kind==='employee'?actor.runId:null,at:NOW(),status:c.status??assignment.status,blockedReason:patch.blockedReason,rationale:required(c.rationale,'Review scope disposition rationale')};
    }
    if(request?.schedulerKey?.startsWith('fault:')&&request.payload?.failedAssignmentId===assignment.id&&!fault)throw new DomainError('stale_diagnosis','This diagnosis no longer identifies the latest failed attempt under your supervision, or its original work is completed/cancelled; inspect the current assignment before further action');
    if(fault?.assignment.id===assignment.id&&actor.kind==='employee'){
      patch.managementRationale=required(c.rationale,'Diagnosis rationale');
      const instructionChange=patch.instructions!==undefined&&patch.instructions!==assignment.instructions;
      const changedEarlier=(assignment.faultCorrections??[]).some((change:any)=>change.runId===actor.runId&&change.failedRunId===fault.failedRun.id&&change.instructionsChanged);
      const employee=this.need('employees',patch.employeeId??assignment.employeeId),modelChange=employee.modelChange;
      const changedModel=modelChange?.runId===actor.runId&&modelChange.priorModelId!==modelChange.modelId&&employee.modelId!==fault.diagnosis.payload.baselineModelId;
      const changedInstructions=(instructionChange||changedEarlier)&&instructionsHash(patch.instructions??assignment.instructions)!==fault.diagnosis.payload.baselineInstructionsHash;
      if(c.status==='queued'&&!changedModel&&!changedInstructions)throw new DomainError('unchanged_retry','Diagnosis must change the local model or revise the actual failed instructions before retrying; unchanged retry is not a correction');
      patch.faultCorrections=[...(assignment.faultCorrections??[]),{runId:actor.runId,failedRunId:fault.failedRun.id,instructionsChanged:instructionChange,instructionsHash:instructionsHash(patch.instructions??assignment.instructions),blockedReasonChanged:patch.blockedReason!==undefined&&patch.blockedReason!==assignment.blockedReason,rationale:patch.managementRationale,at:NOW()}];
    }
    if (c.supervisorId) { const supervisor=this.need('employees',c.supervisorId); if (supervisor.status!=='active'||!['ceo','executive','lead','manager'].includes(this.level(supervisor.id))) throw new DomainError('invalid_supervisor','Select an active supervising manager'); if (actor.kind!=='owner'&&actor.employeeId!==supervisor.id) this.manager(actor,supervisor.id); patch.supervisorId=supervisor.id; }
    const dispositionRationale=['blocked','cancelled'].includes(c.status)&&typeof c.rationale==='string'&&c.rationale.trim()?required(c.rationale,'Disposition rationale'):undefined;
    if (c.status) {
      const transitions: Record<string,string[]>={queued:['blocked','cancelled'],running:['blocked','cancelled'],awaiting_review:['blocked','cancelled','completed'],needs_changes:['queued','blocked','cancelled'],blocked:['queued','cancelled','completed'],completed:[],cancelled:[]};
      if (!transitions[assignment.status].includes(c.status)) throw new DomainError('invalid_transition',`Cannot move assignment from ${assignment.status} to ${c.status}`);
      if (c.status==='completed'){patch.completedAt=NOW();patch.completionPending=undefined;}
      if (c.status==='queued' && (assignment.attempts>0||assignment.corrections>0) && !c.rationale) throw new DomainError('management_decision_required','Retrying preserved work requires management to record its corrected approach or resolved fault');
      patch.status=c.status;
      if (c.status==='queued') { patch.attempts=0; patch.availableAt=NOW(); patch.managementRationale=c.rationale ?? '';patch.retryDecisions=[...(assignment.retryDecisions??[]),{priorAttempts:assignment.attempts,priorCorrections:assignment.corrections,priorStatus:assignment.status,rationale:c.rationale??'',actorId:actor.kind==='owner'?'owner':actor.employeeId,runId:actor.kind==='employee'?actor.runId:null,at:NOW()}]; }
      if (['cancelled','blocked'].includes(c.status)) for (const run of this.list('runs').filter(r=>r.assignmentId===assignment.id&&!TERMINAL.has(r.status))) this.revokeRun(run.id,c.status);
    }
    const changedDependencies=patch.dependencies!==undefined&&(patch.dependencies.length!==assignment.dependencies.length||patch.dependencies.some((id:string)=>!assignment.dependencies.includes(id)));
    if(changedDependencies||dispositionRationale!==undefined)patch.dependencyDecisions=[...(assignment.dependencyDecisions??[]),{actorId:actor.kind==='owner'?'owner':actor.employeeId,runId:actor.kind==='employee'?actor.runId:null,at:NOW(),rationale:dependencyRationale??dispositionRationale,priorDependencies:[...assignment.dependencies],dependencies:[...(patch.dependencies??assignment.dependencies)],priorStatus:assignment.status,status:patch.status??assignment.status,...(patch.blockedReason!==undefined||assignment.blockedReason!==undefined?{blockedReason:patch.blockedReason??assignment.blockedReason}:{})}];
    return this.update('assignments',assignment.id,patch);
  }
  private vote(actor: Actor,c: CorporateCommand) {
    if (actor.kind!=='employee' || this.level(actor.employeeId)!=='elder') throw new DomainError('elder_required','A vote must come from an active independent Elder run',403);
    const decision=this.need('decisions',c.decisionId);
    if (decision.status!=='pending' || !decision.eligibleElders?.includes(actor.employeeId)) throw new DomainError('closed_decision','No pending independent vote for this Elder');
    if (this.list('votes').some(v=>v.decisionId===decision.id&&v.employeeId===actor.employeeId)) throw new DomainError('duplicate_vote','An initial vote cannot be changed after peers become visible');
    if (typeof c.approve!=='boolean') throw new DomainError('invalid_vote','Vote approve must be boolean');
    const vote=this.put('votes',{decisionId:decision.id,employeeId:actor.employeeId,approve:c.approve,rationale:required(c.rationale,'Independent rationale'),runId:actor.runId,phase:'initial'});
    const votes=this.list('votes').filter(v=>v.decisionId===decision.id);
    // Wait for all three initial judgments, so even the outcome cannot prejudice an initial vote.
    if (votes.length===3) { const approved=votes.filter(v=>v.approve).length>=2; if (approved) this.applyGovernance(decision.id); this.update('decisions',decision.id,{status:approved?'approved':'rejected',result:{approve:votes.filter(v=>v.approve).length,reject:votes.filter(v=>!v.approve).length}}); }
    const assignment=this.need('assignments',this.need('runs',actor.runId).assignmentId);
    if(assignment.kind==='governance'&&assignment.payload?.decisionId===decision.id)this.update('assignments',assignment.id,{status:'completed',completedAt:NOW(),completionEvidence:{voteId:vote.id,runId:actor.runId}});
    return vote;
  }
  private applyGovernance(decisionId: string) {
    const decision=this.need('decisions',decisionId), p=decision.payload;
    if (decision.kind==='executive.review') { if (!['ceo','executive'].includes(this.level(p.employeeId))) throw new DomainError('invalid_executive','Elder performance reviews assess a CEO or executive'); if (this.need('employees',p.employeeId).status!=='active') throw new DomainError('inactive_executive','Performance review requires an active executive'); return; }
    if (decision.kind==='executive.dismiss') { if (!['ceo','executive'].includes(this.level(p.employeeId))) throw new DomainError('invalid_executive','Elders may dismiss executives only'); this.dismiss(p.employeeId,decision.rationale); return; }
    if (decision.kind==='executive.appoint' || decision.kind==='executive.replace') {
      const position=this.need('positions',p.positionId);
      if (!['ceo','executive'].includes(position.level)) throw new DomainError('invalid_executive','Elder appointment must be to an executive position');
      this.localModel(required(p.modelId ?? (p.employeeId?this.need('employees',p.employeeId).modelId:undefined),'Model'));
      if (p.employeeId && this.level(p.employeeId)==='elder') throw new DomainError('owner_required','Elders cannot transfer governance seats into executive employment',403);
      let previousId: string|undefined;
      if (decision.kind==='executive.replace') {
        const occupant=this.list('employees').find(e=>e.positionId===position.id&&e.status==='active');
        if (occupant) {previousId=occupant.id;this.dismiss(occupant.id,decision.rationale);}
      }
      const managerId=position.level==='ceo'?null:this.list('employees').find(e=>e.status==='active'&&this.level(e.id)==='ceo')?.id ?? null;
      const appointed=p.employeeId?this.appoint(p.employeeId,position.id,managerId,decisionId):this.hire(p,position.id,managerId,decisionId);
      if (p.modelId) this.update('employees',appointed.id,{modelId:p.modelId});
      if (previousId) {
        for (const employee of this.list('employees').filter(e=>e.status==='active'&&e.managerVacancy&&e.previousManagerId===previousId)) {this.reporting(employee.id,appointed.id);this.update('employees',employee.id,{homeManagerId:appointed.id,managerVacancy:false});}
        for (const department of this.list('departments').filter(d=>d.managerId===previousId)) this.update('departments',department.id,{managerId:appointed.id});
        for (const project of this.list('projects').filter(project=>project.supervisorId===previousId)) this.update('projects',project.id,{supervisorId:appointed.id});
        for (const assignment of this.list('assignments').filter(a=>a.supervisorId===previousId&&!['completed','cancelled'].includes(a.status))) this.update('assignments',assignment.id,{supervisorId:appointed.id});
      }
      return;
    }
    throw new DomainError('invalid_governance','Unknown executable executive decision');
  }
  recordPullRequestArtifact(actor:Actor,summary:string):Artifact {
    const result=this.db.transaction(()=>{
      this.validateActor(actor);if(actor.kind!=='employee')throw new DomainError('employee_run_required','An actual assigned employee run must import the selected PR');
      const run=this.need('runs',actor.runId),assignment=this.need('assignments',run.assignmentId),candidate=assignment.pullRequestCandidate;
      if(assignment.kind!=='implementation'||!candidate||candidate.assignmentId!==assignment.id||candidate.source?.number!==assignment.payload?.pullRequest?.number||candidate.source?.headSha!==assignment.payload?.pullRequest?.headSha||candidate.workspace?.workspace!==run.workspace)throw new DomainError('pull_request_scope','This run has no prepared exact assigned PR candidate',403);
      const existing=this.list('artifacts').find(a=>a.assignmentId===assignment.id&&a.sourcePullRequest?.headSha===candidate.source.headSha);if(existing)return {artifact:existing,created:false};
      const artifact=this.executeCommand(actor,{type:'artifact.record',kind:'commit',identity:candidate.source.headSha,uri:candidate.source.url,summary:required(summary,'Import summary'),checks:[]});
      const retained=this.update('artifacts',artifact.id,{baseCommit:candidate.source.baseSha,sourcePullRequest:structuredClone(candidate.source),reviewWorkspace:structuredClone(candidate.workspace)});
      this.update('runs',run.id,{corporateCommands:[...(run.corporateCommands??[]),{type:'artifact.record',id:artifact.id,at:NOW()}]});
      return {artifact:retained,created:true};
    })();
    if(result.created)this.emit('artifact.record',{actorId:actor.kind==='employee'?actor.employeeId:'owner',runId:actor.kind==='employee'?actor.runId:null,id:result.artifact.id});
    return result.artifact;
  }
  private assignmentRequirements(acceptance:string[],value:unknown):AssignmentRequirement[]{
    if(!Array.isArray(value)||value.length!==acceptance.length)throw new DomainError('invalid_completion_requirements','Declare one evidence requirement for every exact original acceptance criterion; no kind is inferred from text');
    const seen=new Set<string>();
    for(const entry of value){
      if(!entry||!acceptance.includes(entry.criterion)||seen.has(entry.criterion)||!['artifact','delivery','release'].includes(entry.source)||entry.authorship!==undefined&&entry.authorship!=='external')throw new DomainError('invalid_completion_requirements','Each distinct exact criterion needs source artifact, delivery or release and optional authorship external');
      if(entry.source==='release')required(entry.version,'Exact required release version');
      else if(entry.version!==undefined)throw new DomainError('invalid_completion_requirements','Only release requirements take a version');
      seen.add(entry.criterion);
    }
    return acceptance.map(criterion=>{const entry=value.find(item=>item.criterion===criterion);return {criterion,source:entry.source,...(entry.authorship?{authorship:entry.authorship}:{}),...(entry.source==='release'?{version:entry.version.trim()}:{})};});
  }
  private requireExternalArtifact(artifact:Artifact,project:Project){
    const original=this.need('assignments',artifact.assignmentId),pr=artifact.sourcePullRequest,candidate=original.pullRequestCandidate,product=project.productId?this.need('products',project.productId):undefined;
    if(!pr||!candidate||candidate.assignmentId!==original.id||JSON.stringify(candidate.source)!==JSON.stringify(pr)||JSON.stringify(candidate.workspace)!==JSON.stringify(artifact.reviewWorkspace)||pr.headSha!==artifact.identity||!pr.authorLogin||pr.repository!==product?.binding?.repository||original.payload?.pullRequest?.headSha!==pr.headSha||original.payload.pullRequest.number!==pr.number)throw new DomainError('external_authorship_required','This criterion requires the exact retained external PR candidate and author provenance; employee-authored code cannot substitute');
  }
  private assignmentCoverage(artifact:Artifact,c:CorporateCommand){
    if(c.assignmentAcceptance===undefined)return [];
    if(!Array.isArray(c.assignmentAcceptance)||c.assignmentAcceptance.length&&c.verdict!=='approved')throw new DomainError('invalid_assignment_acceptance','Only approved independent reviews may map assignment acceptance');
    const original=this.need('assignments',artifact.assignmentId),seen=new Set<string>();
    return c.assignmentAcceptance.map((entry:any)=>{
      const target=this.need('assignments',entry?.assignmentId??original.id);
      if(target.projectId!==artifact.projectId||target.id!==original.id&&original.payload?.sourceAssignmentId!==target.id)throw new DomainError('completion_scope','Coverage can target only this artifact assignment or its explicit same-project sourceAssignmentId');
      const requirement=target.completionRequirements?.find((item:AssignmentRequirement)=>item.criterion===entry.criterion),key=`${target.id}:${entry.criterion}`;
      if(!requirement||seen.has(key)||entry.source!==requirement.source||entry.authorship!==requirement.authorship||entry.version!==requirement.version)throw new DomainError('invalid_assignment_acceptance','Coverage must exactly match a distinct manager-declared assignment criterion, source, authorship and version');
      if(requirement.authorship==='external')this.requireExternalArtifact(artifact,this.need('projects',target.projectId!));
      seen.add(key);return {assignmentId:target.id,...requirement,evidence:required(entry.evidence,'Independent assignment evidence')};
    });
  }
  private assignmentCompletionEvidence(assignment:Assignment,submitted:unknown,complete:boolean){
    if(!assignment.completionRequirements||!assignment.requirementsDeclaration)throw new DomainError('completion_requirements_missing','Supervising management must explicitly declare the unchanged original criteria evidence kinds before completion');
    const requirements=this.assignmentRequirements(assignment.acceptance,assignment.completionRequirements);
    if(!Array.isArray(submitted))throw new DomainError('invalid_completion_evidence','Completion evidence must be an array of exact criterion, rationale and retained sources');
    const seen=new Set<string>(),project=assignment.projectId?this.need('projects',assignment.projectId):undefined;
    if(!project)throw new DomainError('completion_scope','Artifact completion requires a retained project');
    const evidence=submitted.map((entry:any)=>{
      const requirement=requirements.find(item=>item.criterion===entry?.criterion);
      if(!requirement||seen.has(entry.criterion)||!Array.isArray(entry.sources)||!entry.sources.length)throw new DomainError('invalid_completion_evidence','Each distinct exact assignment criterion requires retained source evidence');
      seen.add(entry.criterion);
      return {criterion:entry.criterion,rationale:required(entry.rationale,'Completion rationale'),sources:entry.sources.map((source:any)=>{
        if(source?.type!==requirement.source)throw new DomainError('completion_kind_mismatch','Evidence kind must match the immutable declared requirement');
        return this.completionSource(project,entry.criterion,source,{assignment,requirement});
      })};
    });
    if(complete&&requirements.some(item=>!seen.has(item.criterion)))throw new DomainError('assignment_acceptance_unmet','Every original acceptance criterion needs independently reviewed observed evidence');
    return evidence;
  }
  assignmentCompleted(assignment:Assignment):boolean {
    if(assignment.status!=='completed')return false;
    if(assignment.kind!=='implementation')return true;
    try{return !!assignment.completion&&JSON.stringify(assignment.completion.requirements)===JSON.stringify(assignment.completionRequirements)&&JSON.stringify(assignment.completion.acceptance)===JSON.stringify(assignment.acceptance)&&!!this.assignmentCompletionEvidence(assignment,assignment.completionEvidence,true);}catch{return false;}
  }
  reconcileAssignmentCompletions(){
    return this.db.transaction(()=>{
      const changed:Assignment[]=[];
      for(const assignment of this.list('assignments').filter(item=>item.kind==='implementation'&&item.status==='completed'&&!this.assignmentCompleted(item))){
        const reason='Prior artifact approval did not establish every original assignment acceptance criterion. Preserve approved work; management must declare evidence requirements and confirm observed outcomes.';
        const updated=this.update('assignments',assignment.id,{status:'awaiting_review',completedAt:undefined,completion:undefined,completionPending:reason,completionHistory:[...(assignment.completionHistory??[]),{status:assignment.status,completedAt:assignment.completedAt??null,completion:assignment.completion??null,evidence:assignment.completionEvidence??[],at:NOW(),actorId:'system',reason}],completionReconciledAt:NOW()});
        this.emit('assignment.completion_reconciled',{assignmentId:assignment.id,priorStatus:assignment.status,reason});changed.push(updated);
      }
      return changed;
    })();
  }
  hasApprovedArtifact(assignmentId: string, identity?: string): boolean {
    const artifacts=this.list('artifacts').filter(a=>a.assignmentId===assignmentId);
    if (!artifacts.length) return false;
    const latest=artifacts.at(-1)!;
    if (identity && latest.identity!==identity) return false;
    return this.list('reviews').some(r=>r.artifactId===latest.id&&r.artifactIdentity===latest.identity&&r.verdict==='approved'&&r.employeeId!==latest.employeeId&&r.runId!==latest.runId);
  }
  private projectAcceptance(artifact:Artifact,command:CorporateCommand){
    if(command.projectAcceptance===undefined)return [];
    if(!Array.isArray(command.projectAcceptance))throw new DomainError('invalid_project_acceptance','projectAcceptance must be an array of independently reviewed criterion mappings');
    if(command.projectAcceptance.length&&command.verdict!=='approved')throw new DomainError('invalid_project_acceptance','Only approved independent reviews may establish project acceptance coverage');
    const project=artifact.projectId?this.need('projects',artifact.projectId):undefined;
    return command.projectAcceptance.map((entry:any)=>{
      if(!entry||!project?.acceptance.includes(entry.criterion)||!['artifact','delivery','release'].includes(entry.source))throw new DomainError('invalid_project_acceptance','Coverage must name an exact current project criterion and source artifact, delivery or release');
      return {criterion:entry.criterion,evidence:required(entry.evidence,'Independent criterion evidence'),source:entry.source,...(entry.source==='release'?{version:required(entry.version,'Exact expected release version')}:{})};
    });
  }
  private completionSource(project:Project,criterion:string,source:any,target?:{assignment:Assignment;requirement:AssignmentRequirement}){
    if(!source||!['artifact','delivery','release'].includes(source.type))throw new DomainError('invalid_completion_source','Completion sources must identify retained artifact, delivery or release outcomes');
    const record=this.need('artifacts',required(source.id,'Source record ID'));
    const artifact=source.type==='release'?this.need('artifacts',record.sourceArtifactId):record;
    if(record.projectId!==project.id||artifact.projectId!==project.id)throw new DomainError('completion_scope','Completion evidence must belong to this project');
    if(target){
      const original=this.need('assignments',artifact.assignmentId);
      if(original.id!==target.assignment.id||original.projectId!==project.id){if(original.projectId!==project.id||original.payload?.sourceAssignmentId!==target.assignment.id)throw new DomainError('completion_scope','Source artifact must belong to this assignment or its explicitly linked child assignment');}
      if(target.requirement.authorship==='external'){
        this.requireExternalArtifact(artifact,project);
        if(source.type!=='artifact'&&deliveryFor(project,artifact.id)?.source!=='existing-pr')throw new DomainError('external_authorship_required','External-source delivery must retain the observed existing-PR delivery binding');
      }
    }
    const review=this.list('reviews').find(r=>r.artifactId===artifact.id&&r.artifactIdentity===artifact.identity&&r.verdict==='approved'&&r.employeeId!==artifact.employeeId&&r.runId!==artifact.runId&&(target?r.assignmentAcceptance??[]:r.projectAcceptance??[]).some((coverage:any)=>coverage.criterion===criterion&&coverage.source===source.type&&(source.type!=='release'||coverage.version===record.version)&&(!target||coverage.assignmentId===target.assignment.id&&coverage.authorship===target.requirement.authorship&&coverage.version===target.requirement.version)));
    if(!review)throw new DomainError('criterion_review_required',`An independent exact-artifact review must explicitly map ${source.type} evidence to criterion: ${criterion}`);
    if(['commit','code','patch'].includes(artifact.kind)&&(!artifact.verification?.passed||artifact.verification.identity!==artifact.identity||!artifact.verification.receiptId||!artifact.checks.length||artifact.checks.some((check:any)=>check.status!=='passed'||check.identity!==artifact.identity||check.source!=='canonical-verifier')))throw new DomainError('completion_verification_required','Code evidence needs passing canonical verification of the independently reviewed exact identity');
    const proof:any={type:source.type,id:record.id,identity:record.identity,reviewId:review.id};
    if(source.type==='artifact'){
      if(this.list('artifacts').filter(a=>a.assignmentId===artifact.assignmentId).at(-1)?.id!==artifact.id)throw new DomainError('completion_artifact_superseded','Unpublished artifact evidence was superseded; review the current artifact or cite its observed delivery');
    }else if(source.type==='delivery'){
      const delivered=deliveryFor(project,artifact.id);
      if(delivered?.state!=='merged'||delivered.identity!==artifact.identity||!delivered.mergeCommit||!delivered.defaultBranchHead||!delivered.deliveredAt||!delivered.prUrl)throw new DomainError('completion_delivery_unconfirmed','Delivery evidence needs an observed exact-artifact merge with confirmed default-branch ancestry');
      Object.assign(proof,{url:delivered.prUrl,mergeCommit:delivered.mergeCommit,defaultBranchHead:delivered.defaultBranchHead});
    }else{
      const action=this.list('actions').find(a=>a.kind==='release'&&a.dedupeKey===`release:${record.id}:publish`&&a.status==='succeeded'&&a.remoteRef===record.remoteRef&&a.artifactId===artifact.id&&a.artifactIdentity===artifact.identity);
      const delivered=deliveryFor(project,artifact.id);
      if(record.kind!=='release-package'||record.releaseState!=='published'||!record.publishedAt||!record.remoteRef||!record.packageDigest||record.identity!==record.packageDigest||!record.assets?.length||!record.checks?.length||record.checks.some((check:any)=>check.source!=='release-verifier'||check.status!=='passed'||check.identity!==record.sourceCommit||check.version!==record.version)||!action||delivered?.state!=='merged'||delivered.mergeCommit!==record.sourceCommit||!delivered.defaultBranchHead)throw new DomainError('completion_release_unconfirmed','Release evidence needs the reviewed version, passing package checks and an observed published provider receipt');
      Object.assign(proof,{url:record.remoteRef,version:record.version,sourceArtifactId:artifact.id,actionId:action.id});
    }
    return proof;
  }
  private review(actor: Actor,c: CorporateCommand) {
    if (actor.kind!=='employee') throw new DomainError('employee_run_required','Review must come from an independent employee run');
    const artifact=this.need('artifacts',c.artifactId), run=this.need('runs',actor.runId), assignment=this.need('assignments',run.assignmentId);
    if (artifact.employeeId===actor.employeeId || artifact.runId===run.id) throw new DomainError('independent_review_required','Author cannot review its own output',403);
    if (assignment.kind!=='review' || assignment.payload?.artifactId!==artifact.id || assignment.projectId!==artifact.projectId) throw new DomainError('review_assignment_required','Reviewer needs a tracked review assignment for this actual artifact',403);
    if (required(c.artifactIdentity,'Reviewed identity')!==artifact.identity) throw new DomainError('artifact_changed','Review identity differs from the recorded deliverable');
    if (!['approved','changes_requested'].includes(c.verdict)) throw new DomainError('invalid_verdict','Use approved or changes_requested');
    if (!Array.isArray(c.checks)||!c.checks.length) throw new DomainError('review_checks_required','Record the actual checks and findings inspected');
    if (c.verdict==='approved' && ['commit','code','patch'].includes(artifact.kind) && (!artifact.verification?.passed || artifact.verification.identity!==artifact.identity || !artifact.verification.receiptId)) throw new DomainError('verification_required','Code approval requires the supervisor broker verification receipt for this exact artifact');
    const original=this.need('assignments',artifact.assignmentId);
    const supplemental=c.supplementalAcceptance===true;
    if(supplemental){
      const approved=this.list('reviews').some(r=>r.artifactId===artifact.id&&r.artifactIdentity===artifact.identity&&r.verdict==='approved'&&r.employeeId!==artifact.employeeId&&r.runId!==artifact.runId);
      if(!['completed','awaiting_review','blocked'].includes(original.status)||!approved||['completed','cancelled'].includes(assignment.status)||c.verdict!=='approved'||!c.projectAcceptance?.length&&!c.assignmentAcceptance?.length&&!c.issueAcceptance)throw new DomainError('invalid_supplemental_review','Supplemental acceptance requires an already approved artifact, a new independent review assignment, an approved evidence verdict and explicit criterion/issue coverage');
    }else{
      const latest=this.list('artifacts').filter(a=>a.assignmentId===artifact.assignmentId).at(-1);
      if(latest?.id!==artifact.id)throw new DomainError('artifact_superseded','A newer deliverable supersedes this review target');
      if(original.status!=='awaiting_review'||this.hasApprovedArtifact(original.id,artifact.identity))throw new DomainError('invalid_transition','Deliverable is not awaiting review; use a new supplemental acceptance review for approved work');
    }
    const projectAcceptance=this.projectAcceptance(artifact,c);
    const assignmentAcceptance=this.assignmentCoverage(artifact,c);
    if(c.issueAcceptance!==undefined&&(c.verdict!=='approved'||c.issueAcceptance?.reviewerId!==actor.employeeId||c.issueAcceptance?.runId!==run.id||c.issueAcceptance?.artifactId!==artifact.id||c.issueAcceptance?.artifactIdentity!==artifact.identity))throw new DomainError('invalid_issue_acceptance','Issue acceptance must come from this approved independent broker review of the exact artifact');
    const review=this.put('reviews',{artifactId:artifact.id,artifactIdentity:artifact.identity,employeeId:actor.employeeId,runId:run.id,verdict:c.verdict,rationale:required(c.rationale,'Review rationale'),checks:c.checks,projectAcceptance,assignmentAcceptance,...(supplemental?{supplementalAcceptance:true}:{}),...(c.issueAcceptance!==undefined?{issueAcceptance:c.issueAcceptance}:{})});
    if(!supplemental){
      if(c.verdict==='approved')this.update('assignments',original.id,{approvedArtifact:{artifactId:artifact.id,identity:artifact.identity,reviewId:review.id,at:NOW()},completionPending:'Artifact approved; original assignment acceptance still requires supervisor-confirmed evidence.'});
      else this.update('assignments',original.id,{status:artifact.sourcePullRequest||original.corrections+1>=this.policy.maxCorrections?'blocked':'needs_changes',corrections:original.corrections+1,blockedReason:artifact.sourcePullRequest?`Existing PR requires management disposition or separately assigned implementation: ${c.rationale}`:original.corrections+1>=this.policy.maxCorrections?'Correction limit reached; management must choose next approach':'',reviewFeedback:c.rationale});
    }
    this.update('assignments',assignment.id,{status:'completed',completedAt:NOW()});
    return review;
  }

  reviewScopeIssue(assignment:Pick<Assignment,'kind'|'projectId'|'employeeId'>&{payload?:any}) {
    if(assignment.kind!=='review')return;
    const artifact=typeof assignment.payload?.artifactId==='string'?this.get('artifacts',assignment.payload.artifactId):undefined,project=typeof assignment.projectId==='string'?this.get('projects',assignment.projectId):undefined;
    return reviewScopeIssue(assignment,{artifact,project,original:artifact?this.get('assignments',artifact.assignmentId):undefined,product:project?.productId?this.get('products',project.productId):undefined});
  }
  reviewScopeCoordinator(assignment:Assignment):Employee|undefined {
    const artifact=typeof assignment.payload?.artifactId==='string'?this.get('artifacts',assignment.payload.artifactId):undefined,project=artifact?.projectId?this.get('projects',artifact.projectId):undefined;
    if(!project)return;
    const original=this.get('assignments',artifact!.assignmentId),seen=new Set<string>();let candidate=this.get('employees',assignment.supervisorId);
    while(candidate&&!seen.has(candidate.id)){
      seen.add(candidate.id);const actor:Actor={kind:'employee',employeeId:candidate.id,runId:'scheduler',policyRevision:this.policy.revision};
      const manages=(id:string)=>!!this.get('employees',id)&&(id===candidate!.id||this.canManage(actor,id)),canRead=(task:Assignment)=>this.level(candidate!.id)==='ceo'||manages(task.employeeId)||!!task.projectId&&!!this.get('projects',task.projectId)&&manages(this.need('projects',task.projectId).supervisorId);
      if(candidate.status==='active'&&['ceo','executive','lead','manager'].includes(this.level(candidate.id))&&manages(assignment.supervisorId)&&manages(project.supervisorId)&&canRead(assignment)&&(!original||canRead(original)))return candidate;
      candidate=candidate.homeManagerId?this.get('employees',candidate.homeManagerId):undefined;
    }
  }
  reviewScopeCorrectionAllowed(assignment:Assignment):boolean {
    if(!assignment.schedulerKey?.startsWith('review-scope:'))return true;
    const target=this.get('assignments',assignment.payload?.invalidReviewAssignmentId),artifact=target?this.get('artifacts',target.payload?.artifactId):undefined;
    return !!(target?.status==='blocked'&&target.reviewScopeIssue&&this.reviewScopeIssue(target)&&artifact&&assignment.kind==='management'&&assignment.projectId===null&&assignment.schedulerKey===`review-scope:${target.id}`&&assignment.payload?.artifactId===artifact.id&&assignment.payload?.sourceProjectId===artifact.projectId&&this.reviewScopeCoordinator(target)?.id===assignment.employeeId);
  }
  reconcileReviewScopes() {
    return this.db.transaction(()=>{
      const active=new Set(this.list('runs').filter(run=>!TERMINAL.has(run.status)).map(run=>run.assignmentId));
      for(const assignment of this.list('assignments').filter(item=>item.kind==='review'&&['queued','blocked'].includes(item.status)&&!active.has(item.id))){
        const issue=this.reviewScopeIssue(assignment);if(!issue||assignment.status==='blocked'&&JSON.stringify(assignment.reviewScopeIssue)===JSON.stringify(issue))continue;
        const at=NOW();this.update('assignments',assignment.id,{status:'blocked',blockedReason:`Review scope invalid: ${issue.reason} Cancel and recreate under the retained artifact project, or record a precise management disposition; scope and acceptance cannot be rebound.`,reviewScopeIssue:issue,reviewScopeHistory:[...(assignment.reviewScopeHistory??[]),{at,priorStatus:assignment.status,priorBlockedReason:assignment.blockedReason??null,issue}]});
        this.emit('assignment.review_scope_blocked',{assignmentId:assignment.id,issue});
      }
    }).immediate();
  }

  claimNext(options: {workspace?: string; leaseMs?: number; assignmentId?: string} = {}): EmployeeRun | undefined {
    return this.db.transaction(() => {
      if (this.company.state!=='running') return undefined;
      this.reconcileReviewScopes();
      if (this.list('runs').filter(r=>r.status==='running'||r.status==='cancelling').length>=this.policy.maxInference) return undefined;
      const assignments=this.list('assignments');
      const ready=assignments.filter(a=>a.status==='queued'&&a.accepted!==false&&!this.reviewScopeIssue(a)&&this.reviewScopeCorrectionAllowed(a)&&(!a.projectId||this.need('projects',a.projectId).status==='active'&&projectDispatchAllowed(this.need('projects',a.projectId),a))&&a.availableAt<=NOW()&&(!options.assignmentId||a.id===options.assignmentId)&&this.need('employees',a.employeeId).status==='active'&&a.dependencies.every(id=>{const dependency=this.get('assignments',id);return !!dependency&&this.assignmentCompleted(dependency);}));
      ready.sort((a,b)=>(b.priority+Math.floor((Date.now()-Date.parse(b.createdAt))/3_600_000))-(a.priority+Math.floor((Date.now()-Date.parse(a.createdAt))/3_600_000))||a.createdAt.localeCompare(b.createdAt));
      const assignment=ready[0]; if (!assignment) return undefined;
      const employee=this.need('employees',assignment.employeeId);
      this.localModel(employee.modelId);
      if (this.list('runs').some(r=>r.employeeId===employee.id&&!TERMINAL.has(r.status))) return undefined;
      const activeRuns=this.list('runs').filter(r=>r.status==='running'||r.status==='cancelling');
      const selected=this.list('models').find(m=>m.id===employee.modelId||m.name===employee.modelId);
      if (activeRuns.length && selected?.sizeClass!=='small' && activeRuns.some(r=>this.list('models').find(m=>m.id===r.modelId||m.name===r.modelId)?.sizeClass!=='small')) return undefined;
      const run=this.put('runs',{employeeId:employee.id,assignmentId:assignment.id,modelId:employee.modelId,policyRevision:this.policy.revision,workspace:options.workspace ?? (assignment.projectId?this.need('projects',assignment.projectId).workspace ?? null:null),sessionId:null,runtimeDispatch:'claimed',status:'running',attempt:assignment.attempts+1,leaseUntil:new Date(Date.now()+(options.leaseMs ?? 120_000)).toISOString(),heartbeatAt:NOW(),tokenRevoked:false});
      this.update('assignments',assignment.id,{status:'running',attempts:run.attempt});
      this.emit('run.claimed',{runId:run.id,assignmentId:assignment.id}); return run;
    }).immediate();
  }
  bindSession(runId: string, sessionId: string, workspace?: string) { const run=this.need('runs',runId); if (run.sessionId&&run.sessionId!==sessionId) throw new DomainError('session_mismatch','Run session is already bound'); return this.update('runs',runId,{sessionId,...(workspace?{workspace}:{})}); }
  heartbeat(runId: string, leaseMs=120_000) { const run=this.need('runs',runId); if (run.status!=='running'||run.tokenRevoked) throw new DomainError('run_inactive','Cannot heartbeat inactive run'); return this.update('runs',runId,{heartbeatAt:NOW(),leaseUntil:new Date(Date.now()+leaseMs).toISOString()}); }
  revokeRun(runId: string, reason: string) { const run=this.need('runs',runId); if (TERMINAL.has(run.status)) return this.update('runs',runId,{tokenRevoked:true}); return this.update('runs',runId,{status:'cancelling',tokenRevoked:true,cancellationReason:reason,cancelledAt:NOW()}); }
  finishRun(runId: string, result: {status:'succeeded'|'failed'|'interrupted'|'uncertain'; text?: string; error?: string; transient?: boolean; [key:string]:any}) {
    return this.db.transaction(() => {
      const run=this.need('runs',runId), assignment=this.need('assignments',run.assignmentId);
      if (TERMINAL.has(run.status)) return run;
      const status=run.tokenRevoked?'interrupted':result.status;
      const ended=this.update('runs',runId,{...result,status,tokenRevoked:true,endedAt:NOW()});
      if (assignment.status==='running') {
        if (status==='succeeded') {
          // Management/conversation/governance persist their commands. Implementation needs an artifact and independent review.
          const artifact=this.list('artifacts').filter(a=>a.assignmentId===assignment.id).at(-1);
          if(assignment.kind==='implementation'&&artifact&&(artifact.runId===run.id||artifact.verification?.passed&&artifact.verification.runId===run.id&&artifact.verification.identity===artifact.identity))this.update('assignments',assignment.id,{status:'awaiting_review'});
          else if (['management','conversation','governance','assessment'].includes(assignment.kind) && ((run.corporateCommands?.length ?? 0)>0 || result.managementResult?.summary)) this.update('assignments',assignment.id,{status:'completed',completedAt:NOW()});
          else this.update('assignments',assignment.id,{status:'blocked',blockedReason:'Run ended without a submitted artifact; management must inspect preserved workspace'});
        } else if (status==='interrupted' && this.need('employees',assignment.employeeId).status==='active') this.update('assignments',assignment.id,{status:'queued',availableAt:NOW(),resumeRunId:run.id});
        else if (status==='failed' && result.transient && assignment.attempts<=this.policy.maxRetries) this.update('assignments',assignment.id,{status:'queued',availableAt:new Date(Date.now()+5000).toISOString()});
        else this.update('assignments',assignment.id,{status:'blocked',blockedReason:result.error ?? status});
      }
      this.emit('run.finished',{runId,status}); return ended;
    })();
  }
  recoverRuns(observation?: (run: EmployeeRun) => 'running'|'absent'|'uncertain') {
    const recovered: EmployeeRun[]=[];
    for (const run of this.list('runs').filter(r=>r.status==='running'||r.status==='cancelling'||r.status==='queued')) {
      const observed=observation?.(run) ?? 'uncertain';
      if (observed==='running'&&!run.tokenRevoked) continue;
      this.revokeRun(run.id,'service restart');
      const ended=this.finishRun(run.id,{status:observed==='absent'?'interrupted':'uncertain',error:observed==='uncertain'?'Runtime/workspace ownership requires reconciliation':'Runtime confirmed absent; preserved workspace ready to resume'});
      if (observed==='uncertain') { this.update('runs',ended.id,{status:'uncertain'}); const assignment=this.need('assignments',run.assignmentId); if (assignment.status==='queued') this.update('assignments',assignment.id,{status:'blocked',blockedReason:'Reconcile previous runtime/workspace before redispatch'}); }
      recovered.push(this.need('runs',run.id));
    }
    for (const action of this.list('actions').filter(a=>a.status==='dispatched')) this.update('actions',action.id,{status:'uncertain',uncertainReason:'Service restarted after external dispatch; reconcile provider state before another attempt'});
    return recovered;
  }

  prepareAction(actor: Actor, input: Partial<ExternalAction> & Record<string,any>): ExternalAction {
    this.validateActor(actor,true);
    if (actor.kind!=='employee') throw new DomainError('employee_run_required','Product actions require a tracked employee run');
    const product=this.need('products',required(input.productId,'Product'));
    const run=this.need('runs',actor.runId), assignment=this.need('assignments',run.assignmentId);
    if (!assignment.projectId || this.need('projects',assignment.projectId).productId!==product.id) throw new DomainError('wrong_product','Action is outside the run product scope',403);
    const key=required(input.dedupeKey,'Deduplication key');
    const existing=this.list('actions').find(a=>a.dedupeKey===key);
    if (existing) { if (existing.productId!==product.id||existing.kind!==input.kind||existing.target!==input.target||JSON.stringify(existing.content)!==JSON.stringify(input.content)) throw new DomainError('dedupe_conflict','Deduplication key belongs to another intended action',409); return existing; }
    const cost=typeof input.cost==='number'&&Number.isFinite(input.cost)&&input.cost>=0?input.cost:null;
    const blocked=cost!==0||!input.costEvidence;
    const action=this.put('actions',{employeeId:actor.employeeId,runId:run.id,productId:product.id,kind:required(input.kind,'Action kind'),target:required(input.target,'Target'),content:input.content ?? {},dedupeKey:key,status:blocked?'blocked':'prepared',policyRevision:this.policy.revision,cost,costEvidence:input.costEvidence ?? '',artifactId:input.artifactId,artifactIdentity:input.artifactIdentity,reconciliationAttempts:0});
    if (blocked) this.put('attention',{kind:'spending',title:`Cost approval required: ${action.kind}`,detail:cost===null?'Incremental charge is unknown. Establish exact cost and obtain Owner approval before dispatch.':`Proposed incremental charge: ${cost}. Unapproved allowance: $0.`,requiredAction:'Approve this concrete expenditure after its exact cost is established.',actionId:action.id,status:'open'});
    this.emit('action.prepared',{actionId:action.id,status:action.status}); return action;
  }
  dispatchAction(actor: Actor, actionId: string): ExternalAction {
    return this.db.transaction(() => {
      this.validateActor(actor,true);
      const action=this.need('actions',actionId);
      if (actor.kind!=='employee'||actor.employeeId!==action.employeeId||actor.runId!==action.runId) throw new DomainError('wrong_run','External intent belongs to a different employee run',403);
      if (action.status!=='prepared') throw new DomainError('action_not_dispatchable',`Action is ${action.status}; uncertain/dispatched actions require reconciliation`,409);
      if (action.policyRevision!==this.policy.revision) throw new DomainError('stale_policy','Action must be revalidated under the current policy',403);
      if (action.cost===null || !action.costEvidence || (action.cost>0&&(!action.costApproval||action.costApproval.actionId!==action.id||action.costApproval.amount<action.cost))) throw new DomainError('spending_denied','Unapproved new spending or uncertain charge denied before dispatch',403);
      if (['merge','release','deploy','store_submission'].includes(action.kind)) {
        const artifact=this.need('artifacts',action.artifactId);
        if (artifact.identity!==action.artifactIdentity || !this.hasApprovedArtifact(artifact.assignmentId,artifact.identity)) throw new DomainError('review_required','Delivery requires independent review of this exact artifact identity',403);
        if (!action.content.checksPassed || action.content.actualHead!==artifact.identity) throw new DomainError('unchecked_head','Required checks and the actual delivery commit must match the reviewed artifact',403);
      }
      const dispatched=this.update('actions',action.id,{status:'dispatched',dispatchedAt:NOW()}); this.emit('action.dispatched',{actionId}); return dispatched;
    }).immediate();
  }
  resolveAction(actionId: string, result: {status:'succeeded'|'failed'|'uncertain'; remoteRef?:string; result?:any; [key:string]:any}): ExternalAction {
    const action=this.need('actions',actionId);
    if (!['dispatched','uncertain'].includes(action.status)) { if (action.status===result.status&&action.remoteRef===result.remoteRef) return action; throw new DomainError('invalid_action_transition','Only a dispatched or uncertain action may receive an observed outcome'); }
    if (result.status==='succeeded'&&!result.remoteRef) throw new DomainError('missing_remote_reference','Successful external actions require an observed provider reference');
    const updated=this.update('actions',actionId,{...result,resolvedAt:NOW()}); this.emit('action.resolved',{actionId,status:result.status}); return updated;
  }
  reconcileAction(actionId: string, observation: {state:'present'|'absent'|'unknown'; evidence:string; remoteRef?:string}) {
    const action=this.need('actions',actionId);
    if (action.status!=='uncertain') throw new DomainError('not_uncertain','Reconciliation is only for uncertain effects');
    required(observation.evidence,'Provider observation evidence');
    if (observation.state==='present') return this.resolveAction(actionId,{status:'succeeded',remoteRef:required(observation.remoteRef,'Provider reference'),result:observation});
    if (observation.state==='absent' && (action.reconciliationAttempts ?? 0)<1) return this.update('actions',actionId,{status:'prepared',reconciliation:observation,reconciliationAttempts:(action.reconciliationAttempts ?? 0)+1});
    return this.update('actions',actionId,{reconciliation:observation});
  }
  readKnowledge(id: string) { return this.vault.read(id); }
  searchKnowledge(query: string, options?: {scopeId?:string;limit?:number}) { return this.vault.search(query,options); }
  backup() { return this.vault.backup(); }
  restore(path: string) { return this.vault.restore(path); }
  close() { this.events.removeAllListeners(); this.db.close(); }
}
