import { computeGrant } from './compute-budget.js';
import type { CompanyStore } from '../storage/store.js';
import { DomainError, type Actor, type CorporateCommand, type Message, type ExternalAction } from './types.js';

function text(value:unknown,label:string){if(typeof value!=='string'||!value.trim()||value.length>12000)throw new DomainError('invalid_proposal',`${label} must be nonempty text, at most 12000 characters.`);return value.trim();}

function actionScope(action:ExternalAction){
 const {id,employeeId,runId,productId,kind,target,content,dedupeKey,policyRevision,cost,costEvidence,artifactId,artifactIdentity}=action;
 return {id,employeeId,runId,productId,kind,target,content,dedupeKey,policyRevision,cost,costEvidence,...(artifactId?{artifactId}:{}),...(artifactIdentity?{artifactIdentity}:{})};
}
export function assertProposalAction(store:CompanyStore,action:ExternalAction){
 if(!action.ownerProposalId)return;
 const proposal=store.need('attention',action.ownerProposalId);
 if(proposal.disposition?.decision!=='approved'||Date.parse(proposal.expiresAt)<=Date.now()||proposal.policyRevision!==store.policy.revision||JSON.stringify(proposal.actionScope)!==JSON.stringify(actionScope(action)))throw new DomainError('proposal_scope_denied','Exact approved proposal scope or expiration no longer permits this action.',403);
}

/** Proposal composition is employee Markdown; this envelope freezes what the Owner decides. */
export function createOwnerProposal(store:CompanyStore,actor:Actor,c:CorporateCommand){
 const title=text(c.title,'Title'),content=text(c.content,'Proposal'),scope=text(c.proposalScope,'Exact scope');
 if(!['telegram','email'].includes(c.channel)||!Number.isFinite(Date.parse(c.expiresAt))||Date.parse(c.expiresAt)<=Date.now())throw new DomainError('invalid_proposal','Choose telegram or email and a future expiresAt.');
 const employee=actor.kind==='employee'?store.need('employees',actor.employeeId):store.list('employees').find(e=>e.status==='active'&&store.level(e.id)==='ceo');
 if(!employee)throw new DomainError('recipient_unavailable','An active employee must own the proposal.',409);
 const grant=c.computeGrant===undefined?undefined:computeGrant(store,actor,c.computeGrant);
 if(grant&&(c.actionId||c.channel!=='email'))throw new DomainError('invalid_proposal','Compute grants require email and cannot also reserve a product action.');
 const action=c.actionId?store.need('actions',c.actionId):undefined;
 if(action&&!store.get('products',action.productId))throw new DomainError('invalid_proposal','Reserve a product action; transport and service effects use their existing controls.');
 if(action&&(action.ownerProposalId||!['blocked','prepared'].includes(action.status)||action.policyRevision!==store.policy.revision||action.cost===null||!Number.isFinite(action.cost)||action.cost<0||!action.costEvidence))throw new DomainError('invalid_proposal','Action must have a known cost, current policy and no prior proposal or dispatch.');
 if(action&&actor.kind==='employee'&&action.employeeId!==actor.employeeId&&!store.canManage(actor,action.employeeId))throw new DomainError('forbidden','Cannot reserve another employee action.',403);
 const proposal=store.put('attention',{kind:'owner_proposal',title,detail:content,scope,expiresAt:new Date(c.expiresAt).toISOString(),status:'open',policyRevision:store.policy.revision,employeeId:employee.id,runId:actor.kind==='employee'?actor.runId:null,...(grant?{computeGrant:grant}:{}),...(action?{actionId:action.id,actionScope:actionScope(action)}:{})});
 if(action)store.update('actions',action.id,{status:'blocked',ownerProposalId:proposal.id});
 const message=store.put('messages',{senderId:employee.id,recipientId:'owner',projectId:null,content:`${title}\n\n${content}\n\nExact scope: ${scope}\nExpires: ${proposal.expiresAt}${grant?`\nCompute allowance (USD): ${grant.ceilingMicrousd/1_000_000} total.\nPermitted routes: ${JSON.stringify(grant.routes)}\nFrozen named work: ${JSON.stringify(grant.work)}\nApproval permits only this supplemental text compute; no general spending, credential or private-data permission.`:action?`\nExact action: ${JSON.stringify(proposal.actionScope)}`:'\nThis records a scope-specific decision only; no executable action or general permission is granted.'}\n\nReply to this message with exactly APPROVE ${proposal.id} or DENY ${proposal.id}. Silence leaves it pending.`,channel:c.channel,proposalId:proposal.id,runId:proposal.runId});
 return store.update('attention',proposal.id,{messageId:message.id});
}

