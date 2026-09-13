import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, renameSync, lstatSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { executeSandboxed } from '../runtime/tool-process.js';
import { rubyArtifacts } from './dependencies.js';
import { redact } from './process.js';

const hash=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex');
export function rubyMetadataPath(method:string|undefined,path:string,headers:Record<string,unknown>={}):string {
 if(method!=='GET'||headers.authorization||headers['proxy-authorization']||headers.cookie||!/^\/(?:versions|info\/[A-Za-z0-9][A-Za-z0-9._-]{0,99})$/.test(path))throw new Error('Only unauthenticated RubyGems compact-index GET paths are permitted');
 return path;
}
/** One operation, fixed public origin, no forwarding of worker headers or URLs. */
export async function rubyMetadataProxy(signal:AbortSignal){
 const cache=new Map<string,Promise<Buffer>>();let requests=0,bytes=0;const observations:{path:string;bytes:number;sha256:string}[]=[];
 const server=createServer(async(req,res)=>{try{
  const path=rubyMetadataPath(req.method,req.url??'',req.headers);if(++requests>256)throw new Error('Metadata request bound exceeded');signal.throwIfAborted();
  let pending=cache.get(path);if(!pending){pending=(async()=>{
   const response=await fetch('https://rubygems.org'+path,{redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(30000)])});
   if(response.status!==200||!response.body)throw new Error('Public RubyGems metadata unavailable');
   const chunks:Buffer[]=[];let size=0;for await(const chunk of response.body){size+=chunk.length;bytes+=chunk.length;if(size>(path==='/versions'?32000000:4000000)||bytes>64000000)throw new Error('Metadata byte bound exceeded');chunks.push(Buffer.from(chunk));}
   const data=Buffer.concat(chunks);observations.push({path,bytes:size,sha256:hash(data)});return data;
  })();cache.set(path,pending);}const data=await pending;res.writeHead(200,{'content-type':'text/plain'}).end(data);
 }catch{res.writeHead(403).end('RubyGems metadata request denied or unavailable');}});
 server.on('connect',(_req,socket)=>socket.destroy());
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as {port:number}).port;
 const close=()=>{server.closeAllConnections();server.close();};signal.addEventListener('abort',close,{once:true});
 return {port,observations,close:()=>{signal.removeEventListener('abort',close);close();}};
}

