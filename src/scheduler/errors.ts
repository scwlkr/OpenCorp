import { RuntimeExecutionError } from '../runtime/types.js';

const transportCodes=new Set(['ECONNRESET','ECONNREFUSED','ECONNABORTED','ETIMEDOUT','EPIPE','EAI_AGAIN','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET']);
const retryableStatus=(status:number)=>status===408||status===429||status>=500&&status<600;
const transportMessage=(message:string)=>/^(?:fetch failed|socket hang up)(?::|$)/i.test(message)||/^(?:connect|read|write|getaddrinfo) (?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|EAI_AGAIN)\b/.test(message);

/** Classify the actual failure, never incidental headers, URLs or response bodies. */
export function isTransientExecutionFailure(error:unknown):boolean {
 let current:any=error,transport=false;
 const seen=new Set<unknown>();
 for(let depth=0;current!=null&&depth<4&&!seen.has(current);depth++){
  seen.add(current);
  if(current instanceof RuntimeExecutionError&&current.code!=='runtime_failed')return false;
  const message=typeof current==='string'?current:typeof current.message==='string'?current.message:'';
  // These are the two exact envelopes emitted by the pinned runtime adapter.
  const envelope=/^OpenCode (?:session|local turn) error: (.*)$/s.exec(message);
  if(envelope){
   let data:any;try{const parsed=JSON.parse(envelope[1]);if(parsed?.name!=='APIError')return false;data=parsed.data;}catch{return false;}
   if(!data||typeof data!=='object'||data.isRetryable===false)return false;
   if(Number.isInteger(data.statusCode))return retryableStatus(data.statusCode);
   return typeof data.message==='string'&&transportMessage(data.message);
  }
  if(current.isRetryable===false)return false;
  if(Number.isInteger(current.statusCode))return retryableStatus(current.statusCode);
  const http=/^(?:Local inference |Owned Ollama model inventory )?HTTP (\d{3})(?::|\s|$)/.exec(message);
  if(http)return retryableStatus(Number(http[1]));
  transport ||= transportCodes.has(current.code)||current.name==='TimeoutError'||transportMessage(message);
  current=current.cause;
 }
 return transport;
}