/** Owner-created envelopes have no invented employee run. Generic messages cannot take this path. */
export function ownerDirectedProposal(store:CompanyStore,message:Message){
 const proposal=message.proposalId?store.get('attention',message.proposalId):undefined;
 return proposal?.kind==='owner_proposal'&&proposal.runId===null&&message.runId===null&&proposal.messageId===message.id;
}

/** Called only on durably authenticated transport intake, never from a model command. */
export function resolveOwnerProposal(store:CompanyStore,message:Message,parentActionId?:string){
 return store.db.transaction(()=>{
  if(message.proposalResponse)return message.proposalResponse;
  // Permit the standard quoted email tail, never quoted commands or extra authored conditions.
  const parts=message.email?.direction==='incoming'?message.content.replaceAll('\r\n','\n').split(/\nOn [^\n]+wrote:[ \t]*\n/):[message.content];
  const body=parts.length===2&&parts[1]!.split('\n').some(line=>line.startsWith('>'))&&parts[1]!.split('\n').every(line=>!line.trim()||line.startsWith('>'))?parts[0]!:message.content;
  const match=/^(APPROVE|DENY) ([a-f0-9-]{36})$/i.exec(body.trim());
  if(!match)return;
  const channel=message.telegram?.direction==='incoming'?'telegram':message.email?.direction==='incoming'?'email':undefined;
  const parent=parentActionId?store.get('actions',parentActionId):undefined,original=parent?store.get('messages',parent.content.messageId):undefined;
  const proposal=store.get('attention',match[2]!.toLowerCase());
  let outcome='unresolved';
  if(message.senderId==='owner'&&channel&&parent?.kind===`${channel}.send`&&parent.target===message[channel].binding&&['succeeded','uncertain'].includes(parent.status)&&original?.proposalId===proposal?.id&&proposal?.kind==='owner_proposal'){
   if(proposal.disposition)outcome='already_decided';
   else if(channel==='telegram'&&store.list('actions').some(a=>a.kind==='telegram.send'&&a.content.messageId===original?.id&&a.status!=='succeeded'))outcome='incomplete_delivery';
   else if(Date.parse(proposal.expiresAt)<=Date.now())outcome='expired';
   else if(proposal.policyRevision!==store.policy.revision)outcome='stale_policy';
   else if(proposal.actionId&&(!store.get('actions',proposal.actionId)||store.need('actions',proposal.actionId).status!=='blocked'||JSON.stringify(proposal.actionScope)!==JSON.stringify(actionScope(store.need('actions',proposal.actionId)))))outcome='changed_scope';
   else{
    outcome=match[1]!.toUpperCase()==='APPROVE'?'approved':'denied';
    if(proposal.actionId&&outcome==='approved'){
     const action=store.need('actions',proposal.actionId);
     store.update('actions',action.id,{status:'prepared',costApproval:{amount:action.cost,description:proposal.scope,approvedAt:new Date().toISOString(),actionId:action.id,proposalId:proposal.id}});
    }
    store.update('attention',proposal.id,{status:'resolved',disposition:{decision:outcome,messageId:message.id,channel,at:new Date().toISOString()},resolution:`Owner ${outcome} this exact scope only.`});
   }
  }
  const response={proposalId:match[2]!.toLowerCase(),outcome};store.update('messages',message.id,{proposalResponse:response});return response;
 })();
}
