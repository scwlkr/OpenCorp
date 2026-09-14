import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CompanyStore } from './store.js';
import { DomainError, type Employee, type Knowledge, type TableName } from '../core/types.js';
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

interface ManagedAssets { skills:Array<{id:string;sourceHash:string;licenseHash:string}>; tools:Array<{productId:string;identities:string[];bundle:string;main:string}> }
const git=(args:string[])=>execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','protocol.file.allow=always',...args],{encoding:'utf8',timeout:30_000,maxBuffer:2*1024*1024,env:{PATH:process.env.PATH,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'}}).trim();
function ownedPath(root:string,path:string){
 const absolute=resolve(root,path),resolvedRoot=realpathSync(root);
 if(!absolute.startsWith(`${resolve(root)}${sep}`))throw new DomainError('invalid_backup','Managed asset path escapes owned storage');
 let current=resolve(root);
 for(const segment of relative(root,absolute).split(sep)){current=join(current,segment);if(existsSync(current)&&(lstatSync(current).isSymbolicLink()||!realpathSync(current).startsWith(`${resolvedRoot}${sep}`)))throw new DomainError('invalid_backup','Managed assets cannot use symlinks or external storage');}
 return absolute;
}
function additiveFiles(source:string,destination:string,apply=false,prefix=''){
 if(!existsSync(source))return;
 for(const file of files(source)){
  const target=ownedPath(destination,join(prefix,relative(source,file)));
  if(existsSync(target)&&(!lstatSync(target).isFile()||digest(readFileSync(target))!==digest(readFileSync(file))))throw new DomainError('restore_asset_conflict',`Retained managed file differs; preserve and inspect before restore: ${target}`,409);
  if(apply&&!existsSync(target)){mkdirSync(dirname(target),{recursive:true,mode:0o700});copyFileSync(file,target);}
 }
}
function safeRepository(repository:string){
 if(!lstatSync(repository).isDirectory())throw new DomainError('invalid_backup','Owned repository must be a directory');
 const inspect=(directory:string)=>{for(const name of readdirSync(directory)){const path=join(directory,name),stat=lstatSync(path);if(stat.isSymbolicLink())throw new DomainError('invalid_backup','Owned tool repository contains a symlink');if(stat.isDirectory())inspect(path);}};inspect(repository);
 if(existsSync(join(repository,'objects/info/alternates')))throw new DomainError('invalid_backup','Owned tool repository cannot depend on external object stores');
}
function expectedAssets(records:Record<string,any[]>):ManagedAssets {
 const skills=records.experiences.filter(r=>r.kind==='skill-source').map(r=>{
  if(!/^[a-f0-9]{64}$/.test(r.id)||!['sha256','licenseHash'].every(key=>/^[a-f0-9]{64}$/.test(r[key])))throw new DomainError('invalid_backup','Managed source lacks exact source/license identities');
  return {id:r.id,sourceHash:r.sha256,licenseHash:r.licenseHash};
 });
 const tools=records.products.filter(p=>p.kind==='internal-tool'&&(p.adoption||p.adoptionHistory?.length)).map(p=>{
  const identities=[...new Set<string>([p.adoption,...(p.adoptionHistory??[])].filter(Boolean).map(a=>a.identity))].sort();
  if(!/^[a-zA-Z0-9-]+$/.test(p.id)||identities.some(id=>!/^[a-f0-9]{40,64}$/.test(id)))throw new DomainError('invalid_backup','Adopted tool lacks immutable source identities');
  return {productId:p.id,identities,bundle:`repositories/${p.id}.bundle`,main:p.adoption?.identity??identities[0]};
 });
 return {skills:skills.sort((a,b)=>a.id.localeCompare(b.id)),tools:tools.sort((a,b)=>a.productId.localeCompare(b.productId))};
}
function validateSkillAssets(root:string,assets:ManagedAssets){
 for(const source of assets.skills){
  const directory=ownedPath(root,`skills/vendor/${source.id}`);
  const sourcePath=ownedPath(root,`skills/vendor/${source.id}/SOURCE.md`),licensePath=ownedPath(root,`skills/vendor/${source.id}/LICENSE`),manifestPath=ownedPath(root,`skills/vendor/${source.id}/manifest.json`);
  if(![sourcePath,licensePath,manifestPath].every(file=>existsSync(file)&&lstatSync(file).isFile()))throw new DomainError('invalid_backup',`Managed source files are missing: ${source.id}`);
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  if(digest(readFileSync(sourcePath))!==source.sourceHash||digest(readFileSync(licensePath))!==source.licenseHash||manifest.id!==source.id||manifest.sha256!==source.sourceHash||manifest.licenseHash!==source.licenseHash)throw new DomainError('invalid_backup',`Managed source/license identity mismatch: ${directory}`);
 }
}

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
    if(this.store.company.direction==='software-factory')this.syncMandate();
    this.syncProfiles();
    this.scan();
  }
  syncMandate() {
    const content=`# Current company mandate\n\n${this.store.company.mandate}\n`;
    const current=this.store.list('knowledge').find(k=>k.path==='company/mandate.md');
    if(current&&existsSync(join(this.root,current.path))&&this.read(current.id).content===content)return;
    this.write({path:'company/mandate.md',title:'Current company mandate',content,source:'Owner-approved company direction; prior text retained in vault history',authorId:'owner',generated:true});
  }
  /** The file is authoritative only at its approved hash. SQLite retains a recovery
   * snapshot, never a separately editable role. An interrupted write or draft edit
   * cannot activate instructions without the management command committing. */
  approvedRole(employee:Employee):string {
    const revision=this.store.list('roleVersions').find(r=>r.employeeId===employee.id&&r.version===employee.roleVersion);
    if(!revision?.hash)return employee.role ?? revision?.content ?? '';
    try {
      const path=this.safe(revision.path);
      if(lstatSync(path).size>200000)return revision.content;
      const content=readFileSync(path,'utf8');
      if(digest(content)===revision.hash)return content;
    } catch { /* Use the last approved snapshot if its Markdown is unavailable. */ }
    return revision.content;
  }
  approveRole(employee:Employee,content:string,metadata:Record<string,any>) {
    if(content.length>12000&&!this.store.list('roleVersions').some(r=>r.employeeId===employee.id&&r.content.trim()===content))throw new DomainError('invalid_role','Keep approved skills concise: at most 12000 characters');
    const path=`employees/${employee.id}/role.md`;
    const note=this.write({...metadata,path,scope:'employees',scopeId:employee.id,title:`${employee.name} — approved skill`,content},true);
    const revision=this.store.put('roleVersions',{...metadata,employeeId:employee.id,version:employee.roleVersion+1,content,path,hash:note.hash});
    this.store.update('employees',employee.id,{roleVersion:revision.version});
    return revision;
  }
  write(input: Record<string,any>, approvedRole=false): Knowledge {
    const scope=input.scope ?? (input.path?String(input.path).split('/')[0]:'company');
    if (!roots.has(scope)) throw new DomainError('invalid_scope','Unknown knowledge scope');
    const scopeId=input.scopeId ?? null;
    const path=input.path ?? `${scope}/${scopeId?`${scopeId}/`:''}${randomUUID()}.md`;
    if (/^employees\/[^/]+\/role\.md$/.test(relative(this.root,resolve(this.root,path)).split(sep).join('/'))&&!approvedRole) throw new DomainError('role_approval_required','Use update_role through responsible management to approve employee Markdown',403);
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
      const revision=this.store.list('roleVersions').find(r=>r.employeeId===employee.id&&r.version===employee.roleVersion);
      if(revision&&!revision.hash){
        // Retained active instructions win over the old seeded role copy. write()
        // preserves the old Markdown in existing history before migration.
        const path=`employees/${employee.id}/role.md`,content=employee.role;
        const note=this.write({path,title:`${employee.name} — approved skill`,scope:'employees',scopeId:employee.id,content,source:revision.source,authorId:revision.authorId},true);
        this.store.update('roleVersions',revision.id,{content,path,hash:note.hash});
        this.store.update('employees',employee.id,{});
      }
      for (const topic of ['experience','performance','relationships']) { const path=`employees/${employee.id}/${topic}.md`; if (!existsSync(join(this.root,path))) this.write({path,title:`${employee.name} — ${topic}`,scope:'employees',scopeId:employee.id,content:`# ${employee.name} — ${topic}\n\nRecord source-linked observations here. Narrative does not grant authority.\n`,source:'Founding or appointment role',authorId:'system'}); }
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
    const records=Object.fromEntries(TABLES.map(table=>[table,this.store.list(table)])),managedAssets=expectedAssets(records);
    validateSkillAssets(this.store.dataRoot,managedAssets);
    for(const source of managedAssets.skills){const relativeDirectory=`skills/vendor/${source.id}`,sourceDirectory=ownedPath(this.store.dataRoot,relativeDirectory),destination=join(path,relativeDirectory);mkdirSync(destination,{recursive:true,mode:0o700});for(const name of ['SOURCE.md','LICENSE','manifest.json'])copyFileSync(join(sourceDirectory,name),join(destination,name));}
    const staging=join(path,'.bundle-staging');
    try{
      for(const tool of managedAssets.tools){
        const product=this.store.need('products',tool.productId),repository=ownedPath(this.store.dataRoot,`repositories/${tool.productId}.git`);
        if(product.repository!==repository||!existsSync(repository))throw new DomainError('invalid_backup','Adopted internal tool repository is missing or outside its owned location');
        safeRepository(repository);
        mkdirSync(staging,{recursive:true,mode:0o700});const isolated=join(staging,`${tool.productId}.git`);git(['init','--bare','--quiet',isolated]);
        for(const identity of tool.identities)git(['--git-dir',isolated,'fetch','--quiet','--no-tags',repository,`${identity}:refs/heads/retained/${identity}`]);
        mkdirSync(join(path,'repositories'),{recursive:true,mode:0o700});git(['--git-dir',isolated,'bundle','create',join(path,tool.bundle),'--all']);
      }
    }finally{rmSync(staging,{recursive:true,force:true});}
    validateSkillAssets(path,managedAssets);
    const entries=files(path).map(file=>({path:relative(path,file),hash:digest(readFileSync(file))}));
    writeFileSync(join(path,'manifest.json'),JSON.stringify({version:2,managedAssets,companyId:this.store.company.id,createdAt:new Date().toISOString(),files:entries},null,2),{mode:0o600});
    this.store.emit('backup.created',{path}); return {path,companyId:this.store.company.id,files:entries.length};
  }
  restore(path: string) {
    if (!['paused','stopped'].includes(this.store.company.state)) throw new DomainError('pause_required','Pause or stop the company before restoring a backup',409);
    const source=realpathSync(resolve(path)), manifestPath=join(source,'manifest.json');
    if (!existsSync(manifestPath)) throw new DomainError('invalid_backup','Backup manifest is missing');
    const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
    if (![1,2].includes(manifest.version) || !Array.isArray(manifest.files)) throw new DomainError('invalid_backup','Unsupported backup format');
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
    const ownerProposals=this.store.list('attention').filter(a=>a.kind==='owner_proposal');
    const priorActions=this.store.list('actions'), revision=this.store.policy.revision;
    const conversationIntegrations=['owner-telegram','owner-email'].flatMap(id=>{const value=this.store.get('integrations',id);return value?[value]:[];});
    const conversationMessages=this.store.list('messages').filter(m=>m.telegram?.direction==='incoming'||m.email?.direction==='incoming'||conversationIntegrations.length>0&&m.recipientId==='owner');
    const conversationMessageIds=new Set(conversationMessages.map(m=>m.id));
    const conversationRunIds=new Set(conversationMessages.map(m=>m.runId));
    const conversationRuns=this.store.list('runs').filter(r=>conversationRunIds.has(r.id)||this.store.get('assignments',r.assignmentId)?.payload?.messageId&&conversationMessageIds.has(this.store.need('assignments',r.assignmentId).payload.messageId));
    const conversationAssignmentIds=new Set(conversationRuns.map(r=>r.assignmentId));
    const conversationAssignments=this.store.list('assignments').filter(a=>conversationMessageIds.has(a.payload?.messageId)||conversationAssignmentIds.has(a.id)||a.payload?.emailReport);
    const records=Object.fromEntries(TABLES.map(table=>[table,(sourceDb.prepare(`SELECT data FROM ${table}`).all() as {data:string}[]).map(row=>JSON.parse(row.data))]));
    sourceDb.close();
    if (records.company.length!==1||records.policy.length!==1||records.company[0].id!==manifest.companyId) throw new DomainError('invalid_backup','Backup does not contain one consistent company');
    const managedAssets=expectedAssets(records);
    if(managedAssets.skills.length||managedAssets.tools.length){if(manifest.version!==2||JSON.stringify(manifest.managedAssets)!==JSON.stringify(managedAssets))throw new DomainError('invalid_backup','Backup must retain every referenced source and adopted tool version');}
    if(managedAssets.tools.some(tool=>!listed.includes(tool.bundle)))throw new DomainError('invalid_backup','Backup is missing a referenced adopted tool bundle');
    validateSkillAssets(source,managedAssets);
    // Additive restoration never replaces newer immutable sources, history, or repository refs.
    // Compare against final owned paths, not a temporary destination.
    for(const skill of managedAssets.skills)for(const name of ['SOURCE.md','LICENSE','manifest.json']){
      const relativeFile=`skills/vendor/${skill.id}/${name}`,target=ownedPath(this.store.dataRoot,relativeFile),input=join(source,relativeFile);
      if(existsSync(target)&&(!lstatSync(target).isFile()||digest(readFileSync(target))!==digest(readFileSync(input))))throw new DomainError('restore_asset_conflict',`Retained managed file differs; preserve before restore: ${target}`,409);
    }
    if(existsSync(join(source,'vault-history')))additiveFiles(join(source,'vault-history'),this.store.dataRoot,false,'vault-history');
    const transactionId=randomUUID(),journal=join(this.store.dataRoot,'restore-intent.json');
    const staging=join(this.store.dataRoot,`vault-restore-${transactionId}`), previous=join(this.store.dataRoot,`vault-before-restore-${transactionId}`);
    const repositoryStaging=join(this.store.dataRoot,`repositories-restore-${transactionId}`);
    try{
      for(const tool of managedAssets.tools){
        const repository=ownedPath(this.store.dataRoot,`repositories/${tool.productId}.git`),isolated=join(repositoryStaging,`${tool.productId}.git`);
        mkdirSync(repositoryStaging,{recursive:true,mode:0o700});git(['init','--bare','--quiet',isolated]);
        git(['--git-dir',isolated,'fetch','--quiet','--no-tags',join(source,tool.bundle),'+refs/heads/retained/*:refs/heads/retained/*']);
        for(const identity of tool.identities)git(['--git-dir',isolated,'cat-file','-e',`${identity}^{commit}`]);
        if(existsSync(repository))safeRepository(repository);
        if(existsSync(repository)&&git(['--git-dir',repository,'rev-parse','--is-bare-repository'])!=='true')throw new DomainError('restore_asset_conflict','Owned internal tool location is not a bare repository');
      }
      for(const tool of managedAssets.tools){
        const repository=ownedPath(this.store.dataRoot,`repositories/${tool.productId}.git`);if(!existsSync(repository)){mkdirSync(dirname(repository),{recursive:true,mode:0o700});git(['init','--bare','--quiet',repository]);}
        git(['--git-dir',repository,'fetch','--quiet','--no-tags',join(repositoryStaging,`${tool.productId}.git`),`refs/heads/retained/*:refs/opencorp-restore/${transactionId}/*`]);
        const refs=git(['--git-dir',repository,'for-each-ref','--format=%(refname)','refs/heads/main']);if(!refs)git(['--git-dir',repository,'update-ref','refs/heads/main',tool.main,'']);
        const product=records.products.find(p=>p.id===tool.productId)!;product.repository=repository;if(product.binding)product.binding={...product.binding,repository,mirror:repository};
      }
      for(const skill of managedAssets.skills){const relativeDirectory=`skills/vendor/${skill.id}`;additiveFiles(join(source,relativeDirectory),this.store.dataRoot,true,relativeDirectory);records.experiences.find(r=>r.id===skill.id)!.sourcePath=join(this.store.dataRoot,relativeDirectory,'SOURCE.md');}
      if(existsSync(join(source,'vault-history')))additiveFiles(join(source,'vault-history'),this.store.dataRoot,true,'vault-history');
    }finally{rmSync(repositoryStaging,{recursive:true,force:true});}
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
        // Restoring a backup cannot rewind confirmed Owner intake or lose an accepted message.
        for(const proposal of ownerProposals)this.store.put('attention',proposal);
        for(const integration of conversationIntegrations)this.store.put('integrations',integration);
        for(const message of conversationMessages)this.store.put('messages',message);
        for(const run of conversationRuns)this.store.put('runs',{...run,tokenRevoked:true,...(['running','queued','cancelling'].includes(run.status)?{status:'interrupted'}:{})});
        for(const assignment of conversationAssignments)this.store.put('assignments',{...assignment,...(assignment.status==='running'?{status:'blocked',blockedReason:'Restored conversation requires run reconciliation before resuming'}:{})});
        for (const record of this.store.list('knowledge')) { const target=join(this.root,record.path); if (existsSync(target)) this.index(record,readFileSync(target,'utf8')); }
      })();
    } catch (error) { if(existsSync(previous)){rmSync(this.root,{recursive:true,force:true}); renameSync(previous,this.root);}rmSync(staging,{recursive:true,force:true});rmSync(journal); throw error; }
    rmSync(previous,{recursive:true,force:true});
    rmSync(journal);
    this.store.emit('backup.restored',{path:source,companyId:this.store.company.id});
    return {path:source,companyId:this.store.company.id,state:'paused',reconcileActions:this.store.list('actions').filter(a=>a.status==='uncertain').length};
  }
}
