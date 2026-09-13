import { afterEach, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readNimKey, verifyNimSmoke } from '../scripts/verify-nvidia-nim-free.js';
const call={id:'call_fixture',type:'function',function:{name:'add_numbers',arguments:JSON.stringify({a:17,b:25})}};
const response=(message:unknown,finish_reason='stop')=>new Response(JSON.stringify({choices:[{message,finish_reason}]}));
afterEach(()=>vi.useRealTimers());
it('executes exactly two synthetic requests with fixed endpoint/model, small output and actual inert function result',async()=>{
 const inputs:any[]=[];const fake=vi.fn(async(url:any,init:any)=>{inputs.push({url,...JSON.parse(init.body)});return inputs.length===1?response({tool_calls:[call]},'tool_calls'):response({content:'42'});});
 const result=await verifyNimSmoke({readKey:()=> 'synthetic-secret',fetch:fake as typeof fetch});
 expect(result).toMatchObject({passed:true,requests:2,clientFunctionExecuted:true,answerCorrect:true,productionEligible:false,quota:'unknown'});
 for(const input of inputs)expect(input).toMatchObject({url:'https://integrate.api.nvidia.com/v1/chat/completions',model:'nvidia/nemotron-3.5-lightning-30b-a3b',max_tokens:256,stream:false,chat_template_kwargs:{enable_thinking:false}});
 expect(inputs[1].messages.at(-1)).toEqual({role:'tool',tool_call_id:'call_fixture',content:'42'});expect(JSON.stringify(result)).not.toMatch(/synthetic-secret|tool_calls|arguments/);
});
it.each([400,429,500])('stops on HTTP%s without retry or exposing body',async status=>{
 const fake=vi.fn(async()=>new Response('secret reasoning diagnostic',{status}));const result=await verifyNimSmoke({readKey:()=> 'secret',fetch:fake});expect(fake).toHaveBeenCalledOnce();expect(result).toMatchObject({passed:false,requests:1,lastHttpStatus:status,error:'provider_http_error'});expect(JSON.stringify(result)).not.toContain('secret');
});
it.each(['wrong_arguments','length','oversize','network'])('fails closed on %s with safe report',async kind=>{
 const fake=vi.fn(async()=>{if(kind==='network')throw new Error('secret raw message');if(kind==='oversize')return new Response('x'.repeat(65537));return response({tool_calls:[{...call,function:{...call.function,arguments:'{"a":99,"b":25}'}}]},kind==='length'?'length':'tool_calls');});
 const result=await verifyNimSmoke({readKey:()=> 'secret',fetch:fake});expect(result.passed).toBe(false);expect(fake).toHaveBeenCalledOnce();expect(JSON.stringify(result)).not.toContain('secret');
});
it('aborts the same request at total45s without retry',async()=>{
 vi.useFakeTimers();const fake=vi.fn(async(_url:any,init:any)=>new Promise<Response>((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('private error')))));
 const pending=verifyNimSmoke({readKey:()=> 'secret',fetch:fake as typeof fetch});await vi.advanceTimersByTimeAsync(45000);expect(await pending).toMatchObject({passed:false,requests:1,error:'timeout'});expect(fake).toHaveBeenCalledOnce();
});
it('reads only an owned private nonsymlink key and sanitizes failure',()=>{
 const dir=mkdtempSync(join(tmpdir(),'nim-key-test-'));chmodSync(dir,0o700);const key=join(dir,'nvidia-nim-free.key');
 try{writeFileSync(key,'synthetic-only\n',{mode:0o600});expect(readNimKey(dir)).toBe('synthetic-only');chmodSync(key,0o644);expect(()=>readNimKey(dir)).toThrow('private_credential_unavailable');rmSync(key);symlinkSync(join(dir,'other'),key);expect(()=>readNimKey(dir)).toThrow('private_credential_unavailable');}finally{rmSync(dir,{recursive:true,force:true});}
});
