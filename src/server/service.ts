import { existsSync, readFileSync, mkdirSync, openSync, closeSync, unlinkSync, symlinkSync, readlinkSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { sourceRoot, ensureDataRoot, readDiscovery, writePrivate } from './paths.js';
import { runProcess, brokerEnvironment } from '../tools/process.js';
const label=(dataRoot:string)=>`com.opencorp.company${dataRoot===join(homedir(),'.local/share/opencorp')?'':'.'+createHash('sha256').update(dataRoot).digest('hex').slice(0,10)}`;
const plistPath=(dataRoot:string)=>join(homedir(),'Library/LaunchAgents',`${label(dataRoot)}.plist`);
const xml=(v:string)=>v.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const nodePath=()=>{if(!process.version.startsWith('v24.20.0'))throw new Error(`OpenCorp requires Node 24.20.0; current ${process.version}. Use mise exec node@24.20.0.`);return process.execPath;};
async function healthy(dataRoot:string) {const d=readDiscovery(dataRoot);if(!d)return false;try{const r=await fetch(`${d.url}/health`,{signal:AbortSignal.timeout(1000)}); const h=await r.json() as {application?:string;pid?:number};return r.ok&&h.application==='OpenCorp'&&h.pid===d.pid;}catch{return false;}}
const delay=(milliseconds:number)=>new Promise<void>(resolve=>setTimeout(resolve,milliseconds));
type Registration={state:'registered'|'absent'|'unknown';pid?:number;detail:string};
async function registration(dataRoot:string):Promise<Registration>{
 try{
  const result=await runProcess('/bin/launchctl',['print',`gui/${process.getuid!()}/${label(dataRoot)}`],{timeoutMs:3000});
  if(result.code===0){const pid=result.stdout.match(/^\s*pid\s*=\s*(\d+)\s*$/m);return {state:'registered',pid:pid?Number(pid[1]):undefined,detail:result.stdout};}
  const detail=result.stderr||result.stdout;
  // A failed print is not generally proof of absence. This is launchctl's
  // observed "service not found" result for the exact requested label.
  if(result.code===113&&detail.includes(`Could not find service "${label(dataRoot)}"`))return {state:'absent',detail};
  return {state:'unknown',detail:`launchctl print exited ${result.code}: ${detail}`};
 }catch(error){return {state:'unknown',detail:String(error)};}
}
async function waitForRemoval(dataRoot:string){
 const deadline=Date.now()+10000;let observed:Registration;
 do{observed=await registration(dataRoot);if(observed.state==='absent')return;await delay(200);}while(Date.now()<deadline);
 throw new Error(`LaunchAgent removal was not confirmed; no replacement was bootstrapped. ${observed.detail}`);
}
async function waitForInstalledHealth(dataRoot:string){
 const deadline=Date.now()+30000;let observed:Registration;
 do{
  observed=await registration(dataRoot);
  const discovery=readDiscovery(dataRoot);
  if(observed.state==='registered'&&observed.pid&&observed.pid===discovery?.pid&&await healthy(dataRoot))return serviceStatus(dataRoot);
  await delay(200);
 }while(Date.now()<deadline);
 throw new Error(`LaunchAgent did not become healthy with its registered PID; no duplicate bootstrap was attempted. Inspect ${join(dataRoot,'logs/service.log')}. ${observed.state==='unknown'?observed.detail:`Registration: ${observed.state}`}`);
}
async function bootstrapService(dataRoot:string){
 for(let attempt=0;attempt<2;attempt++){
  const result=await runProcess('/bin/launchctl',['bootstrap',`gui/${process.getuid!()}`,plistPath(dataRoot)],{timeoutMs:10000}).catch(error=>({code:-1,stdout:'',stderr:String(error)}));
  if(result.code===0)return waitForInstalledHealth(dataRoot);
  const observed=await registration(dataRoot);
  if(observed.state==='registered')return waitForInstalledHealth(dataRoot);
  if(observed.state==='unknown')throw new Error(`Bootstrap outcome is uncertain; no retry attempted. ${result.stderr} ${observed.detail}`);
  if(attempt===1)throw new Error(`LaunchAgent bootstrap failed after one retry with confirmed absence: ${result.stderr||result.stdout}`);
  // bootout can finish before launchd has released every registration resource.
  // Recheck after backoff: another installer may have registered the job meanwhile.
  await delay(1000);
  const retryState=await registration(dataRoot);
  if(retryState.state==='registered')return waitForInstalledHealth(dataRoot);
  if(retryState.state!=='absent')throw new Error(`Bootstrap outcome is uncertain; no retry attempted. ${retryState.detail}`);
 }
 throw new Error('LaunchAgent bootstrap did not complete.');
}
export async function ensureDaemon(dataRoot:string) {
 ensureDataRoot(dataRoot); if(await healthy(dataRoot))return readDiscovery(dataRoot)!;
 const main=join(sourceRoot,'dist/server/main.js');if(!existsSync(main))throw new Error('Run npm run build before starting OpenCorp.');
 const out=openSync(join(dataRoot,'logs/daemon.log'),'a',0o600); const child=spawn(nodePath(),[main],{cwd:sourceRoot,env:{...brokerEnvironment(),OPENCORP_DATA_DIR:dataRoot},stdio:['ignore',out,out],detached:true}); child.unref();closeSync(out);
 for(let i=0;i<100;i++){if(await healthy(dataRoot))return readDiscovery(dataRoot)!;await new Promise(r=>setTimeout(r,100));} throw new Error(`Daemon did not become healthy. See ${join(dataRoot,'logs/daemon.log')}`);
}
export async function serviceStatus(dataRoot:string) {const installed=existsSync(plistPath(dataRoot));const state=installed?await runProcess('/bin/launchctl',['print',`gui/${process.getuid!()}/${label(dataRoot)}`],{timeoutMs:3000}):null;return {installed,running:await healthy(dataRoot),label:label(dataRoot),path:plistPath(dataRoot),discovery:readDiscovery(dataRoot),launchd:state?.stdout.slice(0,5000)??null};}
export async function serviceInstall(dataRoot:string) {
 if(process.platform!=='darwin')throw new Error('User service installation requires macOS.');ensureDataRoot(dataRoot);mkdirSync(join(homedir(),'Library/LaunchAgents'),{recursive:true});
 const bin=join(homedir(),'.local/bin/opencorp');mkdirSync(join(homedir(),'.local/bin'),{recursive:true});
 if(existsSync(bin)){if(!lstatSync(bin).isSymbolicLink()||readlinkSync(bin)!==join(sourceRoot,'bin/opencorp'))throw new Error(`Preserved existing ${bin}; choose another executable path before installation.`);}else symlinkSync(join(sourceRoot,'bin/opencorp'),bin);
 const main=join(sourceRoot,'dist/server/main.js');if(!existsSync(main))throw new Error('Production build missing. Run npm run build.');
 const body=`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(label(dataRoot))}</string><key>ProgramArguments</key><array><string>${xml(nodePath())}</string><string>${xml(main)}</string></array><key>WorkingDirectory</key><string>${xml(sourceRoot)}</string><key>EnvironmentVariables</key><dict><key>OPENCORP_DATA_DIR</key><string>${xml(dataRoot)}</string><key>PATH</key><string>${xml(brokerEnvironment().PATH!)}</string><key>HOME</key><string>${xml(homedir())}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>20</integer><key>ExitTimeOut</key><integer>8</integer><key>StandardOutPath</key><string>${xml(join(dataRoot,'logs/service.log'))}</string><key>StandardErrorPath</key><string>${xml(join(dataRoot,'logs/service.log'))}</string></dict></plist>\n`;
 const old=await registration(dataRoot);
 if(old.state==='unknown')throw new Error(`Cannot establish existing LaunchAgent registration; replacement was not dispatched. ${old.detail}`);
 if(old.state==='registered'){await runProcess('/bin/launchctl',['bootout',`gui/${process.getuid!()}/${label(dataRoot)}`],{timeoutMs:10000}).catch(()=>{});await waitForRemoval(dataRoot);}
 if(await healthy(dataRoot)){const d=readDiscovery(dataRoot)!;try{process.kill(d.pid,'SIGTERM');}catch{/* Process already absent. */}const deadline=Date.now()+10000;while(await healthy(dataRoot)){if(Date.now()>=deadline)throw new Error(`Previous OpenCorp daemon is still healthy; no replacement was bootstrapped. Inspect ${join(dataRoot,'logs/service.log')}`);await delay(100);}}
 writePrivate(plistPath(dataRoot),body);
 return bootstrapService(dataRoot);
}
export async function serviceUninstall(dataRoot:string) {
 if(await healthy(dataRoot)){const d=readDiscovery(dataRoot)!;const token=readFileSync(join(dataRoot,'owner-token'),'utf8').trim();await fetch(`${d.url}/api/v1/control`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({action:'stop'}),signal:AbortSignal.timeout(8000)});}
 await runProcess('/bin/launchctl',['bootout',`gui/${process.getuid!()}/${label(dataRoot)}`]); if(existsSync(plistPath(dataRoot)))unlinkSync(plistPath(dataRoot));
 const bin=join(homedir(),'.local/bin/opencorp');if(existsSync(bin)&&lstatSync(bin).isSymbolicLink()&&readlinkSync(bin)===join(sourceRoot,'bin/opencorp'))unlinkSync(bin);
 if(await healthy(dataRoot)){try{process.kill(readDiscovery(dataRoot)!.pid,'SIGTERM');}catch{/* Process already absent. */}}
 return {installed:false,dataRetained:dataRoot};
}
