import { expect,it } from 'vitest';
import { GeminiSignatures } from '../src/runtime/gemini-signatures.js';
const delta=(tool_calls:any[])=>({choices:[{index:0,delta:{tool_calls}}]});
const call=(id='a',name='read',args='{"id":1}')=>({id,type:'function',function:{name,arguments:args}});
const signed=(id='a',index=0)=>({...call(id),index,extra_content:{google:{thought_signature:`opaque-${id}`}}});
const done={choices:[{index:0,finish_reason:'tool_calls',delta:{}}]};
it('reassembles multiple streamed calls and restores only matching exact provider bindings',()=>{
 const cache=new GeminiSignatures(),turn=cache.begin();
 turn.observe(delta([{index:0,id:'a',function:{name:'read',arguments:'{"id":'},extra_content:{google:{thought_signature:'opaque-a'}}},signed('b',1)]));
 turn.observe(delta([{index:0,function:{arguments:'1}'}}]));turn.observe(done);turn.commit();
 const messages=[{role:'assistant',tool_calls:[call(),call('b','read','{ "id": 1 }')]},{role:'user',content:'Unchanged'}];
 const restored=cache.restore(messages);expect(restored[0].tool_calls.map((v:any)=>v.extra_content)).toEqual([{google:{thought_signature:'opaque-a'}},{google:{thought_signature:'opaque-b'}}]);expect(messages[0]).not.toHaveProperty('tool_calls.0.extra_content');
 expect(cache.restore([{role:'assistant',tool_calls:[call('unknown')]}])[0].tool_calls[0]).not.toHaveProperty('extra_content');
 expect(new GeminiSignatures().restore(messages)[0]).toEqual(messages[0]);
});
it.each([call('a','write'),call('a','read','{"id":2}')])('rejects changed call bindings without guessing',changed=>{const cache=new GeminiSignatures(),turn=cache.begin();turn.observe(delta([signed()]));turn.observe(done);turn.commit();expect(()=>cache.restore([{role:'assistant',tool_calls:[changed]}])).toThrow('binding mismatch');});
it('does not retain an incomplete response or conflicting reused ID',()=>{
 const cache=new GeminiSignatures(),partial=cache.begin();partial.observe(delta([signed()]));expect(()=>partial.commit()).toThrow('stream incomplete');expect(cache.restore([{role:'assistant',tool_calls:[call()]}])[0].tool_calls[0]).not.toHaveProperty('extra_content');
 const turn=cache.begin();turn.observe(delta([signed()]));turn.observe(done);turn.commit();
 const later=cache.begin();later.observe(delta([{...signed(),extra_content:{google:{thought_signature:'different'}}}]));later.observe(done);expect(()=>later.commit()).toThrow('ID reused');
});
it('bounds opaque signatures and never takes a signature from another field',()=>{const cache=new GeminiSignatures(),turn=cache.begin();expect(()=>turn.observe(delta([{...signed(),extra_content:{google:{thought_signature:'x'.repeat(65537)}}}]))).toThrow('signature invalid');const clean=cache.begin();clean.observe(delta([{...call(),index:0,thought_signature:'untrusted'}]));clean.observe(done);clean.commit();expect(cache.restore([{role:'assistant',tool_calls:[call()]}])[0].tool_calls[0]).not.toHaveProperty('extra_content');});
it('gateway retains split SSE signatures privately and replays them after native fields are lost',async()=>{
 const {Readable}=await import('node:stream'),{DirectFree}=await import('../src/runtime/direct-free.js'),{RunGateway}=await import('../src/runtime/gateway.js');
 const provider=new DirectFree('gemini',{modelIds:['gemini:fixture'],readCredentials:async()=>{throw new Error('No credential reads in fixture');}}),seen:any[]=[];
 provider.infer=async(_model,body)=>{seen.push(structuredClone(body));const text=seen.length===1?`data: ${JSON.stringify(delta([{...signed(),index:undefined}]))}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`:'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';return Object.assign(Readable.from([Buffer.from(text.slice(0,75)),Buffer.from(text.slice(75))]),{statusCode:200,headers:{'content-type':'text/event-stream'}}) as any;};
 const events:any[]=[];const gateway=new RunGateway(provider,{id:'gemini:fixture',alias:'gemini:fixture',provider:'gemini',local:false,artifactIdentity:'synthetic',contextTokens:32768} as any,{runId:'synthetic',employeeId:'employee',workspace:'/unused',modelId:'gemini:fixture',system:'',prompt:''},event=>events.push(event));
 await gateway.start();gateway.sessionId='bound';
 const request=(messages:any[])=>fetch(`${gateway.url}/v1/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${gateway.secret}`},body:JSON.stringify({model:'gemini:fixture',stream:true,messages})});
 try{expect((await(await request([{role:'user',content:'Synthetic'}])).text())).toContain('opaque-a');await(await request([{role:'user',content:'Synthetic'},{role:'assistant',tool_calls:[call()]},{role:'tool',tool_call_id:'a',content:'1'}])).text();expect(seen[1].messages[1].tool_calls[0].extra_content.google.thought_signature).toBe('opaque-a');expect(JSON.stringify(events)).not.toContain('opaque-a');}finally{await gateway.close();}
});

it.each(['stop','tool_calls'])('accepts completed %s with signed calls, never length termination',finish_reason=>{const cache=new GeminiSignatures(),turn=cache.begin();turn.observe(delta([signed()]));turn.observe({choices:[{index:0,finish_reason,delta:{}}]});turn.commit();expect(cache.restore([{role:'assistant',tool_calls:[call()]}])[0].tool_calls[0].extra_content.google.thought_signature).toBe('opaque-a');const incomplete=new GeminiSignatures().begin();incomplete.observe(delta([signed()]));incomplete.observe({choices:[{index:0,finish_reason:'length',delta:{}}]});expect(()=>incomplete.commit()).toThrow('incomplete');});

it('accepts actual Gemini complete ID-bound calls without indices, including multiple calls',()=>{const cache=new GeminiSignatures(),turn=cache.begin();const a=signed(),b=signed('b',1);delete (a as any).index;delete (b as any).index;turn.observe(delta([a,b]));turn.observe({choices:[{index:0,finish_reason:'stop',delta:{}}]});turn.commit();expect(cache.restore([{role:'assistant',tool_calls:[call(),call('b')]}])[0].tool_calls.map((t:any)=>t.extra_content.google.thought_signature)).toEqual(['opaque-a','opaque-b']);});
it.each([{function:{arguments:'1}'}},{index:'0',id:'a'},{index:-1,id:'a'}])('rejects ambiguous or malformed call fragments without inferring an identity',part=>{expect(()=>new GeminiSignatures().begin().observe(delta([part]))).toThrow(/identity|index/);});
