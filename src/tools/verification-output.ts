import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CompanyStore } from '../storage/store.js';
import { type Artifact, DomainError } from '../core/types.js';
import { redact } from './process.js';
import { safeChild } from './workspaces.js';

/** Call only after the broker has authorized this exact artifact through readState. */
export function verificationOutput(store:CompanyStore,artifact:Artifact,args:{offset?:unknown;receiptId?:unknown},active=false){
 const fail:(message:string)=>never=message=>{throw new DomainError('verification_evidence_unavailable',message,409);};
 if(active)fail('Canonical verification is active for this artifact; wait for its completed receipt before reading output.');
 const verification=artifact.verification,checks=artifact.checks;
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(artifact.id)||!verification?.receiptId||verification.identity!==artifact.identity||!Array.isArray(checks)||!checks.length)fail('This artifact has no current retained verification receipt and checks.');
 const path=join(store.dataRoot,'logs','verification',`${artifact.id}.log`),completedAt=Date.parse(verification.completedAt);
 const run=store.get('runs',verification.runId),assignment=run?store.get('assignments',run.assignmentId):undefined;
 if(!run||!assignment||assignment.projectId!==artifact.projectId||!Number.isFinite(completedAt)||!Number.isFinite(Date.parse(run.createdAt))||completedAt<Date.parse(run.createdAt)||verification.logPath!==path||typeof verification.command!=='string'||!verification.command.trim())fail('Verification receipt does not bind the artifact, originating run and expected log.');
 if(checks.some(check=>!['canonical-verifier','dependency-preparation','verification-boundary'].includes(check.source)||check.identity!==artifact.identity||check.logPath!==path||check.command!==verification.command||check.finishedAt!==verification.completedAt||!['passed','failed'].includes(check.status)||(check.status==='passed')!==verification.passed||(check.exitCode??null)!==(verification.exitCode??null)))fail('Verification checks and the current receipt disagree.');
 const offset=args.offset===undefined?0:args.offset;
 if(!Number.isSafeInteger(offset)||Number(offset)<0)throw new DomainError('invalid_offset','Verification output offset must be a zero-based nonnegative character offset.');
 if((Number(offset)>0||args.receiptId!==undefined)&&args.receiptId!==verification.receiptId)fail('Verification receipt changed or is missing from this continuation; restart at offset 0.');
 let descriptor:number|undefined;
 try{
  for(const dir of [join(store.dataRoot,'logs'),join(store.dataRoot,'logs','verification')]){const stat=lstatSync(dir);if(stat.isSymbolicLink()||!stat.isDirectory())fail('Verification log directories must be retained ordinary directories.');}
  const entry=lstatSync(path);if(entry.isSymbolicLink()||!entry.isFile())fail('Verification output must be a retained ordinary file, not a link or special file.');safeChild(join(store.dataRoot,'logs','verification'),path);
  descriptor=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const before=fstatSync(descriptor);if(!before.isFile()||before.size===0||before.size>2_000_000)fail('Retained verification output must be a nonempty regular file no larger than 2 MB.');
  const bytes=readFileSync(descriptor),after=fstatSync(descriptor);
  if(bytes.length!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)fail('Verification output changed during reading; retry the completed receipt.');
  const logSha256=createHash('sha256').update(bytes).digest('hex'),hashed=verification.logSha256!==undefined||verification.logBytes!==undefined||checks.some(check=>check.logSha256!==undefined||check.logBytes!==undefined);
  if(hashed){if(verification.logSha256!==logSha256||verification.logBytes!==bytes.length||checks.some(check=>check.logSha256!==logSha256||check.logBytes!==bytes.length))fail('Retained output no longer matches the verification receipt hash and size.');}
  else if(Math.floor(before.mtimeMs)<Date.parse(run.createdAt)||Math.floor(before.mtimeMs)>completedAt)fail('Legacy output modification time is outside its retained verification attempt; current output cannot be established.');
  const decoded=bytes.toString('utf8');if(!Buffer.from(decoded,'utf8').equals(bytes)||decoded.includes('\0'))fail('Verification output is not retained UTF-8 text.');
  const content=redact(decoded),start=Number(offset);if(start>content.length)throw new DomainError('invalid_offset','Verification output offset exceeds the retained redacted text.');
  const nextOffset=start+8000<content.length?start+8000:null;
  return {record:{id:artifact.id,kind:artifact.kind,identity:artifact.identity,projectId:artifact.projectId},view:'verification',receiptId:verification.receiptId,runId:run.id,status:verification.passed?'passed':'failed',completedAt:verification.completedAt,binding:{kind:hashed?'sha256-and-bytes':'legacy-file-time',logSha256,bytes:bytes.length,...(!hashed?{limitation:'Legacy receipt has no stored content hash; binding uses its exact log path, checks, run and file modification time.'}:{})},content:content.slice(start,start+8000),offset:start,totalCharacters:content.length,truncated:start>0||nextOffset!==null,nextOffset,...(nextOffset!==null?{nextCall:{collection:'artifacts',id:artifact.id,view:'verification',receiptId:verification.receiptId,offset:nextOffset}}:{})};
 }catch(error){if(error instanceof DomainError)throw error;return fail('Expected retained verification output is missing or inaccessible.');}finally{if(descriptor!==undefined)closeSync(descriptor);}
}
