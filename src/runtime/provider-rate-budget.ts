import { ProviderAvailabilityError } from './resource-budget.js';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { DirectFreeProviderName } from './types.js';

const MINUTE=60_000,DAY=86_400_000;
const lockWaitCell=new Int32Array(new SharedArrayBuffer(4));
function wait(ms:number,signal:AbortSignal){return new Promise<void>((resolve,reject)=>{signal.throwIfAborted();const abort=()=>{clearTimeout(timer);reject(signal.reason);};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);signal.addEventListener('abort',abort,{once:true});});}
type PacingProvider=DirectFreeProviderName|'openrouter';
type PacingOptions={rateBudgetPath?:string};
// OpenRouter's shared free-model account ceiling is 20 RPM. Keep two requests of headroom.
// No daily request/token allowance is inferred from account credits or our usage.
const limits={openrouter:{requests:18,tokens:Infinity,dailyRequests:Infinity,dailyTokens:Infinity},zai:{requests:10,tokens:200_000,dailyRequests:500,dailyTokens:Infinity},gemini:{requests:10,tokens:200_000,dailyRequests:500,dailyTokens:Infinity},groq:{requests:30,tokens:8_000,dailyRequests:Infinity,dailyTokens:200_000}};
export function validateEstimatedRequest(provider:PacingProvider,tokens:number){if(!Number.isSafeInteger(tokens)||tokens<1||tokens>limits[provider].tokens)throw new Error(`Estimated request tokens exceed ${provider} local pacing limit (${limits[provider].tokens} per minute); reduce prompt or requested output before retrying`);}
type Entry={at:number;tokens:number;scope?:string};
type HeaderBudget={until:number;remaining:number;kind:'requests'|'tokens'};
type Hold={until:number;scope?:string};
type ZeroUsageBaseline={scope:string;observedAt:number;expiresAt:number;evidenceSha256:string};
type State={version:1;entries:Entry[];headers:HeaderBudget[];holds?:Hold[];zeroUsageBaselines?:ZeroUsageBaseline[]};
const validScope=(scope:unknown)=>scope===undefined||typeof scope==='string'&&/^[a-f0-9]{64}$/.test(scope);
const applicable=(entry:{scope?:string},scope?:string)=>scope===undefined||entry.scope===undefined||entry.scope===scope;
function validBaseline(value:ZeroUsageBaseline){return !!value&&typeof value==='object'&&Object.keys(value).length===4&&Object.keys(value).every(k=>['scope','observedAt','expiresAt','evidenceSha256'].includes(k))&&typeof value.scope==='string'&&validScope(value.scope)&&typeof value.evidenceSha256==='string'&&/^[a-f0-9]{64}$/.test(value.evidenceSha256)&&Number.isSafeInteger(value.observedAt)&&value.observedAt>=30*MINUTE&&value.observedAt<=Date.now()&&Number.isSafeInteger(value.expiresAt)&&value.expiresAt>value.observedAt&&value.expiresAt-value.observedAt<=DAY&&value.expiresAt%1000===0&&new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',hourCycle:'h23',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(value.expiresAt))==='00:00:00';}
/** Conservative local reservations, not provider/account remaining quota. No prompts or credentials are retained. */
export class ProviderRateBudget {
 private streamActive=false;
 private state:State={version:1,entries:[],headers:[]};
 constructor(private readonly provider:PacingProvider,private readonly path?:string){if(path&&!isAbsolute(path))throw new Error('Provider pacing requires an absolute protected state path');}
 private locked<T>(operation:()=>T):T{
  if(!this.path)return operation();
  const directory=dirname(this.path);let fd:number;
  try{mkdirSync(directory,{recursive:true,mode:0o700});const stat=lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o700||process.getuid&&stat.uid!==process.getuid())throw new Error();// Only another process's brief atomic section is retryable. Never unlink or steal its lock.
   const deadline=performance.now()+25;let attempts=0;
   for(;;){try{fd=openSync(`${this.path}.lock`,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);break;}catch(error){const remaining=deadline-performance.now();if((error as NodeJS.ErrnoException).code!=='EEXIST'||remaining<=0||attempts++>=25)throw error;Atomics.wait(lockWaitCell,0,0,Math.min(1,remaining));}}}catch{throw new Error('Protected provider pacing state locked or unavailable; no request dispatched');}
  try{return operation();}finally{closeSync(fd);unlinkSync(`${this.path}.lock`);}
 }
 /** Z.ai's verified GLM-4.7-Flash account permits one active response stream. */
 async acquireStream(signal:AbortSignal):Promise<()=>void>{
  if(this.provider!=='zai')return ()=>{};
  for(;;){
   signal.throwIfAborted();let fd:number|undefined;
   if(this.path){this.locked(()=>{});try{fd=openSync(`${this.path}.active`,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw new Error('Protected provider stream admission unavailable');}}
   else if(!this.streamActive)this.streamActive=true;else{await wait(100,signal);continue;}
   if(this.path&&fd===undefined){await wait(100,signal);continue;}
   let released=false;const release=()=>{if(released)return;released=true;if(fd!==undefined){closeSync(fd);unlinkSync(`${this.path}.active`);}else this.streamActive=false;};
   return release;
  }
 }
 private load(){
  if(!this.path)return;
  try{
   const directory=dirname(this.path);mkdirSync(directory,{recursive:true,mode:0o700});const dir=lstatSync(directory);
   if(!dir.isDirectory()||dir.isSymbolicLink()||(dir.mode&0o777)!==0o700||process.getuid&&dir.uid!==process.getuid())throw new Error();
   let fd:number;try{fd=openSync(this.path,constants.O_RDONLY|constants.O_NOFOLLOW);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
   try{const stat=fstatSync(fd);if(!stat.isFile()||(stat.mode&0o777)!==0o600||stat.size>2_000_000||process.getuid&&stat.uid!==process.getuid())throw new Error();const value=JSON.parse(readFileSync(fd,'utf8'));
    if(value.zeroUsageBaselines!==undefined&&(!Array.isArray(value.zeroUsageBaselines)||value.zeroUsageBaselines.length>1000||value.zeroUsageBaselines.some((baseline:ZeroUsageBaseline)=>!validBaseline(baseline))||new Set(value.zeroUsageBaselines.map((b:ZeroUsageBaseline)=>b.scope)).size!==value.zeroUsageBaselines.length))throw new Error();
    if(value.holds!==undefined&&(!Array.isArray(value.holds)||value.holds.length>1000||value.holds.some((h:Hold)=>!Number.isSafeInteger(h.until)||h.until<0||h.until>Date.now()+DAY||!validScope(h.scope))))throw new Error();
    if(value.version!==1||!Array.isArray(value.entries)||!Array.isArray(value.headers)||value.entries.length>50_000||value.headers.length>1000||value.entries.some((e:Entry)=>!Number.isSafeInteger(e.at)||!Number.isSafeInteger(e.tokens)||e.tokens<1||e.at<0||e.at>Date.now()+DAY||!validScope(e.scope))||value.headers.some((h:HeaderBudget)=>!Number.isSafeInteger(h.until)||h.until>Date.now()+DAY||!Number.isSafeInteger(h.remaining)||h.remaining<0||!['requests','tokens'].includes(h.kind)))throw new Error();this.state=value;
   }finally{closeSync(fd);}
  }catch{throw new Error('Protected provider pacing state unavailable');}
 }
 private save(){if(!this.path)return;try{const temporary=`${this.path}.${randomUUID()}.tmp`;writeFileSync(temporary,JSON.stringify(this.state),{mode:0o600,flag:'wx'});renameSync(temporary,this.path);}catch{throw new Error('Protected provider pacing state could not be retained');}}
 /** Explicit parent-only dashboard observation, not account remaining quota or Owner testimony. No automatic renewal. */
 recordZeroUsageBaseline(value:ZeroUsageBaseline){
  if(this.provider!=='gemini'||!validBaseline(value)||value.expiresAt<=Date.now())throw new Error('Invalid Gemini dashboard zero-usage baseline');
  this.locked(()=>{this.load();if(this.state.zeroUsageBaselines?.some(b=>b.scope===value.scope&&b.expiresAt>Date.now()))throw new Error('Active Gemini baseline cannot be replaced');this.state.zeroUsageBaselines=[...(this.state.zeroUsageBaselines??[]).filter(b=>b.expiresAt>Date.now()),{...value}];this.save();});
  return {...value,cutoff:value.observedAt-30*MINUTE,basis:'provider-dashboard-observed-estimate' as const};
 }
 private applies(entry:Entry,scope:string|undefined,now:number){
  if(!applicable(entry,scope))return false;
  if(this.provider!=='gemini'||entry.scope!==undefined||scope===undefined)return true;
  const baseline=this.state.zeroUsageBaselines?.find(b=>b.scope===scope&&b.expiresAt>now);
  return !baseline||entry.at>=baseline.observedAt-30*MINUTE;
 }
 private dailyWait(tokens:number,now:number,scope?:string):string|undefined {
  const limit=limits[this.provider],entries=this.state.entries.filter(e=>e.at>now-DAY&&this.applies(e,scope,now)).sort((a,b)=>a.at-b.at);let count=entries.length,total=entries.reduce((n,e)=>n+e.tokens,0);
  if(count<limit.dailyRequests&&total+tokens<=limit.dailyTokens)return;
  for(const entry of entries){count--;total-=entry.tokens;if(count<limit.dailyRequests&&total+tokens<=limit.dailyTokens)return new Date(entry.at+DAY).toISOString();}
 }
 /** Earliest release for one minimum request; actual prompt reservations still enforce their full estimate. */
 dailyAvailability(scope?:string):string|undefined {this.assertScope(scope);return this.locked(()=>{this.load();return this.dailyWait(1,Date.now(),scope);});}
 private assertScope(scope?:string){if(!validScope(scope)||scope!==undefined&&this.provider!=='gemini')throw new Error('Invalid provider pacing scope');}
 cooldown(scope?:string):string|undefined {this.assertScope(scope);return this.locked(()=>{this.load();const until=Math.max(0,...(this.state.holds??[]).filter(h=>applicable(h,scope)).map(h=>h.until));return until>Date.now()?new Date(until).toISOString():undefined;});}
 hold(until:number,scope?:string){this.assertScope(scope);if(!Number.isSafeInteger(until)||until<=Date.now()||until>Date.now()+DAY)throw new Error('Invalid provider cooldown');this.locked(()=>{this.load();this.state.holds=(this.state.holds??[]).filter(h=>h.until>Date.now());const prior=this.state.holds.find(h=>h.scope===scope);if(prior)prior.until=Math.max(prior.until,until);else this.state.holds.push({until,...(scope?{scope}:{})});this.save();});}
 async reserve(tokens:number,signal:AbortSignal,scope?:string){
  this.assertScope(scope);
  const limit=limits[this.provider];validateEstimatedRequest(this.provider,tokens);
  for(;;){
   signal.throwIfAborted();const result=this.locked(()=>{this.load();const now=Date.now();this.state.entries=this.state.entries.filter(e=>e.at>now-DAY);this.state.headers=this.state.headers.filter(h=>h.until>now);
   const entries=this.state.entries,minute=entries.filter(e=>e.at>now-MINUTE&&this.applies(e,scope,now)),sum=(values:Entry[])=>values.reduce((n,e)=>n+e.tokens,0);
   const retryAt=this.dailyWait(tokens,now,scope);if(retryAt)throw new ProviderAvailabilityError(this.provider,retryAt,'Local rolling 24-hour provider reservation budget exhausted; this is not account remaining quota',scope);
   const constrained=this.state.headers.filter(h=>h.remaining<(h.kind==='requests'?1:tokens));
   if(minute.length<limit.requests&&sum(minute)+tokens<=limit.tokens&&!constrained.length){
    const reservation={at:now,tokens,...(scope?{scope}:{})};entries.push(reservation);for(const h of this.state.headers)h.remaining=Math.max(0,h.remaining-(h.kind==='requests'?1:tokens));this.save();return reservation;
   }
   const next=Math.min(...(minute.length?[minute[0]!.at+MINUTE]:[]),...constrained.map(h=>h.until));
   return Math.max(1,next-now);});if(typeof result!=='number')return result;
   await wait(result,signal);
  }
 }
 /** Only tightening observations. Groq request headers describe RPD and token headers TPM. */
 observe(headers:Record<string,unknown>={},reservation?:Entry){
  if(this.provider!=='groq')return;
  this.locked(()=>{this.load();const now=Date.now();this.state.headers=this.state.headers.filter(h=>h.until>now);
  for(const kind of ['requests','tokens'] as const){const raw=headers[`x-ratelimit-remaining-${kind}`],reset=headers[`x-ratelimit-reset-${kind}`];if(typeof raw!=='string'||!/^\d{1,12}$/.test(raw))continue;
   const match=typeof reset==='string'?/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(reset):null;const parsed=match?Math.ceil((Number(match[1]??0)*3600+Number(match[2]??0)*60+Number(match[3]??0))*1000):0;
   // Absent reset is a conservative local hold, not an inferred provider reset.
   const ms=parsed>0&&parsed<=DAY?parsed:kind==='tokens'?MINUTE:DAY;
   const newer=reservation?this.state.entries.filter(e=>e.at>=reservation.at):[];const pending=kind==='requests'?Math.max(0,newer.length-(reservation?1:0)):Math.max(0,newer.reduce((n,e)=>n+e.tokens,0)-(reservation?.tokens??0));
   this.state.headers.push({kind,remaining:Math.max(0,Number(raw)-pending),until:now+ms});
  }
  // Bound repeated provider observations without relaxing any active constraint.
  this.state.headers=this.state.headers.filter((h,i,all)=>!all.some((other,j)=>j!==i&&other.kind===h.kind&&other.remaining<=h.remaining&&other.until>=h.until&&(other.remaining<h.remaining||other.until>h.until||j<i)));
  this.save();});
 }
}
const optionBudgets=new WeakMap<PacingOptions,ProviderRateBudget>(),pathBudgets=new Map<string,ProviderRateBudget>();
export function providerRateBudget(provider:PacingProvider,options:PacingOptions){
 const path=options.rateBudgetPath,key=`${provider}:${path}`;let budget=path?pathBudgets.get(key):optionBudgets.get(options);if(!budget){budget=new ProviderRateBudget(provider,path);if(path)pathBudgets.set(key,budget);else optionBudgets.set(options,budget);}return budget;
}
/** UTF-8 bytes / 3 plus full requested output: deliberately conservative, still an estimate. */
export function estimatedRequestTokens(body:Record<string,unknown>){return Math.ceil(Buffer.byteLength(JSON.stringify({messages:body.messages,tools:body.tools,tool_choice:body.tool_choice}),'utf8')/3)+Number(body.max_tokens);}
