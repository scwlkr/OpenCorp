import type { Assignment, DeliveryReceipt, Project, ExternalAction, EmployeeRun } from './types.js';

/** Include retained pre-history installations without rewriting their evidence. */
export function deliveriesFor(project: Project): DeliveryReceipt[] {
 const receipts = new Map<string, DeliveryReceipt>();
 for (const receipt of [...(project.deliveryHistory ?? []), project.delivery]) if (receipt?.artifactId) receipts.set(receipt.artifactId, receipt);
 return [...receipts.values()];
}
export function deliveryFor(project: Project, artifactId: string): DeliveryReceipt | undefined { return deliveriesFor(project).find(item => item.artifactId === artifactId); }

export function deliveryCommunicationKey(receipt:DeliveryReceipt):string {return `delivery-communication:${receipt.artifactId}:${receipt.mergeCommit}`;}
export function isDeliveryCommunication(project:Project,assignment:Assignment):boolean {
 const receipt=deliveryFor(project,assignment.payload?.artifactId);
 return !!receipt&&receipt.state==='merged'&&!!receipt.mergeCommit&&assignment.kind==='management'&&assignment.projectId===project.id&&assignment.employeeId===project.supervisorId&&assignment.supervisorId===project.supervisorId&&assignment.schedulerKey===deliveryCommunicationKey(receipt)&&assignment.payload?.artifactIdentity===receipt.identity&&assignment.payload?.mergeCommit===receipt.mergeCommit&&assignment.payload?.prNumber===receipt.prNumber;
}
/** Match retained task-related communication, including pre-followup installations. */
export function deliveryCommunicationMatches(project:Project,receipt:DeliveryReceipt,repository:string,action:ExternalAction,run?:EmployeeRun,assignment?:Assignment):boolean {
 if(action.kind!=='communication'||action.productId!==project.productId||typeof action.content?.body!=='string'||!action.content.body.trim())return false;
 const commentUrl=`https://github.com/${repository}/${receipt.issueEvidenceActionId===action.id?'issues':'pull'}/${receipt.issueEvidenceActionId===action.id?receipt.issueNumber:receipt.prNumber}#issuecomment-${action.result?.id}`;
 if(action.status==='succeeded'&&action.remoteRef!==commentUrl)return false;
 if(receipt.issueEvidenceActionId===action.id&&receipt.issueNumber)return action.content.kind==='issue_comment'&&action.content.number===receipt.issueNumber&&action.target===`${repository}/issues/${receipt.issueNumber}`;
 if(action.content.kind!=='pr_comment'||action.content.number!==receipt.prNumber||action.target!==`${repository}/pulls/${receipt.prNumber}`||!run||!assignment||run.id!==action.runId||run.employeeId!==action.employeeId||run.assignmentId!==assignment.id||assignment.projectId!==project.id||assignment.payload?.artifactId!==receipt.artifactId)return false;
 return Number.isFinite(Date.parse(receipt.deliveredAt??''))&&Date.parse(action.createdAt)>=Date.parse(receipt.deliveredAt!)&&(!action.artifactId||action.artifactId===receipt.artifactId)&&(!action.artifactIdentity||action.artifactIdentity===receipt.identity);
}
export function observedDeliveryCommunication(action:ExternalAction):boolean {return action.status==='succeeded'&&!!action.remoteRef&&Number.isSafeInteger(action.result?.id)&&action.result.id>0;}

export function workspaceAdvancePending(project: Project): boolean { const latest=project.delivery; return latest?.source!=='existing-pr' && latest?.state==='merged' && (latest.workspaceAdvance?.state==='prepared'||!!latest.publicationActionId&&latest.workspaceAdvance?.state!=='completed'); }

/** schedulerKey is never accepted from corporate assignment.create/update. */
export function isDeliveryContinuation(project: Project, assignment: Assignment): boolean {
 const receipt=deliveryFor(project,assignment.payload?.artifactId);
 if(!receipt||assignment.projectId!==project.id||assignment.kind!=='management'||assignment.payload?.mergeReady!==true||assignment.employeeId!==project.supervisorId||assignment.supervisorId!==project.supervisorId)return false;
 if(workspaceAdvancePending(project)&&receipt.artifactId!==project.delivery.artifactId)return false;
 return assignment.schedulerKey===`merge-ready:${receipt.artifactId}:${receipt.identity}` || receipt.state==='merged'&&!!receipt.mergeCommit&&assignment.schedulerKey===`workspace-advance:${receipt.artifactId}:${receipt.mergeCommit}`;
}
export function projectDispatchAllowed(project: Project, assignment: Assignment): boolean { return !project.productId||!workspaceAdvancePending(project)||isDeliveryContinuation(project,assignment); }
