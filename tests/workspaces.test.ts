import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CompanyStore } from '../src/storage/store.js';
import { WorkspaceManager } from '../src/tools/workspaces.js';

let root:string,store:CompanyStore,manager:WorkspaceManager,workspace:string,mirror:string,productId:string;
const git=(args:string[])=>execFileSync('/usr/bin/git',['--git-dir',mirror,'--work-tree',workspace,'-c','user.name=Fixture','-c','user.email=fixture@localhost','-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{cwd:workspace,env:{PATH:'/usr/bin:/bin',HOME:root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},encoding:'utf8'}).trim();
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'opencorp-source-'));store=new CompanyStore(root);store.bootstrap();manager=new WorkspaceManager(store,root);workspace=join(root,'workspaces','fixture');mirror=join(root,'repositories','fixture.git');mkdirSync(workspace,{recursive:true});mkdirSync(join(root,'repositories'),{recursive:true});execFileSync('/usr/bin/git',['init','--bare',mirror],{stdio:'pipe'});productId=store.list('products')[0].id;});
afterEach(()=>{store.close();rmSync(root,{recursive:true,force:true});});
function commitFile(name:string,content:string|Buffer){writeFileSync(join(workspace,name),content);git(['add','--all']);git(['commit','-m','Immutable source fixture']);store.update('products',productId,{binding:{mirror,baseCommit:git(['rev-parse','HEAD'])}});}

describe('exact source reads',()=>{
 it('preserves complete source beyond the old output cutoff, including leading whitespace, Unicode and trailing newlines',async()=>{
  const source='  BEGIN exact source\n'+'Unicode Ω source line\n'.repeat(9000)+'\nEND exact source  \n\n';commitFile('README.md',source);
  const content=await manager.readProduct(productId,'README.md');if(typeof content!=='string')throw new Error('Expected file text');expect(content.length).toBeGreaterThan(100000);expect(content).toBe(source);
  const pages=Array.from({length:Math.ceil(content.length/6000)},(_,i)=>content.slice(i*6000,(i+1)*6000));expect(pages.join('')).toBe(source);expect(pages[0]).toMatch(/^ {2}BEGIN/);expect(pages.at(-1)).toMatch(/END exact source {2}\n\n$/);
 });
 it('rejects an oversized immutable blob explicitly instead of returning a misleading tail',async()=>{commitFile('large.txt','x'.repeat(2_000_001));await expect(manager.readProduct(productId,'large.txt')).rejects.toThrow(/2000000-byte read limit/);});
 it('rejects binary source, path escape and a repository removed from the Owner envelope',async()=>{
  commitFile('binary.dat',Buffer.from([0,255,1,2]));await expect(manager.readProduct(productId,'binary.dat')).rejects.toThrow(/not a UTF-8 text file/);await expect(manager.readProduct(productId,'../outside')).rejects.toThrow(/repository-relative/);
  store.update('policy',store.policy.id,{allowedRepositories:[]});await expect(manager.readProduct(productId,'binary.dat')).rejects.toThrow(/Owner envelope/);
 });
});

describe('company-owned executable repositories',()=>{
 it('creates a persistent local repository and isolated workspace without a provider',async()=>{
  const id='internal-fixture',repository=join(root,'repositories',`${id}.git`);
  const product=store.put('products',{id,name:'Useful helper',kind:'internal-tool',repository});
  const binding=await manager.inspect(product);expect(binding.local).toBe(true);expect(binding.issues).toEqual([]);
  const project=store.put('projects',{name:'Implement helper',productId:id});const ready=await manager.ensure(project);
  expect(await manager.head(ready)).toBe(binding.baseCommit);expect(await manager.clean(ready)).toBe(true);
  expect((await manager.inspect(store.need('products',id))).baseCommit).toBe(binding.baseCommit);
 });
 it('rejects an internal registration pointing to unrelated files',async()=>{
  const product=store.put('products',{id:'internal-fixture',name:'Bad helper',kind:'internal-tool',repository:workspace});
  await expect(manager.inspect(product)).rejects.toThrow(/assigned company-owned/);
 });
});

it('lists root and subdirectories from the exact bound commit without following symlinks or live changes',async()=>{
 mkdirSync(join(workspace,'docs'));writeFileSync(join(workspace,'docs','with space.md'),'Pinned documentation');symlinkSync('/outside-owner-directory',join(workspace,'outside-link'));
 commitFile('README.md','Root source');const baseline=store.need('products',productId).binding.baseCommit;
 const listing=await manager.readProduct(productId,'.');if(typeof listing==='string')throw new Error('Expected directory');
 expect(listing).toMatchObject({sourceKind:'directory',baseCommit:baseline});expect(JSON.parse(listing.content)).toEqual(expect.arrayContaining([expect.objectContaining({name:'docs',kind:'directory'}),expect.objectContaining({name:'outside-link',kind:'symlink'}),expect.objectContaining({name:'README.md',kind:'file'})]));
 const subdir=await manager.readProduct(productId,'docs/');if(typeof subdir==='string')throw new Error('Expected directory');expect(JSON.parse(subdir.content)).toEqual([expect.objectContaining({name:'with space.md',kind:'file'})]);
 expect(await manager.readProduct(productId,'docs/with space.md')).toBe('Pinned documentation');
 commitFile('NEW.md','Later source');store.update('products',productId,{binding:{mirror,baseCommit:baseline}});
 expect(await manager.readProduct(productId,'.')).toEqual(listing);
 await expect(manager.readProduct(productId,'outside-link/secret')).rejects.toThrow();await expect(manager.readProduct(productId,'docs/../../secret')).rejects.toThrow(/repository-relative/);
 store.update('policy',store.policy.id,{allowedRepositories:[]});await expect(manager.readProduct(productId,'.')).rejects.toThrow(/Owner envelope/);
});
