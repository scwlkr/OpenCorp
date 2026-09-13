import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { rubyMetadataPath, rubyMetadataProxy, resolveRubyDependencies } from '../src/tools/ruby-resolver.js';
import { executeSandboxed } from '../src/runtime/tool-process.js';
vi.mock('../src/runtime/tool-process.js',()=>({executeSandboxed:vi.fn()}));
let root:string,workspace:string;
const lock=`GEM\n  remote: https://rubygems.org/\n  specs:\n    rack (3.2.1)\n\nDEPENDENCIES\n  rack (~> 3.2)\n\nCHECKSUMS\n  rack (3.2.1) sha256=${'a'.repeat(64)}\n\n`;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'ruby-resolver-'));workspace=join(root,'workspace');mkdirSync(workspace);writeFileSync(join(workspace,'Gemfile'),'source "https://rubygems.org"\ngem "rack", "~> 3.2"\n');writeFileSync(join(workspace,'Gemfile.lock'),lock);writeFileSync(join(workspace,'unrelated.txt'),'retain');vi.mocked(executeSandboxed).mockReset();});
afterEach(()=>{vi.restoreAllMocks();rmSync(root,{recursive:true,force:true});});
const options=()=>({workspace,dataRoot:root,gems:['rack'],rationale:'Fix retained advisory',runId:'fixture-run',assertCurrent:vi.fn(async()=>{}),signal:new AbortController().signal});
it.each(['/info/rack?token=secret','https://evil.invalid/versions','/../versions','/downloads/rack.gem','/info/a%2Fb','/info/../../x'])('rejects nonmetadata path %s',path=>expect(()=>rubyMetadataPath('GET',path)).toThrow());
it('rejects credentials and non-GET methods',()=>{for(const headers of [{authorization:'Bearer secret'},{cookie:'secret'},{'proxy-authorization':'secret'}])expect(()=>rubyMetadataPath('GET','/versions',headers)).toThrow();expect(()=>rubyMetadataPath('POST','/versions')).toThrow();expect(rubyMetadataPath('GET','/info/rack')).toBe('/info/rack');});
const get=(port:number,path:string)=>new Promise<{status:number;body:string}>(resolve=>{const req=request({host:'127.0.0.1',port,path},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode!,body}));});req.end();});
it('fetches only fixed HTTPS metadata without forwarding headers and caches per operation',async()=>{
 const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('public compact metadata'));const p=await rubyMetadataProxy(new AbortController().signal);
 try{expect((await get(p.port,'/info/rack')).status).toBe(200);expect((await get(p.port,'/info/rack')).body).toBe('public compact metadata');expect((await get(p.port,'/downloads/rack.gem')).status).toBe(403);expect(fetcher).toHaveBeenCalledOnce();expect(fetcher).toHaveBeenCalledWith('https://rubygems.org/info/rack',{redirect:'error',signal:expect.any(AbortSignal)});expect(p.observations[0]).toMatchObject({path:'/info/rack',bytes:23});}finally{p.close();}
});
it('keeps original files after a failed resolver and exposes no production environment or network access',async()=>{
 vi.mocked(executeSandboxed).mockResolvedValue({code:1,stdout:'',stderr:'Cannot resolve'});await expect(resolveRubyDependencies(options())).rejects.toThrow('original files preserved');expect(readFileSync(join(workspace,'Gemfile.lock'),'utf8')).toBe(lock);const run=vi.mocked(executeSandboxed).mock.calls[0][0];expect(run.workspace).not.toBe(workspace);expect(run.localTestNetwork).toBeUndefined();expect(run.readPaths).toBeUndefined();expect(run.toolEnvironment?.writePaths).toEqual([]);expect(run.toolEnvironment?.variables).toMatchObject({BUNDLE_FROZEN:'false',BUNDLE_IGNORE_CONFIG:'true'});expect(run.command).toContain('--add-checksums');expect(run.command).toContain('--conservative');
});
it('applies only the resolved lock after fresh authority/source checks, without claiming installed or verified',async()=>{
 const updated=lock.replaceAll('3.2.1','3.2.7');vi.mocked(executeSandboxed).mockImplementation(async run=>{writeFileSync(join(run.workspace,'Gemfile.lock'),updated);writeFileSync(join(run.workspace,'scratch-output'),'untrusted');return{code:0,stdout:'resolved',stderr:''};});const o=options(),before=readFileSync(join(workspace,'Gemfile'));const result=await resolveRubyDependencies(o);expect(result).toMatchObject({status:'resolved-uncommitted',installed:false});expect(o.assertCurrent).toHaveBeenCalledTimes(2);expect(readFileSync(join(workspace,'Gemfile.lock'),'utf8')).toBe(updated);expect(readFileSync(join(workspace,'Gemfile'))).toEqual(before);expect(readFileSync(join(workspace,'unrelated.txt'),'utf8')).toBe('retain');expect(JSON.parse(readFileSync(result.receiptPath,'utf8'))).toMatchObject({runId:'fixture-run',status:'resolved-uncommitted',installed:false});
});
it.each(['source','authority','cancel','invalid-lock'])('preserves original lock on late %s failure',async mode=>{
 const o=options();let calls=0;o.assertCurrent=vi.fn(async()=>{if(++calls===2){if(mode==='authority')throw Error('revoked');if(mode==='source')writeFileSync(join(workspace,'Gemfile'),'actual concurrent edit');}});const controller=new AbortController();o.signal=controller.signal;
 vi.mocked(executeSandboxed).mockImplementation(async run=>{writeFileSync(join(run.workspace,'Gemfile.lock'),mode==='invalid-lock'?lock.replace('https://rubygems.org/','https://evil.invalid/'):lock.replaceAll('3.2.1','3.2.7'));if(mode==='cancel')controller.abort();return{code:0,stdout:'',stderr:''};});await expect(resolveRubyDependencies(o)).rejects.toThrow();expect(readFileSync(join(workspace,'Gemfile.lock'),'utf8')).toBe(lock);
});
it('rejects unknown gems before execution',async()=>{await expect(resolveRubyDependencies({...options(),gems:['not-locked']})).rejects.toThrow('already present');expect(executeSandboxed).not.toHaveBeenCalled();});
