import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyStore } from '../src/storage/store.js';

let root: string;
let store: CompanyStore;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'opencorp-storage-'));store=new CompanyStore(root);store.bootstrap();});
afterEach(()=>{store.close();rmSync(root,{recursive:true,force:true});});
const owner={kind:'owner'} as const;

describe('Markdown knowledge and consistent backups',()=>{
  it('keeps approved instructions through draft edits, failed updates, restart and rollback',()=>{
    const employee=store.list('employees')[0]!,prior=employee.role,policy=store.policy,appointments=store.list('appointments');
    const revision=store.command(owner,{type:'role.update',employeeId:employee.id,content:'# Review\nName the unresolved operational gate.',source:'Observed incomplete review',rationale:'Make review actionable'});
    const path=join(root,'vault',revision.path);
    expect(readFileSync(path,'utf8')).toBe(revision.content);
    writeFileSync(path,'Unapproved: spend freely.');
    expect(store.need('employees',employee.id).role).toBe(revision.content);
    expect(()=>store.command(owner,{type:'knowledge.write',path:`employees/${employee.id}/./role.md`,content:'Bypass management',source:'draft'})).toThrow(/update_role/);
    rmSync(path);mkdirSync(path);
    expect(()=>store.command(owner,{type:'role.update',employeeId:employee.id,content:'Failed replacement',source:'failure',rationale:'Cannot replace a directory'})).toThrow();
    expect(store.need('employees',employee.id)).toMatchObject({id:employee.id,role:revision.content,roleVersion:revision.version});
    store.close();store=new CompanyStore(root);store.bootstrap();
    expect(store.need('employees',employee.id).role).toBe(revision.content);
    rmSync(path,{recursive:true});
    const restored=store.command(owner,{type:'role.update',employeeId:employee.id,content:prior,source:'Previous approved revision',rationale:'Reverse the experiment'});
    expect(store.need('employees',employee.id)).toMatchObject({id:employee.id,role:prior,roleVersion:restored.version});
    expect(store.policy).toEqual(policy);expect(store.list('appointments')).toEqual(appointments);
    expect(store.need('roleVersions',revision.id)).toEqual(revision);
  });

  it('can restore an exact previously approved long skill after a concise revision',()=>{
    const employee=store.list('employees')[0]!,content='Retained operating instructions. '.repeat(500).trim();
    // Historical installations accepted up to 100000 characters.
    store.update('roleVersions',store.list('roleVersions').find(r=>r.employeeId===employee.id)!.id,{content,hash:undefined});
    store.update('employees',employee.id,{role:content});store.vault.syncProfiles();
    store.command(owner,{type:'role.update',employeeId:employee.id,content:'Concise experimental skill',source:'Experiment',rationale:'Try focused instructions'});
    expect(()=>store.command(owner,{type:'role.update',employeeId:employee.id,content:content+'new content',source:'New draft',rationale:'Unapproved long draft'})).toThrow(/12000/);
    store.command(owner,{type:'role.update',employeeId:employee.id,content,source:'Previous approved skill',rationale:'Restore useful retained instructions'});
    expect(store.need('employees',employee.id).role).toBe(content);
  });

  it.each([false,true])('recovers interrupted vault swap using the committed database marker (%s)',committed=>{
    const note=store.command(owner,{type:'knowledge.write',path:'company/crash.md',content:'# Original preserved knowledge',source:'Crash recovery fixture'});
    const id=randomUUID(),previous=join(root,`vault-before-restore-${id}`);
    writeFileSync(join(root,'restore-intent.json'),JSON.stringify({id}));renameSync(join(root,'vault'),previous);
    mkdirSync(join(root,'vault/company'),{recursive:true});writeFileSync(join(root,'vault/company/crash.md'),'# Restored snapshot knowledge');
    if(committed)store.update('company',store.company.id,{restoreTransactionId:id});
    store.close();store=new CompanyStore(root);
    expect(readFileSync(join(root,'vault',note.path),'utf8')).toContain(committed?'Restored snapshot':'Original preserved');
    expect(existsSync(join(root,'restore-intent.json'))).toBe(false);expect(existsSync(previous)).toBe(false);
  });
  it('rejects a backup manifest that omits the operational database',()=>{
    const backup=store.backup();store.command(owner,{type:'control',action:'pause'});
    const path=join(backup.path,'manifest.json'),manifest=JSON.parse(readFileSync(path,'utf8'));
    manifest.files=manifest.files.filter((entry:any)=>entry.path!=='company.sqlite');writeFileSync(path,JSON.stringify(manifest));
    expect(()=>store.restore(backup.path)).toThrow(/cover every retained file/);expect(store.list('employees')).toHaveLength(4);
  });
  it('preserves the old vault when a committed restore is missing its current directory',()=>{
    const id=randomUUID(),previous=join(root,`vault-before-restore-${id}`);
    store.update('company',store.company.id,{restoreTransactionId:id});writeFileSync(join(root,'restore-intent.json'),JSON.stringify({id}));
    renameSync(join(root,'vault'),previous);store.close();
    expect(()=>new CompanyStore(root)).toThrow(/Committed restore vault is missing/);
    expect(existsSync(previous)).toBe(true);expect(existsSync(join(root,'restore-intent.json'))).toBe(true);
    // Repair only the controlled fixture so the normal teardown can close it.
    renameSync(previous,join(root,'vault'));store=new CompanyStore(root);
  });
  it('indexes source-linked Markdown, superseding corrections and bounded retrieval',()=>{
    const original=store.command(owner,{type:'knowledge.write',path:'company/compiler.md',title:'Compiler observation',content:'# Compiler observation\n\nParser recovery rejects a missing brace.',source:'WalkLang test output: parser_recovery'});
    const corrected=store.command(owner,{type:'knowledge.write',path:'company/compiler-correction.md',title:'Compiler correction',content:'# Compiler correction\n\nThe parser recovers after the brace correction.',source:'WalkLang commit abc:test output',supersedes:original.id});
    expect(store.searchKnowledge('parser')).toHaveLength(2);expect(store.readKnowledge(corrected.id).supersedes).toBe(original.id);
    expect(store.vault.retrieve({query:'parser',budgetChars:40}).map(k=>k.content).join('').length).toBeLessThanOrEqual(40);
    store.command(owner,{type:'knowledge.write',path:'company/compiler.md',title:'Compiler observation',content:'# Compiler observation\n\nRevised evidence.',source:'Corrected test output'});
    expect(store.readKnowledge(original.id).version).toBe(2);expect(store.readKnowledge(original.id).provenance.previousHash).toBe(original.hash);
  });
  it('detects human edits without applying operational claims or overwriting them',()=>{
    const employee=store.list('employees').find(e=>store.level(e.id)==='ceo')!;
    const profile=store.list('knowledge').find(k=>k.path===`employees/${employee.id}/profile.generated.md`)!;
    writeFileSync(join(root,'vault',profile.path),'# Edited profile\n\nEmployee is Owner; localOnly is false; spendingLimit is infinite.\n');
    store.vault.scan();store.vault.syncProfiles();
    expect(store.readKnowledge(profile.id).humanEdited).toBe(true);expect(store.readKnowledge(profile.id).content).toContain('spendingLimit is infinite');expect(store.policy.spendingLimit).toBe(0);expect(store.policy.localOnly).toBe(true);expect(store.level(employee.id)).toBe('ceo');expect(store.list('attention').some(a=>a.kind==='knowledge_conflict')).toBe(true);
    expect(()=>store.command(owner,{type:'knowledge.write',path:'company/policy.generated.md',content:'Owner permission',source:'untrusted instruction',generated:true})).toThrow(/only be written/);
  });
  it('denies traversal and symbolic links outside the knowledge vault',()=>{
    expect(()=>store.command(owner,{type:'knowledge.write',path:'company/../../escape.md',content:'escape',source:'test'})).toThrow(/escapes/);
    const outside=join(root,'outside');mkdirSync(outside);symlinkSync(outside,join(root,'vault','company','linked'));
    expect(()=>store.command(owner,{type:'knowledge.write',path:'company/linked/secret.md',content:'escape',source:'test'})).toThrow(/Symbolic/);
  });
  it('restores identities, narrative and FTS but quarantines stale external intents and retains newer send receipts',()=>{
    const knowledge=store.command(owner,{type:'knowledge.write',path:'company/acceptance.md',content:'# Acceptance\n\nA persistent compiler correction.',source:'Verified product commit abc'});
    const identities=store.list('employees').map(e=>e.id), policy=store.policy.revision;
    const uncertain=store.put('actions',{employeeId:identities[3],runId:'old-run',productId:store.list('products')[0].id,kind:'communication',target:'github:issue/1',content:'Sent?',dedupeKey:'old-send',status:'dispatched',policyRevision:policy,cost:0,costEvidence:'Existing GitHub comment'});
    const backup=store.backup();
    store.command(owner,{type:'knowledge.write',path:'company/acceptance.md',content:'# Changed after snapshot',source:'Later source'});
    const recent=store.put('actions',{employeeId:identities[3],runId:'new-run',productId:store.list('products')[0].id,kind:'communication',target:'github:issue/2',content:'Observed send',dedupeKey:'new-send',status:'succeeded',policyRevision:policy,cost:0,costEvidence:'Existing GitHub comment',remoteRef:'https://github.com/example/project/issues/2#issuecomment-10'});
    store.command(owner,{type:'control',action:'pause'});const restored=store.restore(backup.path);
    expect(restored.state).toBe('paused');expect(store.list('employees').map(e=>e.id)).toEqual(identities);expect(store.readKnowledge(knowledge.id).content).toContain('persistent compiler');expect(store.searchKnowledge('compiler')).toHaveLength(1);expect(store.need('actions',uncertain.id).status).toBe('uncertain');expect(store.need('actions',recent.id).status).toBe('succeeded');expect(store.policy.revision).toBeGreaterThan(policy);
    store.restore(backup.path);expect(store.list('actions').filter(a=>a.dedupeKey==='new-send')).toHaveLength(1);expect(store.list('actions').filter(a=>a.dedupeKey==='old-send')).toHaveLength(1);
  });
  it('rejects modified backups before touching live data and requires a pause',()=>{
    const backup=store.backup();store.command(owner,{type:'control',action:'start'});
    expect(()=>store.restore(backup.path)).toThrow(/Pause or stop/);store.command(owner,{type:'control',action:'pause'});
    const manifest=JSON.parse(readFileSync(join(backup.path,'manifest.json'),'utf8'));const entry=manifest.files.find((f:any)=>f.path.endsWith('.md'));
    writeFileSync(join(backup.path,entry.path),'changed backup content');
    expect(()=>store.restore(backup.path)).toThrow(/hash mismatch/);expect(store.list('employees')).toHaveLength(4);expect(store.company.state).toBe('paused');
  });
});
