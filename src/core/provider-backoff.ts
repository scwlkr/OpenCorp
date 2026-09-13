/** Transport observations only; this is a retry policy, never a quota-reset claim. */
export interface ProviderBackoff {
 provider:'openrouter'; status:429; modelId:string; observedAt:string; retryAt:string;
 failures:number; basis:'retry-after'|'estimated-backoff';
 /** Numeric transport metadata only; reset units are not inferred. */
 rateLimitHeaders?:Partial<Record<'x-ratelimit-limit'|'x-ratelimit-remaining'|'x-ratelimit-reset',number>>;
}
export function nextProviderBackoff(modelId:string,header:unknown,prior:ProviderBackoff|undefined,now=Date.now(),headers:Record<string,unknown>={}):ProviderBackoff {
 const rateLimitHeaders:NonNullable<ProviderBackoff['rateLimitHeaders']>={};
 for(const key of ['x-ratelimit-limit','x-ratelimit-remaining','x-ratelimit-reset'] as const){
  const raw=headers[key];
  if(typeof raw!=='string'||raw.length>16||!/^\d+$/.test(raw))continue;
  const value=Number(raw);if(Number.isSafeInteger(value))rateLimitHeaders[key]=value;
 }
 const failures=Math.min(20,(prior?.failures??0)+1);
 let requested:number|undefined;
 if(typeof header==='string'){
  if(/^\d+$/.test(header.trim())){const seconds=Number(header);if(Number.isSafeInteger(seconds)&&seconds>=0&&now+seconds*1000<=8640000000000000)requested=now+seconds*1000;}
  else if(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(header)){const at=Date.parse(header);if(Number.isFinite(at))requested=Math.max(now,at);}
 }
 // Zero or past guidance supplies no future hold; apply the explicit local estimate.
 if(requested!==undefined&&requested<=now)requested=undefined;
 const retryAt=Math.max(Date.parse(prior?.retryAt??'')||0,requested??now+Math.min(3600000,300000*2**(failures-1)));
 return {provider:'openrouter',status:429,modelId,observedAt:new Date(now).toISOString(),retryAt:new Date(retryAt).toISOString(),failures,basis:requested===undefined?'estimated-backoff':'retry-after',...(Object.keys(rateLimitHeaders).length?{rateLimitHeaders}:{})};
}
