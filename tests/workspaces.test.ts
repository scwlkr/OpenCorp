import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  const content=await manager.readProduct(productId,'README.md');expect(content.length).toBeGreaterThan(100000);expect(content).toBe(source);
  const pages=Array.from({length:Math.ceil(content.length/6000)},(_,i)=>content.slice(i*6000,(i+1)*6000));expect(pages.join('')).toBe(source);expect(pages[0]).toMatch(/^ {2}BEGIN/);expect(pages.at(-1)).toMatch(/END exact source {2}\n\n$/);
 });
 it('rejects an oversized immutable blob explicitly instead of returning a misleading tail',async()=>{commitFile('large.txt','x'.repeat(2_000_001));await expect(manager.readProduct(productId,'large.txt')).rejects.toThrow(/2000000-byte read limit/);});
 it('rejects binary source, path escape and a repository removed from the Owner envelope',async()=>{
  commitFile('binary.dat',Buffer.from([0,255,1,2]));await expect(manager.readProduct(productId,'binary.dat')).rejects.toThrow(/not a UTF-8 text file/);await expect(manager.readProduct(productId,'../outside')).rejects.toThrow(/repository-relative/);
  store.update('policy',store.policy.id,{allowedRepositories:[]});await expect(manager.readProduct(productId,'binary.dat')).rejects.toThrow(/Owner envelope/);
 });
});
