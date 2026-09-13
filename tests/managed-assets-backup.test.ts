import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyStore } from '../src/storage/store.js';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex'),owner={kind:'owner'} as const;
let root:string,store:CompanyStore;
const git=(args:string[],input?:string)=>execFileSync('/usr/bin/git',args,{encoding:'utf8',input,env:{...process.env,GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'}}).trim();
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'opencorp-managed-backup-'));store=new CompanyStore(root);store.bootstrap();});
afterEach(()=>{store.close();rmSync(root,{recursive:true,force:true});});
function skill(suffix='source'){
 const id=hash(suffix),directory=join(root,'skills/vendor',id),content=`# ${suffix} fixture instructions`,license='MIT License fixture';mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'SOURCE.md'),content);writeFileSync(join(directory,'LICENSE'),license);
 const record=store.put('experiences',{id,kind:'skill-source',sha256:hash(content),licenseHash:hash(license),sourcePath:join(directory,'SOURCE.md')});writeFileSync(join(directory,'manifest.json'),JSON.stringify(record));return {id,directory,content,license};
}
function tool(){
 const repository=join(root,'repositories/tool-fixture.git');mkdirSync(join(root,'repositories'));git(['init','--bare','--quiet',repository]);
 const commit=(content:string,parent?:string)=>{const blob=git(['--git-dir',repository,'hash-object','-w','--stdin'],content),tree=git(['--git-dir',repository,'mktree'],`100644 blob ${blob}\ttool.mjs\n`);return git(['--git-dir',repository,'commit-tree',tree,...(parent?['-p',parent]:[]),'-m','Employee tool fixture']);};
 const first=commit('console.log("v1")'),second=commit('console.log("v2")',first);git(['--git-dir',repository,'update-ref','refs/heads/main',second]);
 store.put('products',{id:'tool-fixture',name:'Fixture internal tool',kind:'internal-tool',repository,adoption:{identity:second},adoptionHistory:[{identity:first},{identity:second}],binding:{repository,mirror:repository,baseCommit:second}});
 return {repository,first,second,commit};
}
describe('managed immutable assets in consistent backup',()=>{
 it('restores referenced skills, licenses, manifests and history while preserving newer unique files and excluding caches',()=>{
  const source=skill();mkdirSync(join(root,'vault-history/note'),{recursive:true});writeFileSync(join(root,'vault-history/note/prior.md'),'prior narrative');mkdirSync(join(root,'models'));writeFileSync(join(root,'models/large-model'),'do not copy model cache');
  const backup=store.backup(),manifest=JSON.parse(readFileSync(join(backup.path,'manifest.json'),'utf8'));expect(manifest.version).toBe(2);expect(manifest.files.some((f:any)=>f.path.startsWith('models/'))).toBe(false);
  const later=skill('later-unique');rmSync(source.directory,{recursive:true});rmSync(join(root,'vault-history/note'),{recursive:true});store.command(owner,{type:'control',action:'pause'});store.restore(backup.path);
  expect(readFileSync(join(source.directory,'SOURCE.md'),'utf8')).toBe(source.content);expect(readFileSync(join(source.directory,'LICENSE'),'utf8')).toBe(source.license);expect(existsSync(join(later.directory,'SOURCE.md'))).toBe(true);expect(readFileSync(join(root,'vault-history/note/prior.md'),'utf8')).toBe('prior narrative');expect(store.need('experiences',source.id).sourcePath).toBe(join(source.directory,'SOURCE.md'));
 });
 it('restores all adopted tool commit versions without source workspaces and preserves newer repository refs',()=>{
  const source=tool(),backup=store.backup();const third=source.commit('console.log("newer unique source")',source.second);git(['--git-dir',source.repository,'update-ref','refs/heads/main',third]);
  store.command(owner,{type:'control',action:'pause'});store.restore(backup.path);expect(git(['--git-dir',source.repository,'rev-parse','refs/heads/main'])).toBe(third);expect(git(['--git-dir',source.repository,'show',`${source.first}:tool.mjs`])).toContain('v1');expect(store.need('products','tool-fixture').adoption.identity).toBe(source.second);
  // Restoring a lost owned repo proves the bundle is self-contained, not a live alternate.
  rmSync(source.repository,{recursive:true});store.restore(backup.path);expect(git(['--git-dir',source.repository,'show',`${source.second}:tool.mjs`])).toContain('v2');expect(git(['--git-dir',source.repository,'show',`${source.first}:tool.mjs`])).toContain('v1');
 });
 it('refuses conflicting human edits or linked assets before replacing operational state',()=>{
  const source=skill(),backup=store.backup();writeFileSync(join(source.directory,'SOURCE.md'),'Human correction to retain');store.command(owner,{type:'control',action:'pause'});const state=store.snapshot();expect(()=>store.restore(backup.path)).toThrow(/Retained managed file differs/);expect(store.snapshot().company).toEqual(state.company);expect(readFileSync(join(source.directory,'SOURCE.md'),'utf8')).toBe('Human correction to retain');
  rmSync(source.directory,{recursive:true});mkdirSync(join(root,'other'));symlinkSync(join(root,'other'),source.directory);expect(()=>store.restore(backup.path)).toThrow(/symlinks/);expect(existsSync(join(root,'other/SOURCE.md'))).toBe(false);
 });
 it('does not accept modified skill content even with a recomputed file manifest',()=>{
  const source=skill(),internal=tool(),backup=store.backup();store.command(owner,{type:'control',action:'pause'});
  const manifestPath=join(backup.path,'manifest.json'),manifest=JSON.parse(readFileSync(manifestPath,'utf8')),sourcePath=`skills/vendor/${source.id}/SOURCE.md`;writeFileSync(join(backup.path,sourcePath),'tampered source');manifest.files.find((f:any)=>f.path===sourcePath).hash=hash('tampered source');writeFileSync(manifestPath,JSON.stringify(manifest));expect(()=>store.restore(backup.path)).toThrow(/identity mismatch/);expect(git(['--git-dir',internal.repository,'rev-parse','refs/heads/main'])).toBe(internal.second);
 });
 it('refuses an omitted tool bundle before touching live source or SQLite',()=>{
  const internal=tool(),backup=store.backup();store.command(owner,{type:'control',action:'pause'});const manifestPath=join(backup.path,'manifest.json'),manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  rmSync(join(backup.path,'repositories/tool-fixture.bundle'));manifest.files=manifest.files.filter((f:any)=>f.path!=='repositories/tool-fixture.bundle');writeFileSync(manifestPath,JSON.stringify(manifest));const prior=store.company;
  expect(()=>store.restore(backup.path)).toThrow();expect(store.company).toEqual(prior);expect(git(['--git-dir',internal.repository,'rev-parse','refs/heads/main'])).toBe(internal.second);
 });
 it('retains compatibility with historical v1 backups that have no new asset references',()=>{
  const backup=store.backup(),path=join(backup.path,'manifest.json'),manifest=JSON.parse(readFileSync(path,'utf8'));manifest.version=1;delete manifest.managedAssets;writeFileSync(path,JSON.stringify(manifest));store.command(owner,{type:'control',action:'pause'});expect(store.restore(backup.path).state).toBe('paused');
 });
});
