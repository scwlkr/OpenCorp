import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { estimatedRequestTokens, ProviderRateBudget, providerRateBudget } from '../src/runtime/provider-rate-budget.js';
import type { DirectFreeOptions } from '../src/runtime/types.js';
const roots:string[]=[];
const signal=()=>new AbortController().signal;
afterEach(()=>{vi.useRealTimers();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function path(){const root=mkdtempSync(join(tmpdir(),'provider-pacing-'));roots.push(root);return join(root,'private','gemini.json');}
it('shares options and protected-path reservations across adapters without credentials',()=>{
 const options:DirectFreeOptions={modelIds:[],readCredentials:vi.fn()};expect(providerRateBudget('gemini',options)).toBe(providerRateBudget('gemini',options));const rateBudgetPath=path();expect(providerRateBudget('gemini',{...options,rateBudgetPath})).toBe(providerRateBudget('gemini',{...options,rateBudgetPath}));expect(options.readCredentials).not.toHaveBeenCalled();
});
it('reserves atomically across concurrent workers and waits for the rolling minute',async()=>{
 vi.useFakeTimers();const budget=new ProviderRateBudget('gemini');await Promise.all(Array.from({length:10},()=>budget.reserve(1,signal())));let done=false;const pending=budget.reserve(1,signal()).then(()=>{done=true;});await vi.advanceTimersByTimeAsync(59_999);expect(done).toBe(false);await vi.advanceTimersByTimeAsync(1);await pending;expect(done).toBe(true);
});
it('token reservations pace before RPM and aborted wait makes no reservation',async()=>{
 vi.useFakeTimers();const file=path(),budget=new ProviderRateBudget('gemini',file);await budget.reserve(150_000,signal());const controller=new AbortController(),pending=budget.reserve(60_000,controller.signal);const rejected=expect(pending).rejects.toThrow();controller.abort();await rejected;expect(JSON.parse(readFileSync(file,'utf8')).entries).toHaveLength(1);
});
it('persists a full minute across a new instance/restart with private files',async()=>{
 vi.useFakeTimers();const file=path();await Promise.all(Array.from({length:10},()=>new ProviderRateBudget('gemini',file).reserve(20,signal())));expect(statSync(file).mode&0o777).toBe(0o600);expect(statSync(join(file,'..')).mode&0o777).toBe(0o700);let done=false;const pending=new ProviderRateBudget('gemini',file).reserve(20,signal()).then(()=>{done=true;});await vi.advanceTimersByTimeAsync(59_999);expect(done).toBe(false);await vi.advanceTimersByTimeAsync(1);await pending;
});
it('rejects impossible Groq prompt plus output before waiting',async()=>{
 const budget=new ProviderRateBudget('groq'),tokens=estimatedRequestTokens({messages:[{role:'user',content:'x'.repeat(17_000*4)}],max_tokens:4096});expect(tokens).toBeGreaterThan(8_000);await expect(budget.reserve(tokens,signal())).rejects.toThrow('Estimated request tokens exceed');
});
it('keeps rolling daily local estimates across restart without inventing account quota',async()=>{
 vi.useFakeTimers();const file=path(),budget=new ProviderRateBudget('gemini',file);await budget.reserve(1,signal());writeFileSync(file,JSON.stringify({version:1,entries:Array.from({length:500},()=>({at:Date.now()-120_000,tokens:1})),headers:[]}));await expect(new ProviderRateBudget('gemini',file).reserve(1,signal())).rejects.toThrow('not account remaining quota');await vi.advanceTimersByTimeAsync(86_400_000);await expect(budget.reserve(1,signal())).resolves.toBeDefined();
});
it('honors Groq remaining/reset headers without relaxing existing reservations',async()=>{
 vi.useFakeTimers();const budget=new ProviderRateBudget('groq');budget.observe({'x-ratelimit-remaining-tokens':'5','x-ratelimit-reset-tokens':'2s'});let done=false;const pending=budget.reserve(10,signal()).then(()=>{done=true;});await vi.advanceTimersByTimeAsync(1999);expect(done).toBe(false);await vi.advanceTimersByTimeAsync(1);await pending;
 budget.observe({'x-ratelimit-remaining-requests':'0','x-ratelimit-reset-requests':'1m'});budget.observe({'x-ratelimit-remaining-requests':'1000','x-ratelimit-reset-requests':'1s'});const controller=new AbortController(),blocked=expect(budget.reserve(1,controller.signal)).rejects.toThrow();controller.abort();await blocked;
});
it('subtracts other in-flight reservations from newly observed provider remaining',async()=>{
 vi.useFakeTimers();const budget=new ProviderRateBudget('groq'),first=await budget.reserve(100,signal());await budget.reserve(100,signal());budget.observe({'x-ratelimit-remaining-tokens':'150','x-ratelimit-reset-tokens':'1s'},first);let done=false;const pending=budget.reserve(100,signal()).then(()=>{done=true;});await vi.advanceTimersByTimeAsync(999);expect(done).toBe(false);await vi.advanceTimersByTimeAsync(1);await pending;
});
it('fails closed for corrupt or symlink pacing state',async()=>{
 const file=path(),budget=new ProviderRateBudget('gemini',file);await budget.reserve(1,signal());writeFileSync(file,'{}');await expect(budget.reserve(1,signal())).rejects.toThrow('state unavailable');rmSync(file);symlinkSync('/dev/null',file);await expect(budget.reserve(1,signal())).rejects.toThrow('state unavailable');
});
it('does not discard zero remaining when reset metadata is absent',async()=>{
 vi.useFakeTimers();const budget=new ProviderRateBudget('groq');budget.observe({'x-ratelimit-remaining-tokens':'0'});let done=false;const pending=budget.reserve(1,signal()).then(()=>{done=true;});await vi.advanceTimersByTimeAsync(59_999);expect(done).toBe(false);await vi.advanceTimersByTimeAsync(1);await pending;
});
it('fails closed on a reservation lock held by another process without losing persisted entries',async()=>{
 const {spawn}=await import('node:child_process');const file=path(),budget=new ProviderRateBudget('gemini',file);await budget.reserve(1,signal());
 const child=spawn(process.execPath,['--input-type=module','-e',`import fs from 'node:fs';fs.writeFileSync(process.argv[1]+'.lock','',{flag:'wx',mode:0o600});process.send('locked');process.on('message',()=>{fs.unlinkSync(process.argv[1]+'.lock');process.exit(0);});`,file],{stdio:['ignore','ignore','ignore','ipc']});
 try{await new Promise<void>((resolve,reject)=>{child.once('message',()=>resolve());child.once('error',reject);});await expect(new ProviderRateBudget('gemini',file).reserve(1,signal())).rejects.toThrow('locked');expect(JSON.parse(readFileSync(file,'utf8')).entries).toHaveLength(1);}finally{await new Promise<void>(resolve=>{child.once('exit',()=>resolve());child.send('release');});}
 await budget.reserve(1,signal());expect(JSON.parse(readFileSync(file,'utf8')).entries).toHaveLength(2);
});
it('enforces Groq rolling daily estimated tokens independently of minute resets',async()=>{
 vi.useFakeTimers();const budget=new ProviderRateBudget('groq');for(let i=0;i<25;i++){await budget.reserve(8_000,signal());await vi.advanceTimersByTimeAsync(60_000);}await expect(budget.reserve(1,signal())).rejects.toThrow('rolling 24-hour');
});
it('shares Z.ai stream admission across separate protected-path instances and aborts a waiter',async()=>{
 vi.useFakeTimers();const file=path(),first=new ProviderRateBudget('zai',file),second=new ProviderRateBudget('zai',file),release=await first.acquireStream(signal());const controller=new AbortController(),pending=second.acquireStream(controller.signal),rejected=expect(pending).rejects.toThrow();await vi.advanceTimersByTimeAsync(200);expect(statSync(`${file}.active`).mode&0o777).toBe(0o600);controller.abort();await rejected;release();const released=await second.acquireStream(signal());released();
});

it('reports exact daily release without reserving and recovers across restart',async()=>{
 vi.useFakeTimers();const file=path(),budget=new ProviderRateBudget('gemini',file);await budget.reserve(1,signal());const at=Date.now()-120_000;writeFileSync(file,JSON.stringify({version:1,entries:Array.from({length:500},()=>({at,tokens:1})),headers:[]}));
 const before=readFileSync(file,'utf8');expect(new ProviderRateBudget('gemini',file).dailyAvailability()).toBe(new Date(at+86_400_000).toISOString());expect(readFileSync(file,'utf8')).toBe(before);await expect(budget.reserve(1,signal())).rejects.toMatchObject({name:'ProviderAvailabilityError',retryAt:new Date(at+86_400_000).toISOString()});await vi.advanceTimersByTimeAsync(86_280_000);expect(budget.dailyAvailability()).toBeUndefined();
});
it('daily token retry releases enough retained estimates for the actual request',async()=>{
 vi.useFakeTimers();const file=path(),budget=new ProviderRateBudget('groq',file);await budget.reserve(1,signal());const at=Date.now()-120_000;writeFileSync(file,JSON.stringify({version:1,entries:[{at,tokens:1},{at:at+1000,tokens:199999}],headers:[]}));expect(budget.dailyAvailability()).toBe(new Date(at+86_400_000).toISOString());await expect(budget.reserve(2000,signal())).rejects.toMatchObject({retryAt:new Date(at+1000+86_400_000).toISOString()});
});

it('OpenRouter imposes only a shared 18-RPM reservation ceiling, not an invented daily quota',async()=>{
 vi.useFakeTimers();const file=path(),budget=new ProviderRateBudget('openrouter',file);await budget.reserve(1,signal());
 writeFileSync(file,JSON.stringify({version:1,entries:Array.from({length:1000},()=>({at:Date.now()-120_000,tokens:1})),headers:[]}));
 expect(new ProviderRateBudget('openrouter',file).dailyAvailability()).toBeUndefined();await expect(budget.reserve(1,signal())).resolves.toBeDefined();
});

it('partitions Gemini reservations by verified scope while legacy unscoped entries constrain every scope',async()=>{
 vi.useFakeTimers();const file=path(),a='a'.repeat(64),b='b'.repeat(64),budget=new ProviderRateBudget('gemini',file);
 await Promise.all(Array.from({length:10},()=>budget.reserve(1,signal(),a)));
 await expect(new ProviderRateBudget('gemini',file).reserve(1,signal(),b)).resolves.toBeDefined();
 const cancel=new AbortController(),blocked=expect(new ProviderRateBudget('gemini',file).reserve(1,cancel.signal,a)).rejects.toThrow();cancel.abort();await blocked;
 const retained=JSON.parse(readFileSync(file,'utf8'));expect(retained.entries).toHaveLength(11);expect(retained.entries.filter((e:any)=>e.scope===a)).toHaveLength(10);
 writeFileSync(file,JSON.stringify({version:1,entries:Array.from({length:500},()=>({at:Date.now()-120000,tokens:1})),headers:[]}));
 for(const scope of [a,b])expect(new ProviderRateBudget('gemini',file).dailyAvailability(scope)).toBeDefined();
 expect(JSON.parse(readFileSync(file,'utf8')).entries).toHaveLength(500);
});
it('persists scope-specific cooldowns without shortening prior holds or exposing another account',async()=>{
 vi.useFakeTimers();const file=path(),budget=new ProviderRateBudget('gemini',file),a='a'.repeat(64),b='b'.repeat(64);
 budget.hold(Date.now()+300000,a);budget.hold(Date.now()+1000,a);
 expect(new ProviderRateBudget('gemini',file).cooldown(a)).toBe(new Date(Date.now()+300000).toISOString());expect(new ProviderRateBudget('gemini',file).cooldown(b)).toBeUndefined();
 await vi.advanceTimersByTimeAsync(300000);expect(budget.cooldown(a)).toBeUndefined();
 await expect(budget.reserve(1,signal(),'bad')).rejects.toThrow('scope');
});

it('uses an exact dashboard-observed estimate without deleting legacy reservations or relaxing other scopes/cooldowns',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-12T23:00:00Z'));const file=path(),budget=new ProviderRateBudget('gemini',file),scope='a'.repeat(64),other='b'.repeat(64),observedAt=Date.now(),expiresAt=Date.parse('2026-09-13T07:00:00Z');
 await budget.reserve(1,signal());const entries=[...Array.from({length:500},()=>({at:observedAt-31*60000,tokens:1})),{at:observedAt-30*60000,tokens:1},{at:observedAt-32*60000,tokens:1,scope}];writeFileSync(file,JSON.stringify({version:1,entries,headers:[]}));budget.hold(observedAt+300000,other);
 expect(budget.dailyAvailability(scope)).toBeDefined();const receipt=budget.recordZeroUsageBaseline({scope,observedAt,expiresAt,evidenceSha256:'c'.repeat(64)});expect(receipt).toMatchObject({basis:'provider-dashboard-observed-estimate',cutoff:observedAt-30*60000});
 expect(JSON.parse(readFileSync(file,'utf8')).entries).toEqual(entries);expect(new ProviderRateBudget('gemini',file).dailyAvailability(scope)).toBeUndefined();expect(budget.dailyAvailability(other)).toBeDefined();expect(budget.dailyAvailability()).toBeDefined();expect(budget.cooldown(other)).toBe(new Date(observedAt+300000).toISOString());
 await new ProviderRateBudget('gemini',file).reserve(1,signal(),scope);expect(JSON.parse(readFileSync(file,'utf8')).entries.slice(0,entries.length)).toEqual(entries);
 // Expiry restores the ordinary legacy constraint; it does not renew the estimate.
 vi.setSystemTime(expiresAt);expect(new ProviderRateBudget('gemini',file).dailyAvailability(scope)).toBeDefined();
});
it('keeps own scoped and recent unknown requests in the dashboard baseline budget',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-12T23:00:00Z'));const file=path(),budget=new ProviderRateBudget('gemini',file),scope='a'.repeat(64),observedAt=Date.now();await budget.reserve(1,signal());
 const entries=[...Array.from({length:499},()=>({at:observedAt-31*60000,tokens:1,scope})),{at:observedAt-30*60000,tokens:1}];writeFileSync(file,JSON.stringify({version:1,entries,headers:[]}));budget.recordZeroUsageBaseline({scope,observedAt,expiresAt:Date.parse('2026-09-13T07:00:00Z'),evidenceSha256:'b'.repeat(64)});expect(budget.dailyAvailability(scope)).toBeDefined();
});
it('rejects invalid, expired, wrong-provider and automatically replaced dashboard baselines',()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-12T23:00:00Z'));const baseline={scope:'a'.repeat(64),observedAt:Date.now(),expiresAt:Date.parse('2026-09-13T07:00:00Z'),evidenceSha256:'b'.repeat(64)},budget=new ProviderRateBudget('gemini');
 for(const patch of [{scope:'model-alias'},{scope:undefined},{evidenceSha256:'unverified'},{observedAt:Date.now()+1},{expiresAt:Date.now()-1},{expiresAt:Date.parse('2026-09-14T07:00:00Z')},{expiresAt:Date.parse('2026-09-13T06:00:00Z')},{remaining:500}])expect(()=>budget.recordZeroUsageBaseline({...baseline,...patch} as any)).toThrow('baseline');
 expect(()=>new ProviderRateBudget('groq').recordZeroUsageBaseline(baseline)).toThrow('baseline');budget.recordZeroUsageBaseline(baseline);expect(()=>budget.recordZeroUsageBaseline({...baseline,evidenceSha256:'c'.repeat(64)})).toThrow('cannot be replaced');
});