export async function resolveRubyDependencies(options:{workspace:string;dataRoot:string;gems:unknown;rationale:string;runId:string;assertCurrent:()=>Promise<void>;signal:AbortSignal}){
 const {workspace}=options;const files=['Gemfile','Gemfile.lock'];
 for(const name of files)if(!lstatSync(join(workspace,name)).isFile()||lstatSync(join(workspace,name)).size>2000000)throw new Error('Dependency files must be ordinary files');
 const original=files.map(name=>readFileSync(join(workspace,name))),lock=original[1]!.toString('utf8');rubyArtifacts(lock);
 const names=new Set([...lock.matchAll(/^ {4}([A-Za-z0-9][A-Za-z0-9._-]*) \(/gm)].map(m=>m[1]));
 const gems=options.gems;if(!Array.isArray(gems)||!gems.length||gems.length>40||gems.some(g=>typeof g!=='string'||!names.has(g))||new Set(gems).size!==gems.length)throw new Error('Select 1–40 unique gem names already present in this project lockfile');
 if(typeof options.rationale!=='string'||!options.rationale.trim()||options.rationale.length>2000)throw new Error('A bounded dependency-update rationale is required');
 await options.assertCurrent();options.signal.throwIfAborted();
 const parent=join(options.dataRoot,'runtime/ruby-resolutions');mkdirSync(parent,{recursive:true,mode:0o700});const root=mkdtempSync(join(parent,'resolve-')),scratch=join(root,'workspace');mkdirSync(scratch,{mode:0o700});files.forEach((name,i)=>writeFileSync(join(scratch,name),original[i]!,{mode:0o600}));
 const receiptPath=join(root,'receipt.json'),receipt:any={runId:options.runId,gems,rationale:options.rationale,originalHashes:original.map(hash),status:'started',installed:false,startedAt:new Date().toISOString(),workspace};
 const save=()=>writeFileSync(receiptPath,JSON.stringify(receipt,null,2),{mode:0o600});save();
 const controller=new AbortController(),signal=AbortSignal.any([options.signal,controller.signal]),timer=setTimeout(()=>controller.abort(),120000);let proxy:Awaited<ReturnType<typeof rubyMetadataProxy>>|undefined;
 try{
  proxy=await rubyMetadataProxy(signal);const ruby=join(homedir(),'.local/share/mise/installs/ruby/3.4.8');
  const command=['ruby','-rbundler','-rbundler/cli','-e',`Bundler.settings.set_command_option('mirror.https://rubygems.org/', 'http://127.0.0.1:${proxy.port}/'); Bundler::CLI.start(ARGV)`,'--','lock','--update',...gems,'--conservative','--add-checksums'];receipt.command=command;save();
  const result=await executeSandboxed({workspace:scratch,dataRoot:options.dataRoot,runId:'resolve-'+randomUUID(),gatewayPort:proxy.port,signal,timeoutMs:120000,command,toolEnvironment:{binPaths:[join(ruby,'bin')],readPaths:[ruby],writePaths:[],variables:{BUNDLE_IGNORE_CONFIG:'true',BUNDLE_FROZEN:'false',BUNDLE_DISABLE_SHARED_GEMS:'true'}}});
  receipt.exitCode=result.code;receipt.diagnostics=redact(result.stdout+'\n'+result.stderr).slice(-4000);receipt.metadata=proxy.observations;signal.throwIfAborted();
  if(result.code!==0)throw new Error('Bundler could not resolve the selected update; original files preserved');
  if(!readFileSync(join(scratch,'Gemfile')).equals(original[0]!))throw new Error('Resolver changed its Gemfile; original files preserved');
  const outputPath=join(scratch,'Gemfile.lock');if(!lstatSync(outputPath).isFile())throw new Error('Resolved lock must be an ordinary file');const output=readFileSync(outputPath);if(output.length>2000000)throw new Error('Resolved lock exceeds bound');rubyArtifacts(output.toString('utf8'));
  await options.assertCurrent();signal.throwIfAborted();
  for(const [i,name]of files.entries())if(!lstatSync(join(workspace,name)).isFile()||!readFileSync(join(workspace,name)).equals(original[i]!))throw new Error('Dependency source changed during resolution; original files preserved');
  receipt.resolvedLockHash=hash(output);receipt.status='apply-intent';save();
  const temp=join(workspace,'.opencorp-lock-'+randomUUID());try{writeFileSync(temp,output,{mode:lstatSync(join(workspace,'Gemfile.lock')).mode&0o777,flag:'wx'});renameSync(temp,join(workspace,'Gemfile.lock'));}finally{try{unlinkSync(temp);}catch{/* Already renamed. */}}
  receipt.status='resolved-uncommitted';receipt.completedAt=new Date().toISOString();save();
  return {status:receipt.status,installed:false,receiptPath,gems,originalLockHash:hash(original[1]!),resolvedLockHash:hash(output),guidance:'Inspect the generated Gemfile.lock diff. Commit only intended files with commit_work paths; verify_product must freshly prepare dependencies and pass canonical checks, followed by independent review.'};
 }catch(error){if(receipt.status!=='apply-intent')receipt.status='failed';receipt.failure='Resolution failed or was cancelled; inspect bounded diagnostics. No successful installation or verification is claimed.';save();throw new Error(`Ruby dependency resolution ${receipt.status}; inspect ${receiptPath}: ${error instanceof Error?redact(error.message).slice(0,500):'unknown failure'}\n${receipt.diagnostics??''}`);}
 finally{clearTimeout(timer);controller.abort();proxy?.close();}
}
