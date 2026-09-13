import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const endpoint='https://integrate.api.nvidia.com/v1/chat/completions';
const model='nvidia/nemotron-3.5-lightning-30b-a3b';
export function readNimKey(directory=join(homedir(),'.local/share/opencorp/credentials')):string {
 try{
  const dir=lstatSync(directory);
  if(!dir.isDirectory()||dir.isSymbolicLink()||(dir.mode&0o7777)!==0o700||process.getuid&&dir.uid!==process.getuid())throw new Error();
  const fd=openSync(join(directory,'nvidia-nim-free.key'),constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
   const stat=fstatSync(fd);
   if(!stat.isFile()||(stat.mode&0o7777)!==0o600||stat.size>4096||process.getuid&&stat.uid!==process.getuid())throw new Error();
   const key=readFileSync(fd,'utf8').trim();if(!key||/[\r\n]/.test(key))throw new Error();return key;
  }finally{closeSync(fd);}
 }catch{throw new Error('private_credential_unavailable');}
}

/** Development/testing only: no production model registration or routing. */
export async function verifyNimSmoke(options:{readKey:()=>string;fetch?:typeof fetch}) {
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),45_000),started=Date.now();
 const report={model,endpoint,syntheticOnly:true,developmentTestingOnly:true,productionEligible:false,corporateQualification:false,quota:'unknown',passed:false,requests:0,clientFunctionExecuted:false,answerCorrect:false,lastHttpStatus:0,elapsedMs:0,error:''};
 let stage='private_credential_unavailable';
 try{
  const key=options.readKey(),messages:Record<string,unknown>[]=[{role:'system',content:'Use add_numbers for arithmetic. After its result, answer with the integer only.'},{role:'user',content:'What is 17 plus 25?'}];
  const tools=[{type:'function',function:{name:'add_numbers',description:'Add two integers.',parameters:{type:'object',properties:{a:{type:'integer'},b:{type:'integer'}},required:['a','b'],additionalProperties:false}}}];
  for(let turn=0;turn<2;turn++){
   stage='request_failed';report.requests++;
   const response=await (options.fetch??fetch)(endpoint,{method:'POST',redirect:'error',signal:controller.signal,headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify({model,messages,tools,tool_choice:turn===0?{type:'function',function:{name:'add_numbers'}}:'none',stream:false,max_tokens:256,temperature:0,chat_template_kwargs:{enable_thinking:false}})});
   report.lastHttpStatus=response.status;
   if(!response.ok){await response.body?.cancel();stage='provider_http_error';throw new Error();}
   stage='invalid_response';const reader=response.body?.getReader();if(!reader)throw new Error();
   const chunks:Uint8Array[]=[];let bytes=0;
   try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>65536)throw new Error();chunks.push(part.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
   const data=JSON.parse(Buffer.concat(chunks).toString('utf8')),choice=data.choices?.[0],message=choice?.message;
   if(data.error||data.choices?.length!==1||!message||!['stop','tool_calls'].includes(choice.finish_reason))throw new Error();
   stage='fixture_check_failed';
   if(turn===0){
    const call=message.tool_calls?.[0];
    if(message.tool_calls?.length!==1||call.type!=='function'||typeof call.id!=='string'||!call.id||call.id.length>256||call.function?.name!=='add_numbers')throw new Error();
    const args=JSON.parse(call.function.arguments);
    if(!args||Object.keys(args).length!==2||args.a!==17||args.b!==25)throw new Error();
    const result=args.a+args.b;report.clientFunctionExecuted=true;
    messages.push({role:'assistant',content:null,tool_calls:[{id:call.id,type:'function',function:{name:'add_numbers',arguments:call.function.arguments}}]},{role:'tool',tool_call_id:call.id,content:String(result)});
   }else{
    if(message.tool_calls?.length||typeof message.content!=='string'||message.content.trim()!=='42')throw new Error();report.answerCorrect=true;
   }
  }
  if(controller.signal.aborted)throw new Error();report.passed=true;
 }catch{report.error=controller.signal.aborted?'timeout':stage;}
 finally{clearTimeout(timer);controller.abort();report.elapsedMs=Date.now()-started;}
 return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.length!==3||process.argv[2]!=='--nonsensitive-fixture'){console.error('Requires --nonsensitive-fixture; development/testing only, no production eligibility.');process.exitCode=1;}
 else{const report=await verifyNimSmoke({readKey:readNimKey});console.log(JSON.stringify(report));if(!report.passed)process.exitCode=1;}
}
