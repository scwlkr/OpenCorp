/** Operational state shared by every interface. Only CompanyStore mutates these records. */
export type CompanyLifecycle = 'forming' | 'running' | 'paused' | 'stopping' | 'stopped';
export type AssignmentState = 'queued' | 'running' | 'awaiting_review' | 'needs_changes' | 'blocked' | 'completed' | 'cancelled';
export type RunState = 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'interrupted' | 'uncertain';
export type Actor = { kind: 'owner' } | { kind: 'employee'; employeeId: string; runId: string; policyRevision: number };
export interface RecordBase { id: string; createdAt: string; updatedAt: string; [key: string]: any }
export interface Company extends RecordBase { name: string; state: CompanyLifecycle; bootstrap: string; mandate: string }
export interface OwnerPolicy extends RecordBase { revision: number; spendingLimit: number; localOnly: boolean; maxInference: number; nativeJobs: number; maxRetries: number; maxCorrections: number; reassessMinutes: number; allowedRepositories: string[] }
export interface Product extends RecordBase { name: string; repository: string; assessment: string; goals: any[]; roadmap: any[]; status: string; priority: number; rationale: string }
export interface Department extends RecordBase { name: string; managerId: string; responsibilities: string }
export type PositionLevel = 'elder' | 'ceo' | 'executive' | 'lead' | 'manager' | 'worker' | 'support';
export interface Position extends RecordBase { title: string; level: PositionLevel; departmentId: string | null; responsibilities: string; status: string }
export interface Employee extends RecordBase { name: string; badge: string; status: 'active' | 'dismissed'; positionId: string; departmentId: string | null; homeManagerId: string | null; modelId: string; role: string; roleVersion: number }
export interface Appointment extends RecordBase { employeeId: string; positionId: string; startedAt: string; endedAt: string | null; decisionId: string | null; acting: boolean }
export interface DeliveryReceipt { artifactId: string; identity: string; state: 'awaiting_checks' | 'merged'; prNumber: number; prUrl: string; source?: 'existing-pr'; branch?: string; publicationActionId?: string; pushActionId?: string; mergeActionId?: string; issueNumber?: number | null; closeIssue?: boolean; remainingGate?: string; issueReviewId?: string; mergeCommit?: string; defaultBranchHead?: string; deliveredAt?: string; issueEvidenceActionId?: string; workspaceAdvance?: {state:'prepared'|'completed';from:string;to:string;priorBaseCommit?:string} }
export interface Project extends RecordBase { name: string; productId: string | null; outcome: string; acceptance: string[]; supervisorId: string; status: string; priority: number; rationale: string; workspace?: string; branch?: string; baseCommit?: string }
export interface Assignment extends RecordBase { projectId: string | null; employeeId: string; supervisorId: string; title: string; instructions: string; acceptance: string[]; dependencies: string[]; status: AssignmentState; priority: number; attempts: number; corrections: number; kind: string; availableAt: string }
export interface AssignmentRequirement { criterion: string; source: 'artifact'|'delivery'|'release'; authorship?: 'external'; version?: string }
export interface EmployeeRun extends RecordBase { employeeId: string; assignmentId: string; modelId: string; policyRevision: number; workspace: string | null; sessionId: string | null; status: RunState; attempt: number; leaseUntil: string; heartbeatAt: string; tokenRevoked: boolean }
export interface Decision extends RecordBase { authorId: string; runId?: string | null; subject: string; rationale: string; kind: string; payload: any; status: string; policyRevision: number; eligibleElders?: string[] }
export interface Vote extends RecordBase { decisionId: string; employeeId: string; approve: boolean; rationale: string; runId: string; phase: 'initial' }
export interface SourcePullRequest { repository: string; number: number; url: string; authorLogin: string; baseRef: string; baseSha: string; headRepository: string; headRef: string; headSha: string; observedAt: string }
export interface ReviewWorkspace { workspace: string; gitDir: string; mirror: string; branch: string; baseCommit: string }
export interface PullRequestCandidate { assignmentId: string; source: SourcePullRequest; workspace: ReviewWorkspace }
export interface Artifact extends RecordBase { assignmentId: string; projectId: string | null; employeeId: string; runId: string; uri: string; identity: string; kind: string; summary: string; checks: any[]; sourcePullRequest?: SourcePullRequest; reviewWorkspace?: ReviewWorkspace }
export interface Review extends RecordBase { artifactId: string; artifactIdentity: string; employeeId: string; runId: string; verdict: 'approved' | 'changes_requested'; rationale: string; checks: any[] }
export interface Message extends RecordBase { senderId: string; recipientId: string | null; projectId: string | null; content: string; runId: string | null }
export interface ExternalAction extends RecordBase { employeeId: string; runId: string; productId: string; kind: string; target: string; content: any; dedupeKey: string; status: 'prepared' | 'dispatched' | 'succeeded' | 'failed' | 'uncertain' | 'blocked'; policyRevision: number; cost: number | null; costEvidence: string; remoteRef?: string; result?: any }
export interface Knowledge extends RecordBase { path: string; title: string; scope: string; scopeId: string | null; hash: string; provenance: any; version: number; supersedes?: string; humanEdited: boolean }
export interface ModelProfile extends RecordBase { name: string; artifactIdentity: string; local: boolean; available: boolean; capabilities: string[] }
export interface Integration extends RecordBase { name: string; status: string; detail: string }
export interface Attention extends RecordBase { kind: string; title: string; detail: string; status: string; actionId?: string; requiredAction?: string }
export interface CompanyEvent { id: number; type: string; payload: any; createdAt: string }
export interface Tables { company: Company; policy: OwnerPolicy; products: Product; departments: Department; positions: Position; employees: Employee; appointments: Appointment; projects: Project; assignments: Assignment; runs: EmployeeRun; decisions: Decision; votes: Vote; artifacts: Artifact; reviews: Review; messages: Message; actions: ExternalAction; knowledge: Knowledge; models: ModelProfile; integrations: Integration; attention: Attention; experiences: RecordBase; roleVersions: RecordBase }
export type TableName = keyof Tables;
export interface CompanySnapshot { company: Company; policy: OwnerPolicy; products: Product[]; departments: Department[]; positions: Position[]; employees: Employee[]; appointments: Appointment[]; projects: Project[]; assignments: Assignment[]; runs: EmployeeRun[]; decisions: Decision[]; votes: Vote[]; artifacts: Artifact[]; reviews: Review[]; messages: Message[]; actions: ExternalAction[]; knowledge: Knowledge[]; models: ModelProfile[]; integrations: Integration[]; attention: Attention[]; experiences: RecordBase[]; roleVersions: RecordBase[]; events: CompanyEvent[]; resources: Record<string, any> }
export interface CorporateCommand { type: string; [key: string]: any }
export class DomainError extends Error { constructor(public code: string, message: string, public status = 400) { super(message); this.name = 'DomainError'; } }
