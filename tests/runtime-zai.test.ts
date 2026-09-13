import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {afterEach,expect,it,vi} from 'vitest';
const wire=vi.hoisted(()=>({calls:[] as any[],responses:[] as any[],fail:false}));
vi.mock('node:https',()=>({request:(url:string,options:any,callback:any)=>{const pending=new EventEmitter() as any;pending.end=(raw:string)=>{wire.calls.push({url,body:JSON.parse(raw),options});if(wire.fail){pending.emit('error',new Error('synthetic transport'));return;}const response=Object.assign(new PassThrough(),{statusCode:200,headers:{}});wire.responses.push(response);callback(response);};return pending;}}));
import {DirectFree} from '../src/runtime/direct-free.js';
import type {DirectFreeOptions,DirectFreeTierAudit} from '../src/runtime/types.js';
function fixture(){
 const apiKey='PRIVATE_SYNTHETIC_ZAI_KEY',id='zai:glm-4.7-flash',audit:DirectFreeTierAudit={provider:'zai',accountId:'synthetic-account',billingEnabled:false,credentialSha256:createHash('sha256').update(apiKey).digest('hex'),modelIds:[id],verifiedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60_000).toISOString(),evidence:'Synthetic logged-in free model and no billing audit',pricing:{source:'https://docs.z.ai/guides/overview/pricing',modelId:'glm-4.7-flash',input:0,cachedInput:0,cachedInputStorage:0,output:0,verifiedAt:new Date(Date.now()-1000).toISOString()}};
 const options:DirectFreeOptions={modelIds:[id],readCredentials:vi.fn(async()=>({apiKey,audit}))};vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('No invented metadata endpoint');}));return {id,audit,options,provider:new DirectFree('zai',options)};
}
const signal=()=>new AbortController().signal;
afterEach(()=>{for(const response of wire.responses)response.destroy();wire.calls=[];wire.responses=[];wire.fail=false;vi.useRealTimers();vi.unstubAllGlobals();});
it('builds only the audited free text profile and strips unsupported provider fields',async()=>{
 const f=fixture(),model=(await f.provider.models())[0]!;expect(model).toMatchObject({id:f.id,provider:'zai',contextTokens:32768,local:false,freeOnly:true,endpoint:'https://api.z.ai/api/paas/v4/chat/completions'});
 await f.provider.infer(model,{messages:[{role:'user',content:'Synthetic',images:['discard']}],tools:[{type:'function',function:{name:'add',description:'Synthetic',parameters:{}}}],tool_choice:'auto',max_tokens:8000,thinking:{type:'enabled'},web_search:true,model:'glm-5'},signal());
 expect(wire.calls[0].body).toEqual({model:'glm-4.7-flash',messages:[{role:'user',content:'Synthetic'}],tools:[{type:'function',function:{name:'add',description:'Synthetic',parameters:{}}}],tool_choice:'auto',stream:true,max_tokens:4096,thinking:{type:'disabled'}});expect(fetch).not.toHaveBeenCalled();expect(JSON.stringify(model)).not.toContain('PRIVATE_SYNTHETIC');
});
it.each(['glm-4.7-flashx','glm-4.5-flash','glm-5','glm-4.7-flash:online'])('rejects unqualified/paid %s identifiers',upstream=>{const f=fixture();expect(()=>new DirectFree('zai',{...f.options,modelIds:[`zai:${upstream}`]})).toThrow('exact namespaced');expect(wire.calls).toHaveLength(0);});
it.each(['input','cachedInput','cachedInputStorage','output'])('requires explicit numeric zero %s pricing before dispatch',async field=>{
 const f=fixture(),model=(await f.provider.models())[0]!;for(const value of [0.01,'0',null,false,undefined]){(f.audit.pricing as any)[field]=value;await expect(f.provider.infer(model,{messages:[]},signal())).rejects.toThrow('zero-price');}expect(wire.calls).toHaveLength(0);
});
it.each(['missing','expired','future','source','model','extra'])('fails closed on %s price evidence',async bad=>{
 const f=fixture();if(bad==='missing')delete f.audit.pricing;else if(bad==='expired')f.audit.pricing!.verifiedAt=new Date(Date.now()-86_400_000).toISOString();else if(bad==='future')f.audit.pricing!.verifiedAt=new Date(Date.now()+10_000).toISOString();else if(bad==='source')(f.audit.pricing as any).source='https://example.com';else if(bad==='model')(f.audit.pricing as any).modelId='glm-4.7-flashx';else (f.audit.pricing as any).discount='free';await expect(f.provider.models()).rejects.toThrow('zero-price');expect(wire.calls).toHaveLength(0);
});
it.each(['none','required',{type:'function',function:{name:'add'}}])('rejects unsupported tool choice rather than silently remapping it',async tool_choice=>{const f=fixture(),model=(await f.provider.models())[0]!;await expect(f.provider.infer(model,{messages:[],tool_choice},signal())).rejects.toThrow('auto tool choice');expect(wire.calls).toHaveLength(0);});
it('rejects paid built-in search tools before dispatch',async()=>{const f=fixture(),model=(await f.provider.models())[0]!;await expect(f.provider.infer(model,{messages:[],tools:[{type:'web_search',web_search:{enable:true}}]},signal())).rejects.toThrow('client function');expect(wire.calls).toHaveLength(0);});
it('holds one shared provider stream until response closes, then admits the waiting instance',async()=>{
 vi.useFakeTimers();const f=fixture(),model=(await f.provider.models())[0]!;await f.provider.infer(model,{messages:[],max_tokens:256},signal());const second=new DirectFree('zai',f.options).infer(model,{messages:[],max_tokens:256},signal());await vi.advanceTimersByTimeAsync(1000);expect(wire.calls).toHaveLength(1);wire.responses[0].emit('close');await vi.advanceTimersByTimeAsync(100);await second;expect(wire.calls).toHaveLength(2);
});
it('abort while waiting sends no second request and leaves the first response admitted',async()=>{
 vi.useFakeTimers();const f=fixture(),model=(await f.provider.models())[0]!;await f.provider.infer(model,{messages:[],max_tokens:256},signal());const controller=new AbortController(),pending=new DirectFree('zai',f.options).infer(model,{messages:[],max_tokens:256},controller.signal),rejected=expect(pending).rejects.toThrow();await vi.advanceTimersByTimeAsync(10);controller.abort();await rejected;expect(wire.calls).toHaveLength(1);
});
it('freshly rechecks audit after a stream wait and releases admission on pre-dispatch failure',async()=>{
 vi.useFakeTimers();const f=fixture(),model=(await f.provider.models())[0]!;await f.provider.infer(model,{messages:[],max_tokens:256},signal());const pending=new DirectFree('zai',f.options).infer(model,{messages:[],max_tokens:256},signal()),rejected=expect(pending).rejects.toThrow('fresh key-bound');await vi.advanceTimersByTimeAsync(60_000);wire.responses[0].emit('close');await vi.advanceTimersByTimeAsync(100);await rejected;expect(wire.calls).toHaveLength(1);
 f.audit.verifiedAt=new Date(Date.now()).toISOString();f.audit.expiresAt=new Date(Date.now()+60_000).toISOString();await f.provider.infer(model,{messages:[],max_tokens:256},signal());expect(wire.calls).toHaveLength(2);
});
it('releases admission after transport failure and keeps identity stable across audit refresh',async()=>{
 const f=fixture(),model=(await f.provider.models())[0]!;f.audit.pricing!.verifiedAt=new Date().toISOString();expect((await f.provider.models())[0]!.artifactIdentity).toBe(model.artifactIdentity);wire.fail=true;await expect(f.provider.infer(model,{messages:[],max_tokens:256},signal())).rejects.toThrow('transport');wire.fail=false;await f.provider.infer(model,{messages:[],max_tokens:256},signal());expect(wire.calls).toHaveLength(2);
});
it('expires advertised eligibility when either account or pricing evidence expires',async()=>{
 const f=fixture();f.audit.expiresAt=new Date(Date.now()+60*60_000).toISOString();f.audit.pricing!.verifiedAt=new Date(Date.now()-86_400_000+30_000).toISOString();const model=(await f.provider.models())[0]!;expect(Date.parse(model.tierExpiresAt)).toBe(Date.parse(f.audit.pricing!.verifiedAt)+86_400_000);
});
