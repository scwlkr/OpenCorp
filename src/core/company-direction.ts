import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sourceRoot } from '../server/paths.js';
import { DomainError, type Actor } from './types.js';
import type { CompanyStore } from '../storage/store.js';
import { enqueueCompanyWork } from './formation.js';

export const factoryMandate = () => readFileSync(join(sourceRoot,'skills/company-direction.md'),'utf8').trim();

/** Owner migration changes direction, never the access envelope or effect history. */
export function migrateCompanyDirection(store:CompanyStore,actor:Actor) {
 if(actor.kind!=='owner')throw new DomainError('owner_required','Only the Owner may migrate company direction',403);
 if(store.company.direction==='software-factory')return store.company;
 if(!['paused','stopped'].includes(store.company.state)||store.activeRuns().some(run=>run.status!=='uncertain'))throw new DomainError('pause_required','Pause or stop and drain active turns before migrating company direction',409);
 const previousMandate=store.company.mandate,at=new Date().toISOString();
 const reassess=[];
 for(const assignment of store.list('assignments')) {
  const key=assignment.schedulerKey??'';
  if(assignment.projectId||!['queued','blocked'].includes(assignment.status)||!(key==='founding-mandate'||key.startsWith('executive-start:')||key.startsWith('formation:office:')||key.startsWith('formation:department:')||key.startsWith('formation:request:')||key==='formation:recruiter-bootstrap'))continue;
  // Preserve the commitment and history; management decides whether it is still useful.
  store.update('assignments',assignment.id,{status:'blocked',blockedReason:'Previous mandatory formation remit needs management reassessment under the software-factory mandate.',directionReview:{at,previousStatus:assignment.status,previousBlockedReason:assignment.blockedReason??null}});
  reassess.push(assignment.id);
 }
 const company=store.update('company',store.company.id,{direction:'software-factory',mandate:factoryMandate(),directionMigration:{version:1,at,previousMandate,reassessAssignmentIds:reassess}});
 const ceo=store.list('employees').find(e=>e.status==='active'&&store.level(e.id)==='ceo');
 if(ceo)enqueueCompanyWork(store,ceo,'direction-migration:1','Reconcile retained work with current company direction',`${company.mandate}\n\nInspect retained assignments, department duties and skills. Reassess assignments ${JSON.stringify(reassess)} with responsible managers. Preserve useful commitments and pending decisions; cancel only obsolete administrative tasks with an explicit reason and create useful replacements where needed. Resume useful retained work within unchanged policy.`,70);
 return company;
}
