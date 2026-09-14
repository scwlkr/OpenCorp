import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import PostalMime from 'postal-mime';

interface Environment{
 TOKEN:string; REPLY_KEY:string; MAILBOX:string; OWNER:string;
 EMAIL:{send(message:{from:string;to:string;subject:string;text:string;replyTo:string;headers?:Record<string,string>}):Promise<{messageId:string}>};
 INBOX:{put(key:string,value:string,options:{expirationTtl:number}):Promise<void>;get(key:string):Promise<string|null>;delete(key:string):Promise<void>;list(options:{limit:number}):Promise<{keys:{name:string}[]}>};
}
function authorized(request:Request,env:Environment){if(!env.TOKEN||env.TOKEN.length<32)return false;const actual=Buffer.from(request.headers.get('authorization')??''),expected=Buffer.from(`Bearer ${env.TOKEN}`);return actual.length===expected.length&&timingSafeEqual(actual,expected);}
function validReply(to:string,env:Environment){
 const [local,domain]=env.MAILBOX.split('@'),prefix=`${local}+`;
 if(!to.startsWith(prefix)||!to.endsWith(`@${domain}`))return false;
 const value=to.slice(prefix.length,-domain!.length-1);if(!/^[a-f0-9]{56}$/.test(value))return false;
 const id=value.slice(0,32).replace(/^(........)(....)(....)(....)(............)$/,'$1-$2-$3-$4-$5');
 return timingSafeEqual(Buffer.from(value.slice(32)),Buffer.from(createHmac('sha256',env.REPLY_KEY).update(id).digest('hex').slice(0,24)));
}
/** Minimal Cloudflare mail transport and temporary inbox. Company state remains local SQLite. */
export default {
 async fetch(request:Request,env:Environment):Promise<Response>{
  if(!authorized(request,env))return new Response('Unauthorized',{status:401});
  const path=new URL(request.url).pathname;
  try{
   if(request.method==='GET'&&path==='/profile')return Response.json({mailbox:env.MAILBOX,owner:env.OWNER});
   if(request.method==='GET'&&path==='/inbox'){
    const page=await env.INBOX.list({limit:50}),messages=[];
    for(const key of page.keys){const value=await env.INBOX.get(key.name);if(value)messages.push(JSON.parse(value));}
    return Response.json({messages});
   }
   if(request.method==='POST'){
    const body=await request.text();if(body.length>100000)return new Response('Too large',{status:413});const data=JSON.parse(body);
    if(path==='/ack'&&typeof data.id==='string'&&/^[a-f0-9]{64}$/.test(data.id)){await env.INBOX.delete(data.id);return Response.json({ok:true});}
    if(path==='/send'&&typeof data.text==='string'&&data.text.trim()&&data.text.length<=80000&&typeof data.replyTo==='string'&&validReply(data.replyTo,env)){
     if(data.inReplyTo!==undefined&&(typeof data.inReplyTo!=='string'||/[\r\n]/.test(data.inReplyTo)))return new Response('Invalid reference',{status:400});
     const result=await env.EMAIL.send({from:env.MAILBOX,to:env.OWNER,subject:'OpenCorp executive conversation',text:data.text,replyTo:data.replyTo,...(data.inReplyTo?{headers:{'In-Reply-To':data.inReplyTo,References:data.inReplyTo}}:{})});
     return Response.json({id:result.messageId});
    }
   }
   return new Response('Invalid request',{status:400});
  }catch{return new Response('No confirmed result',{status:502});}
 },
 async email(message:{from:string;to:string;rawSize:number;raw:ReadableStream;setReject(reason:string):void},env:Environment){
  if(message.from.toLowerCase()!==env.OWNER.toLowerCase()||!validReply(message.to,env)){message.setReject('Reply to an existing OpenCorp email from the configured Owner address.');return;}
  if(message.rawSize>256000){message.setReject('Use a short text reply without attachments.');return;}
  const raw=await new Response(message.raw).arrayBuffer(),parsed=await PostalMime.parse(raw);
  if(parsed.attachments.length>0||parsed.from?.address?.toLowerCase()!==env.OWNER.toLowerCase()||!parsed.text?.trim()||parsed.text.length>20000){message.setReject('Use a short plain-text Owner reply.');return;}
  const id=createHash('sha256').update(message.to).update(parsed.messageId??Buffer.from(raw)).digest('hex');
  await env.INBOX.put(id,JSON.stringify({id,from:env.OWNER,to:message.to,text:parsed.text}),{expirationTtl:2592000});
 }
};
