import { createHash } from 'node:crypto';

// Opaque provider protocol state, never reasoning text. Each gateway owns one
// instance; nothing is persisted, exposed as evidence, or shared between runs.
function argumentsHash(value:string):string {
 const stable=(v:any):any=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
 return createHash('sha256').update(JSON.stringify(stable(JSON.parse(value)))).digest('hex');
}
type Call={id:string;name:string;arguments:string;signature?:string};
export class GeminiSignatures {
 private readonly retained=new Map<string,{name:string;argumentsHash:string;signature:string}>();
 private bytes=0;
 restore(messages:any[]):any[]{
  return messages.map(message=>message?.role!=='assistant'||!Array.isArray(message.tool_calls)?message:{...message,tool_calls:message.tool_calls.map((call:any)=>{
   const retained=this.retained.get(call?.id);
   if(!retained)return call;
   if(call.type!=='function'||call.function?.name!==retained.name||typeof call.function.arguments!=='string'||argumentsHash(call.function.arguments)!==retained.argumentsHash)throw new Error('Gemini tool protocol binding mismatch');
   return {...call,extra_content:{google:{thought_signature:retained.signature}}};
  })});
 }
 begin(){
  const calls=new Map<string,Call>();let finished=false;
  return {
   observe:(data:any)=>{
    for(const choice of data.choices??[]){
     if(choice.index!==undefined&&choice.index!==0)continue;
     if(choice.finish_reason==='tool_calls'||choice.finish_reason==='stop')finished=true;
     for(const part of choice.delta?.tool_calls??[]){
      // Gemini emits complete calls with an ID but no index. An ID-less
      // fragment still needs a valid index; never infer which call it belongs to.
      if(part.index!==undefined&&(!Number.isSafeInteger(part.index)||part.index<0||part.index>127))throw new Error('Gemini tool protocol index exceeds bound');
      if(part.id!==undefined&&(typeof part.id!=='string'||!part.id||part.id.length>512))throw new Error('Gemini tool protocol ID invalid');
      if(part.index===undefined&&!part.id)throw new Error('Gemini tool protocol fragment has no identity');
      const key=part.index===undefined?`id:${part.id}`:`index:${part.index}`;
      const call=calls.get(key)??{id:'',name:'',arguments:''};
      if(part.id){if(call.id&&call.id!==part.id)throw new Error('Gemini tool protocol ID changed');call.id=part.id;}
      if(typeof part.function?.name==='string')call.name+=part.function.name;
      if(typeof part.function?.arguments==='string')call.arguments+=part.function.arguments;
      const signature=part.extra_content?.google?.thought_signature;
      if(signature!==undefined){if(typeof signature!=='string'||!signature.length||signature.length>65536||call.signature&&call.signature!==signature)throw new Error('Gemini tool protocol signature invalid');call.signature=signature;}
      if(call.arguments.length>1_048_576||call.id.length>512||call.name.length>512)throw new Error('Gemini tool protocol exceeds bound');
      calls.set(key,call);
      if(calls.size>128)throw new Error('Gemini tool protocol call count exceeds bound');
     }
    }
   },
   commit:()=>{
    if([...calls.values()].some(call=>call.signature)&&!finished)throw new Error('Gemini tool protocol stream incomplete');
    const updates=new Map<string,{name:string;argumentsHash:string;signature:string}>();let bytes=0;
    for(const call of calls.values())if(call.signature){
     if(!call.id||!call.name)throw new Error('Gemini tool protocol incomplete');
     const value={name:call.name,argumentsHash:argumentsHash(call.arguments),signature:call.signature},prior=updates.get(call.id)??this.retained.get(call.id);
     if(prior&&JSON.stringify(prior)!==JSON.stringify(value))throw new Error('Gemini tool protocol ID reused');
     if(!prior){updates.set(call.id,value);bytes+=call.signature.length;}
    }
    if(this.retained.size+updates.size>128||this.bytes+bytes>1_048_576)throw new Error('Gemini tool protocol retention exceeds bound');
    for(const [id,value]of updates)this.retained.set(id,value);this.bytes+=bytes;
   },
  };
 }
}
