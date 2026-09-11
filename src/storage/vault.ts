import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CompanyStore } from './store.js';
import { DomainError, type Knowledge, type TableName } from '../core/types.js';
import { TABLES } from './schema.js';

const digest = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
const roots = new Set(['company','products','departments','projects','employees']);

function files(root: string): string[] {
  if (!existsSync(root)) return [];
  const result: string[]=[];
  for (const name of readdirSync(root)) { const path=join(root,name), stat=lstatSync(path); if (stat.isSymbolicLink()) continue; if (stat.isDirectory()) result.push(...files(path)); else if (stat.isFile()) result.push(path); }
  return result;
}
function copyTree(source: string,destination: string) { mkdirSync(destination,{recursive:true,mode:0o700}); for (const file of files(source)) { const output=join(destination,relative(source,file)); mkdirSync(dirname(output),{recursive:true,mode:0o700}); copyFileSync(file,output); } }

export class KnowledgeVault {
  readonly root: string;
  constructor(private store: CompanyStore) { this.root=resolve(store.dataRoot,'vault'); this.recoverRestore(); }
  private recoverRestore() {
    const journal=join(this.store.dataRoot,'restore-intent.json');if(!existsSync(journal))return;
    const intent=JSON.parse(readFileSync(journal,'utf8'));
    if(!/^[a-f0-9-]{36}$/.test(intent.id))throw new DomainError('restore_recovery_required','Invalid retained restore transaction; preserve files for inspection.');
    const previous=join(this.store.dataRoot,`vault-before-restore-${intent.id}`),staging=join(this.store.dataRoot,`vault-restore-${intent.id}`);
    const committed=this.store.list('company')[0]?.restoreTransactionId===intent.id;
    if(!committed&&existsSync(previous)){rmSync(this.root,{recursive:true,force:true});renameSync(previous,this.root);}
    if(committed&&!existsSync(this.root))throw new DomainError('restore_recovery_required','Committed restore vault is missing; retained backup must be inspected.');
    rmSync(staging,{recursive:true,force:true});if(committed)rmSync(previous,{recursive:true,force:true});rmSync(journal);
  }
  private safe(path: string, writing=false): string {
    if (isAbsolute(path) || !roots.has(path.split('/')[0]) || !path.endsWith('.md')) throw new DomainError('invalid_vault_path','Knowledge must be Markdown inside a company, product, department, project or employee scope');
    const target=resolve(this.root,path);
    if (!target.startsWith(`${this.root}${sep}`)) throw new DomainError('invalid_vault_path','Knowledge path escapes the vault');
    let ancestor=writing?dirname(target):target;
    while (!existsSync(ancestor)) ancestor=dirname(ancestor);
    const realRoot=realpathSync(this.root), realAncestor=realpathSync(ancestor);
    if (lstatSync(ancestor).isSymbolicLink() || (realAncestor!==realRoot && !realAncestor.startsWith(`${realRoot}${sep}`))) throw new DomainError('invalid_vault_path','Symbolic links cannot escape or redirect knowledge storage');
    if (existsSync(target)&&lstatSync(target).isSymbolicLink()) throw new DomainError('invalid_vault_path','Knowledge files cannot be symbolic links');
    return target;
  }
  initialize() {
    for (const root of roots) mkdirSync(join(this.root,root),{recursive:true,mode:0o700});
    const mandate='company/mandate.md';
    if (!existsSync(join(this.root,mandate))) this.write({path:mandate,title:'Owner portfolio mandate',content:`# Owner portfolio mandate\n\n${this.store.company.mandate}\n\nNarrative knowledge cannot change operational identity, authority, policy or the $0 unapproved allowance.\n`,source:'Owner OpenCorp build contract',authorId:'owner',generated:false});
    this.syncProfiles();
    this.scan();
  }
  write(input: Record<string,any>): Knowledge {
    const scope=input.scope ?? (input.path?String(input.path).split('/')[0]:'company');
    if (!roots.has(scope)) throw new DomainError('invalid_scope','Unknown knowledge scope');
    const scopeId=input.scopeId ?? null;
    const path=input.path ?? `${scope}/${scopeId?`${scopeId}/`:''}${randomUUID()}.md`;
    if (path.endsWith('.generated.md')&&!input.generated) throw new DomainError('generated_profile','Generated operational mirrors can only be written from SQLite',403);
    const target=this.safe(path,true);
    if (typeof input.content!=='string'||!input.content.trim()||Buffer.byteLength(input.content)>200_000) throw new DomainError('invalid_knowledge','Knowledge needs nonempty Markdown up to 200 KB');
    if (!input.source&&!input.generated) throw new DomainError('provenance_required','Knowledge must reference its underlying source or correction evidence');
    const old=this.store.list('knowledge').find(k=>k.path===path);
    if (input.supersedes) this.store.need('knowledge',input.supersedes);
    if (old && existsSync(target) && digest(readFileSync(target))!==old.hash) this.importFile(path,'human');
    const current=this.store.list('knowledge').find(k=>k.path===path);
    if (current && existsSync(target)) {
      const history=join(this.store.dataRoot,'vault-history',current.id);
      mkdirSync(history,{recursive:true,mode:0o700});
      copyFileSync(target,join(history,`${current.version}-${current.hash}.md`));
    }
    mkdirSync(dirname(target),{recursive:true,mode:0o700});
    const temporary=`${target}.${randomUUID()}.tmp`;
    writeFileSync(temporary,input.content,{mode:0o600}); renameSync(temporary,target);
    const record=this.store.put('knowledge',{...current,path,title:input.title ?? path.split('/').at(-1)?.replace(/\.md$/,''),scope,scopeId,hash:digest(input.content),provenance:{source:input.source ?? 'SQLite operational state',authorId:input.authorId ?? 'system',runId:input.runId ?? null,previousHash:current?.hash ?? null},version:(current?.version ?? 0)+1,supersedes:input.supersedes,humanEdited:input.authorId==='human',generated:Boolean(input.generated)});
    this.index(record,input.content);
    return record;
  }
  read(id: string): Knowledge & {content:string} {
    const record=this.store.need('knowledge',id), path=this.safe(record.path);
    if (!existsSync(path)) throw new DomainError('knowledge_missing','Knowledge file has been removed; its provenance remains in history',404);
    const content=readFileSync(path,'utf8');
    if (digest(content)!==record.hash) { this.importFile(record.path,'human'); return {...this.store.need('knowledge',id),content}; }
    return {...record,content};
  }
  private index(record: Knowledge,content: string) {
    this.store.db.prepare('DELETE FROM knowledge_fts WHERE id=?').run(record.id);
    this.store.db.prepare('INSERT INTO knowledge_fts(id,title,content,scope) VALUES(?,?,?,?)').run(record.id,record.title,content,`${record.scope} ${record.scopeId ?? ''}`);
  }
  private importFile(path: string,authorId: string) {
    const target=this.safe(path), stat=lstatSync(target);
    if (stat.size>200_000) return;
    const content=readFileSync(target,'utf8'), hash=digest(content), old=this.store.list('knowledge').find(k=>k.path===path);
    if (old?.hash===hash) return;
    const scope=path.split('/')[0], pieces=path.split('/');
    const record=this.store.put('knowledge',{...old,path,title:content.match(/^#\s+(.+)$/m)?.[1] ?? pieces.at(-1),scope,scopeId:pieces.length>2?pieces[1]:null,hash,provenance:{source:`Human-edited Markdown: ${path}`,authorId,previousHash:old?.hash ?? null},version:(old?.version ?? 0)+1,humanEdited:true,generated:false});
    this.index(record,content);
    if (path.endsWith('.generated.md') && !this.store.list('attention').some(a=>a.kind==='knowledge_conflict'&&a.path===path&&a.status==='open')) this.store.put('attention',{kind:'knowledge_conflict',title:'Edited operational mirror',detail:`${path} changed outside OpenCorp. Narrative edits do not change identity, reporting, employment or Owner authority. Preserve and reconcile this text against SQLite.`,path,status:'open',requiredAction:'Review the human edit; use an authorized corporate command for operational changes.'});
  }
  scan() {
    for (const file of files(this.root).filter(file=>file.endsWith('.md'))) {
      const path=relative(this.root,file).split(sep).join('/');
      if (roots.has(path.split('/')[0])) this.importFile(path,'human');
    }
    for (const record of this.store.list('knowledge')) if (!existsSync(join(this.root,record.path))) this.store.db.prepare('DELETE FROM knowledge_fts WHERE id=?').run(record.id);
  }
  syncProfiles() {
    const mirror=(path: string,title: string,body: string,scopeId: string) => {
      const content=`# ${title}\n\nGenerated from operational SQLite state. Edit narrative files beside this file; operational changes require authorized commands.\n\n${body}\n`;
      const current=this.store.list('knowledge').find(k=>k.path===path);
      const target=join(this.root,path);
      if (current && existsSync(target) && digest(readFileSync(target))!==current.hash) this.importFile(path,'human');
      const latest=this.store.list('knowledge').find(k=>k.path===path);
      if (latest?.humanEdited) return; // Preserve edits and the conflict record. Never promote text into authority.
      if (latest?.hash===digest(content)) return;
      this.write({path,title,scope:path.split('/')[0],scopeId,content,source:'SQLite operational state',authorId:'system',generated:true});
    };
    for (const employee of this.store.list('employees')) {
      const position=this.store.need('positions',employee.positionId);
      mirror(`employees/${employee.id}/profile.generated.md`,employee.name,`- ID: ${employee.id}\n- Badge: ${employee.badge}\n- Position: ${position.title}\n- Employment: ${employee.status}\n- Home manager: ${employee.homeManagerId ?? 'None'}\n- Department: ${employee.departmentId ?? 'None'}\n- Local model: ${employee.modelId}\n- Role version: ${employee.roleVersion}`,employee.id);
      for (const topic of ['role','experience','performance','relationships']) { const path=`employees/${employee.id}/${topic}.md`; if (!existsSync(join(this.root,path))) this.write({path,title:`${employee.name} — ${topic}`,scope:'employees',scopeId:employee.id,content:`# ${employee.name} — ${topic}\n\n${topic==='role'?employee.role:'Record source-linked observations here. Narrative does not grant authority.'}\n`,source:'Founding or appointment role',authorId:'system'}); }
    }
    for (const product of this.store.list('products')) mirror(`products/${product.id}/profile.generated.md`,product.name,`Repository: ${product.repository}\n\nAssessment: ${product.assessment || 'Awaiting leadership assessment'}\n\nGoals: ${JSON.stringify(product.goals)}\n\nRationale: ${product.rationale}`,product.id);
    for (const department of this.store.list('departments')) mirror(`departments/${department.id}/profile.generated.md`,department.name,`Manager: ${department.managerId}\n\n${department.responsibilities}`,department.id);
    for (const project of this.store.list('projects')) mirror(`projects/${project.id}/profile.generated.md`,project.name,`Outcome: ${project.outcome}\n\nAcceptance:\n${project.acceptance.map(a=>`- ${a}`).join('\n')}\n\nSupervisor: ${project.supervisorId}\n\nState: ${project.status}`,project.id);
  }
  search(query: string,options: {scopeId?:string;limit?:number}={}) {
    this.scan();
    const limit=Math.max(1,Math.min(options.limit ?? 20,100));
    if (!query.trim()) return this.store.list('knowledge').filter(k=>!options.scopeId||k.scopeId===options.scopeId).slice(0,limit);
    const terms=query.match(/[\p{L}\p{N}_-]+/gu)?.slice(0,20) ?? [];
    if (!terms.length) return [];
    const match=terms.map(t=>`"${t.replaceAll('"','""')}"`).join(' AND ');
    const rows=this.store.db.prepare("SELECT id, snippet(knowledge_fts,2,'[',']','…',25) AS excerpt FROM knowledge_fts WHERE knowledge_fts MATCH ? ORDER BY bm25(knowledge_fts) LIMIT ?").all(match,limit*5) as {id:string;excerpt:string}[];
    return rows.map(row=>({...this.store.need('knowledge',row.id),excerpt:row.excerpt})).filter(k=>!options.scopeId||k.scopeId===options.scopeId).slice(0,limit);
  }
  retrieve(options: {query?:string;scopeIds?:string[];budgetChars?:number}) {
    const candidates=this.search(options.query ?? '',{limit:100});
    let remaining=Math.max(0,Math.min(options.budgetChars ?? 12_000,40_000));
    const result: {id:string;path:string;content:string;provenance:any}[]=[];
    for (const candidate of candidates.filter(k=>k.scope==='company'||!options.scopeIds?.length||options.scopeIds.includes(k.scopeId ?? ''))) {
      if (remaining<=0) break;
      const note=this.read(candidate.id), content=note.content.slice(0,remaining);
      result.push({id:note.id,path:note.path,content,provenance:note.provenance}); remaining-=content.length;
    }
    return result;
  }
  backup() {
    this.scan();
    const path=join(this.store.dataRoot,'backups',`${new Date().toISOString().replaceAll(':','-')}-${randomUUID().slice(0,8)}`);
    mkdirSync(path,{recursive:true,mode:0o700});
    // Synchronous VACUUM INTO and vault copy run in one writer event-loop turn, without awaits.
    this.store.db.exec(`VACUUM INTO '${join(path,'company.sqlite').replaceAll("'","''")}'`);
    copyTree(this.root,join(path,'vault'));
    if (existsSync(join(this.store.dataRoot,'vault-history'))) copyTree(join(this.store.dataRoot,'vault-history'),join(path,'vault-history'));
    const entries=files(path).map(file=>({path:relative(path,file),hash:digest(readFileSync(file))}));
    writeFileSync(join(path,'manifest.json'),JSON.stringify({version:1,companyId:this.store.company.id,createdAt:new Date().toISOString(),files:entries},null,2),{mode:0o600});
    this.store.emit('backup.created',{path}); return {path,companyId:this.store.company.id,files:entries.length};
  }
  restore(path: string) {
    if (!['paused','stopped'].includes(this.store.company.state)) throw new DomainError('pause_required','Pause or stop the company before restoring a backup',409);
    const source=realpathSync(resolve(path)), manifestPath=join(source,'manifest.json');
    if (!existsSync(manifestPath)) throw new DomainError('invalid_backup','Backup manifest is missing');
    const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
    if (manifest.version!==1 || !Array.isArray(manifest.files)) throw new DomainError('invalid_backup','Unsupported backup format');
    const listed=manifest.files.map((entry:any)=>entry.path).sort(),actual=files(source).map(file=>relative(source,file)).filter(file=>file!=='manifest.json').sort();
    if(JSON.stringify(listed)!==JSON.stringify(actual)||!listed.includes('company.sqlite'))throw new DomainError('invalid_backup','Backup manifest must cover every retained file exactly once.');
    if(manifest.companyId!==this.store.company.id)throw new DomainError('invalid_backup','Restore must belong to this company; use an explicit isolated data directory for a different company.');
    for (const entry of manifest.files) {
      const file=resolve(source,entry.path);
      if (!file.startsWith(`${source}${sep}`)||!existsSync(file)||!realpathSync(file).startsWith(`${source}${sep}`)||lstatSync(file).isSymbolicLink()||digest(readFileSync(file))!==entry.hash) throw new DomainError('invalid_backup','Backup file missing, unsafe or hash mismatch');
    }
    const sourceDb=new Database(join(source,'company.sqlite'),{readonly:true});
    const checked=sourceDb.pragma('integrity_check',{simple:true});
    if (checked!=='ok') { sourceDb.close(); throw new DomainError('invalid_backup','Backup database failed integrity check'); }
    const priorActions=this.store.list('actions'), revision=this.store.policy.revision;
    const records=Object.fromEntries(TABLES.map(table=>[table,(sourceDb.prepare(`SELECT data FROM ${table}`).all() as {data:string}[]).map(row=>JSON.parse(row.data))]));
    sourceDb.close();
    if (records.company.length!==1||records.policy.length!==1||records.company[0].id!==manifest.companyId) throw new DomainError('invalid_backup','Backup does not contain one consistent company');
    const transactionId=randomUUID(),journal=join(this.store.dataRoot,'restore-intent.json');
    const staging=join(this.store.dataRoot,`vault-restore-${transactionId}`), previous=join(this.store.dataRoot,`vault-before-restore-${transactionId}`);
    copyTree(join(source,'vault'),staging);
    writeFileSync(journal,JSON.stringify({id:transactionId,source,createdAt:new Date().toISOString()}),{mode:0o600,flush:true});
    try {
      renameSync(this.root,previous); renameSync(staging,this.root);
      this.store.db.transaction(() => {
        for (const table of TABLES) { this.store.db.prepare(`DELETE FROM ${table}`).run(); for (const record of records[table]) this.store.put(table as TableName,record); }
        this.store.db.prepare('DELETE FROM knowledge_fts').run();
        this.store.update('policy',this.store.policy.id,{revision:Math.max(revision,this.store.policy.revision)+1});
        this.store.update('company',this.store.company.id,{state:'paused',restoredAt:new Date().toISOString(),restoreTransactionId:transactionId});
        for (const run of this.store.list('runs')) this.store.update('runs',run.id,{tokenRevoked:true,...(['running','queued','cancelling'].includes(run.status)?{status:'interrupted'}:{})});
        for (const assignment of this.store.list('assignments').filter(a=>a.status==='running')) this.store.update('assignments',assignment.id,{status:'blocked',blockedReason:'Restored workspace must be inspected before resuming'});
        for (const action of this.store.list('actions')) if (['prepared','dispatched'].includes(action.status)) this.store.update('actions',action.id,{status:'uncertain',uncertainReason:'Restored intent requires current provider reconciliation'});
        // Preserve observed actions newer than the snapshot; a rollback must not erase a send receipt.
        for (const action of priorActions) {
          const duplicate=this.store.list('actions').find(a=>a.dedupeKey===action.dedupeKey);
          if (duplicate&&duplicate.id!==action.id) this.store.db.prepare('DELETE FROM actions WHERE id=?').run(duplicate.id);
          this.store.put('actions',{...action,...(['prepared','dispatched'].includes(action.status)?{status:'uncertain'}:{})});
        }
        for (const record of this.store.list('knowledge')) { const target=join(this.root,record.path); if (existsSync(target)) this.index(record,readFileSync(target,'utf8')); }
      })();
    } catch (error) { if(existsSync(previous)){rmSync(this.root,{recursive:true,force:true}); renameSync(previous,this.root);}rmSync(staging,{recursive:true,force:true});rmSync(journal); throw error; }
    rmSync(previous,{recursive:true,force:true});
    rmSync(journal);
    this.store.emit('backup.restored',{path:source,companyId:this.store.company.id});
    return {path:source,companyId:this.store.company.id,state:'paused',reconcileActions:this.store.list('actions').filter(a=>a.status==='uncertain').length};
  }
}
