import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
export const toolsPath = `${process.execPath.slice(0,process.execPath.lastIndexOf('/'))}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
export function brokerEnvironment(): NodeJS.ProcessEnv { return {HOME: homedir(), PATH: toolsPath, LANG:'en_US.UTF-8', LC_ALL:'en_US.UTF-8', GIT_TERMINAL_PROMPT:'0', GCM_INTERACTIVE:'never', GH_PROMPT_DISABLED:'1', GIT_PAGER:'cat', PAGER:'cat', GIT_CONFIG_NOSYSTEM:'1'}; }
export const redact = (text: string) => text.replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{10,})\b/g,'[REDACTED]').replace(/(authorization:\s*(?:bearer|basic)\s+)\S+/ig,'$1[REDACTED]');
export interface ProcessResult {code:number; stdout:string; stderr:string; stdoutTruncated?:boolean; stderrTruncated?:boolean; stdoutCharacters?:number; stderrCharacters?:number}
export async function runProcess(file: string, args: string[], options: {cwd?:string; env?:NodeJS.ProcessEnv; timeoutMs?:number; signal?:AbortSignal; input?:string; maxOutput?:number} = {}):Promise<ProcessResult> {
 return new Promise((resolve,reject)=> {
  const child=spawn(file,args,{cwd:options.cwd,env:options.env??brokerEnvironment(),stdio:['pipe','pipe','pipe'],detached:true}); let stdout='',stderr='',settled=false,stdoutCharacters=0,stderrCharacters=0; const maximum=Math.max(1,Math.floor(options.maxOutput??120_000));
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',(chunk:string)=>{stdoutCharacters+=chunk.length;stdout=(stdout+chunk).slice(-maximum);}); child.stderr.on('data',(chunk:string)=>{stderrCharacters+=chunk.length;stderr=(stderr+chunk).slice(-maximum);});
  const kill=()=>{try{process.kill(-child.pid!,'SIGTERM');}catch{/* Process already absent. */} const t=setTimeout(()=>{try{process.kill(-child.pid!,'SIGKILL');}catch{/* Process already absent. */}},1000);t.unref();};
  const timer=setTimeout(kill,options.timeoutMs??60_000); const abort=()=>kill(); options.signal?.addEventListener('abort',abort,{once:true}); if(options.signal?.aborted)kill();
  child.on('error',err=>{if(!settled){settled=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);reject(err);}});
  child.on('close',(code,signal)=>{if(!settled){settled=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);resolve({code:code??(signal?128:1),stdout:redact(stdout),stderr:redact(stderr),stdoutCharacters,stderrCharacters,stdoutTruncated:stdoutCharacters>maximum,stderrTruncated:stderrCharacters>maximum});}});
  child.stdin.end(options.input);
 });
}
export async function checked(file:string,args:string[],options:Parameters<typeof runProcess>[2]={}) {const r=await runProcess(file,args,options);if(r.code!==0)throw new Error(`${file} ${args.slice(0,3).join(' ')} failed (${r.code}): ${r.stderr.slice(-3000)||r.stdout.slice(-3000)}`);if(r.stdoutTruncated)throw new Error(`${file} ${args.slice(0,3).join(' ')} stdout truncated: ${r.stdoutCharacters} characters exceeded the ${options.maxOutput??120_000}-character capture limit. No complete output is available; use bounded source capture and explicit pages.`);return r.stdout.trim();}
