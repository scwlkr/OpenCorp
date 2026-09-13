import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DirectFree } from '../src/runtime/direct-free.js';
import { directFreeProvider } from '../src/core/inference-policy.js';
import { directFreeConfig } from '../src/server/direct-free-config.js';

// Two bounded requests with synthetic data only. This proves transport/function
// calling, not corporate management or mixed local/remote capacity qualification.
const {values}=parseArgs({options:{model:{type:'string'},'nonsensitive-fixture':{type:'boolean'}},strict:true});
assert.equal(values['nonsensitive-fixture'],true,'Requires --nonsensitive-fixture');
const modelId=values.model,provider=directFreeProvider(modelId);
assert.ok(modelId&&provider,'Requires exact groq:MODEL or gemini:MODEL');
const dataRoot=join(homedir(),'.local/share/opencorp');
const options=directFreeConfig(dataRoot,[modelId])?.[provider];
assert.ok(options,'Protected free-provider setup is absent');
const transport=new DirectFree(provider,options),controller=new AbortController();
const timer=setTimeout(()=>controller.abort(),90_000);
const started=Date.now();
const report:Record<string,unknown>={modelId,syntheticOnly:true,corporateQualification:false,mixedCapacityQualification:false,passed:false,requests:0};
const messages:Record<string,unknown>[]=[{role:'system',content:'Use the provided sum tool for arithmetic. After its result, answer with the resulting integer only.'},{role:'user',content:'What is 17 plus 25?'}];
const tools=[{type:'function',function:{name:'sum',description:'Add two integers.',parameters:{type:'object',properties:{a:{type:'integer'},b:{type:'integer'}},required:['a','b'],additionalProperties:false}}}];
try{
 const model=(await transport.models(controller.signal)).find(item=>item.id===modelId);assert.ok(model,'Model unavailable');
 report.artifactIdentity=model.artifactIdentity;report.tierVerification=model.tierVerification;
 for(let turn=0;turn<2;turn++){
  report.requests=turn+1;
  const response=await transport.infer(model,{messages,tools,tool_choice:turn===0?{type:'function',function:{name:'sum'}}:'none',max_tokens:256,temperature:0},controller.signal);
  report.lastHttpStatus=response.statusCode;
  if(response.statusCode!==200){response.destroy();throw new Error(`Provider HTTP ${response.statusCode}; no retry`);}
  let buffer='',content='';let bytes=0;const calls=new Map<number,{id:string;name:string;arguments:string;extra_content?:unknown}>();
  for await(const chunk of response){
   bytes+=Buffer.byteLength(chunk);if(bytes>256_000){response.destroy();throw new Error('Synthetic response exceeded bound');}
   buffer+=chunk.toString();
   for(let end;(end=buffer.indexOf('\n'))>=0;){
    const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);
    if(!line.startsWith('data:'))continue;const payload=line.slice(5).trim();if(payload==='[DONE]')continue;
    const event=JSON.parse(payload);if(event.error)throw new Error('Provider stream error; no retry');
    const delta=event.choices?.[0]?.delta;if(!delta)continue;
    if(typeof delta.content==='string')content+=delta.content;
    for(const part of delta.tool_calls??[]){
     const call=calls.get(part.index)??{id:'',name:'',arguments:''};
     if(part.id)call.id=part.id;if(part.function?.name)call.name+=part.function.name;if(part.function?.arguments)call.arguments+=part.function.arguments;
     if(part.extra_content!==undefined)call.extra_content=part.extra_content;
     calls.set(part.index,call);
    }
   }
  }
  if(turn===0){
   assert.equal(calls.size,1,'Expected one function call');const call=[...calls.values()][0];
   assert.equal(call.name,'sum');assert.ok(call.id);assert.deepEqual(JSON.parse(call.arguments),{a:17,b:25});
   const result=17+25;
   messages.push({role:'assistant',content:null,tool_calls:[{id:call.id,type:'function',...(call.extra_content!==undefined?{extra_content:call.extra_content}:{}),function:{name:call.name,arguments:call.arguments}}]},{role:'tool',tool_call_id:call.id,content:String(result)});
   report.clientFunctionExecuted=true;
  }else{assert.equal(calls.size,0);assert.equal(content.trim(),'42');report.result=42;}
 }
 report.passed=true;
}catch(error){report.error=error instanceof Error?error.message:'Synthetic test failed';process.exitCode=1;}
finally{
 clearTimeout(timer);controller.abort();report.elapsedMs=Date.now()-started;
 const directory=join(dataRoot,'acceptance');await mkdir(directory,{recursive:true});
 const path=join(directory,`direct-free-${provider}-smoke-${started}.json`);
 await writeFile(path,JSON.stringify(report,null,2),{mode:0o600});
 console.log(JSON.stringify({path,...report}));
}
