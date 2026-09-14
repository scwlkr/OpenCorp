import { createHash } from 'node:crypto';
import type { CompanyStore } from '../storage/store.js';
import { DomainError, type Actor, type Assignment } from './types.js';

export const computeWork = (a:Assignment) => ({assignmentId:a.id,employeeId:a.employeeId,projectId:a.projectId,title:a.title,hash:createHash('sha256').update(JSON.stringify([a.instructions,a.acceptance,a.dataClass??'internal'])).digest('hex')});
export const supportedComputeRoute=(provider:unknown,model:unknown):boolean=>provider==='openai'&&typeof model==='string'&&/^gpt-4\.1(?:-mini|-nano)?-2025-04-14$/.test(model);
export interface ComputeGrant { ceilingMicrousd:number; routes:{provider:string;model:string}[]; work:ReturnType<typeof computeWork>[] }
function deny(message:string):never {throw new DomainError('compute_budget_denied',message,403);}
const integer=(n:unknown):n is number=>Number.isSafeInteger(n)&&Number(n)>0;

/** Freeze executable scope in the existing exact Owner proposal, not a second approval system. */
export function computeGrant(store:CompanyStore,actor:Actor,input:any):ComputeGrant {
 if(!input||!integer(input.ceilingMicrousd)||!Array.isArray(input.assignmentIds)||!input.assignmentIds.length||input.assignmentIds.length>32||new Set(input.assignmentIds).size!==input.assignmentIds.length||!Array.isArray(input.routes)||!input.routes.length||input.routes.length>16)deny('Specify a positive integer USD-micro ceiling, named assignments and exact routes.');
 const routes=input.routes.map((r:any)=>{if(!supportedComputeRoute(r?.provider,r?.model))deny('Only exact supported OpenAI text-model snapshots may be proposed.');return {provider:r.provider as string,model:r.model as string};});
 const work=input.assignmentIds.map((id:string)=>{
  const a=store.need('assignments',id);
  if(actor.kind==='employee'&&actor.employeeId!==a.employeeId&&!store.canManage(actor,a.employeeId))deny('Cannot propose compute for work outside your management scope.');
  if(store.confidentialAssignments().has(id))deny('Private work requires a separately permitted data route; this compute tool does not grant one.');
  return computeWork(a);
 });
 return {ceilingMicrousd:input.ceilingMicrousd,routes,work};
}

export function assertComputeGrant(store:CompanyStore,actor:Actor,proposalId:string,provider:string,model:string){
 store.validateActor(actor,true);
 if(actor.kind!=='employee')return deny('Compute dispatch requires an actual employee run.');
 const proposal=store.need('attention',proposalId),grant=proposal.computeGrant as ComputeGrant|undefined;
 if(!grant||proposal.kind!=='owner_proposal'||proposal.disposition?.decision!=='approved'||!Number.isFinite(Date.parse(proposal.expiresAt))||Date.parse(proposal.expiresAt)<=Date.now()||proposal.policyRevision!==store.policy.revision)deny('Exact compute approval is absent, expired or stale.');
 const a=store.need('assignments',store.need('runs',actor.runId).assignmentId);
 if(a.employeeId!==actor.employeeId||a.paused||['completed','cancelled'].includes(a.status)||store.confidentialAssignments().has(a.id)||!grant.work.some(w=>JSON.stringify(w)===JSON.stringify(computeWork(a)))||!grant.routes.some(r=>r.provider===provider&&r.model===model))deny('Compute request differs from the approved work, employee or route.');
 return {proposal,grant,assignment:a};
}

/** BEGIN IMMEDIATE serializes admission across independent service connections. Every unpriced effect keeps its whole reservation. */
export function reserveCompute(store:CompanyStore,actor:Actor,input:{proposalId:string;provider:string;model:string;dedupeKey:string;promptHash:string;maximumMicrousd:()=>number;pricing:unknown}) {
 return store.db.transaction(()=>{
  const {grant,assignment}=assertComputeGrant(store,actor,input.proposalId,input.provider,input.model);
  const maximumMicrousd=input.maximumMicrousd();
  if(!integer(maximumMicrousd))deny('Request cost cannot be safely bounded.');
  const prior=store.list('actions').find(a=>a.dedupeKey===`compute:${input.dedupeKey}`);
  if(prior){if(prior.computeProposalId!==input.proposalId||prior.assignmentId!==assignment.id||prior.content.promptHash!==input.promptHash||prior.target!==`${input.provider}/${input.model}`)deny('Request key already names a different effect.');return {action:prior,reused:true};}
  const used=store.list('actions').filter(a=>a.kind==='compute.infer'&&a.computeProposalId===input.proposalId).reduce((sum,a)=>sum+BigInt(a.reservedMicrousd),0n);
  if(used+BigInt(maximumMicrousd)>BigInt(grant.ceilingMicrousd))deny('Aggregate concurrent and retained charges would exceed the approved ceiling.');
  const action=store.put('actions',{kind:'compute.infer',employeeId:assignment.employeeId,runId:actor.kind==='employee'?actor.runId:'',assignmentId:assignment.id,productId:'company',target:`${input.provider}/${input.model}`,content:{promptHash:input.promptHash},dedupeKey:`compute:${input.dedupeKey}`,computeProposalId:input.proposalId,reservedMicrousd:maximumMicrousd,pricing:input.pricing,cost:maximumMicrousd/1_000_000,costEvidence:'Conservative full-context input plus capped output at protected all-in upper rates; reservation retained until final billing reconciliation.',status:'dispatched',policyRevision:store.policy.revision,dispatchedAt:new Date().toISOString()});
  return {action,reused:false};
 }).immediate();
}