it('waits briefly for a real other-process atomic write and preserves both reservations',async()=>{
 const {spawn}=await import('node:child_process');const file=path(),budget=new ProviderRateBudget('gemini',file);await budget.reserve(1,signal());
 const child=spawn(process.execPath,['--input-type=module','-e',`import fs from 'node:fs';const file=process.argv[1];fs.writeFileSync(file+'.lock','',{flag:'wx',mode:0o600});process.send('locked');process.once('message',()=>setTimeout(()=>{const state=JSON.parse(fs.readFileSync(file,'utf8'));state.entries.push({at:Date.now(),tokens:2});fs.writeFileSync(file,JSON.stringify(state));fs.unlinkSync(file+'.lock');process.exit(0);},5));`,file],{stdio:['ignore','ignore','ignore','ipc']});
 try{await new Promise<void>((resolve,reject)=>{child.once('message',()=>resolve());child.once('error',reject);});const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.send('release');await budget.reserve(3,signal());await exited;expect(JSON.parse(readFileSync(file,'utf8')).entries.map((e:any)=>e.tokens)).toEqual([1,2,3]);}finally{if(child.exitCode===null)child.kill();}
});
it('retains every reservation when two actual helper processes share the protected ledger',async()=>{
 const {spawn}=await import('node:child_process');const file=path();await new ProviderRateBudget('openrouter',file).reserve(1,signal());
 const source=new URL('../src/runtime/provider-rate-budget.ts',import.meta.url).href,script=`const {ProviderRateBudget}=await import(process.argv[2]);const budget=new ProviderRateBudget('openrouter',process.argv[1]);process.send('ready');process.once('message',async()=>{try{for(let i=0;i<6;i++)await budget.reserve(1,new AbortController().signal);process.exit(0);}catch{process.exit(1);}});`;
 const children=Array.from({length:2},()=>spawn(process.execPath,['--import','tsx','--input-type=module','-e',script,file,source],{stdio:['ignore','ignore','ignore','ipc']}));
 try{await Promise.all(children.map(child=>new Promise<void>((resolve,reject)=>{child.once('message',()=>resolve());child.once('error',reject);child.once('exit',code=>{if(code!==null)reject(new Error('Helper exited before ready'));});})));const exits=children.map(child=>new Promise<number|null>(resolve=>child.once('exit',resolve)));children.forEach(child=>child.send('go'));expect(await Promise.all(exits)).toEqual([0,0]);expect(JSON.parse(readFileSync(file,'utf8')).entries).toHaveLength(13);}finally{children.forEach(child=>{if(child.exitCode===null)child.kill();});}
});
