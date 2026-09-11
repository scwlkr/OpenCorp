import type { Artifact, Assignment, Product, Project } from './types.js';

export type ReviewScopeIssue={code:'invalid_review_scope'|'independent_review_required';reason:string};
/** The same retained scope is required for newly created and legacy reviews. */
export function reviewScopeIssue(assignment:Pick<Assignment,'kind'|'projectId'|'employeeId'>&{payload?:any},evidence:{artifact?:Artifact;original?:Assignment;project?:Project;product?:Product}):ReviewScopeIssue|undefined {
 if(assignment.kind!=='review')return;
 const invalid=(reason:string):ReviewScopeIssue=>({code:'invalid_review_scope',reason});
 if(typeof assignment.projectId!=='string'||!assignment.projectId.trim()||typeof assignment.payload?.artifactId!=='string'||!assignment.payload.artifactId.trim())return invalid(`A review requires explicit projectId and payload.artifactId for the same existing artifact. Retained projectId=${JSON.stringify(assignment.projectId??null)}, artifactId=${JSON.stringify(assignment.payload?.artifactId??null)}.`);
 const {artifact,original,project,product}=evidence;
 if(!artifact)return invalid(`Review artifact ${assignment.payload.artifactId} is not a retained artifact.`);
 if(!project)return invalid(`Review project ${assignment.projectId} is not a retained project; artifact ${artifact.id} belongs to ${artifact.projectId}.`);
 if(artifact.projectId!==project.id||original?.projectId!==project.id)return invalid(`Review projectId ${project.id} must match both artifact ${artifact.id} project ${artifact.projectId} and its original assignment ${artifact.assignmentId} project ${original?.projectId??'(missing)'}.`);
 if(project.productId&&!product)return invalid(`Review project ${project.id} refers to missing products record ${project.productId}.`);
 if(assignment.employeeId===artifact.employeeId)return {code:'independent_review_required',reason:`The artifact author cannot review its own output: employee ${assignment.employeeId}, artifact ${artifact.id}.`};
}
