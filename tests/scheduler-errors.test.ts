import { describe, expect, it } from 'vitest';
import { isTransientExecutionFailure } from '../src/scheduler/errors.js';
import { RuntimeExecutionError, type RuntimeFailureCode } from '../src/runtime/types.js';

const apiError=(data:Record<string,unknown>,prefix='OpenCode session error')=>new RuntimeExecutionError('runtime_failed',`${prefix}: ${JSON.stringify({name:'APIError',data})}`);

describe('execution failure retry classification',()=>{
 it('rejects the retained eaa provider-400 shape despite timeout text in keep-alive metadata',()=>{
  const message='Local inference HTTP 400: '+JSON.stringify({error:{message:'Cannot have 2 or more assistant messages at the end of the list.',type:'invalid_request_error'}});
  const error=apiError({message,statusCode:400,isRetryable:false,responseHeaders:{'cache-control':'no-store',connection:'keep-alive','content-type':'application/json','keep-alive':'timeout=5'},responseBody:JSON.stringify({error:{message}})});
  expect(/timeout|ECONN|fetch failed|socket|HTTP 5/i.test(String(error))).toBe(true);
  expect(isTransientExecutionFailure(error)).toBe(false);
 });
 it.each([400,401,403,404,422])('keeps HTTP %i permanent even when provider body/URL or retry hint suggest transport',statusCode=>{
  expect(isTransientExecutionFailure(apiError({message:'Rejected input',statusCode,isRetryable:true,url:'http://localhost/timeout',responseHeaders:{'keep-alive':'timeout=5'},responseBody:'fetch failed ECONNRESET socket HTTP 503'}))).toBe(false);
 });
 it.each([408,429,500,503])('honors an explicit nonretryable provider flag for HTTP %i',statusCode=>{
  expect(isTransientExecutionFailure(apiError({message:'fetch failed',statusCode,isRetryable:false}))).toBe(false);
 });
 it.each([408,429,500,502,503,504])('allows known temporary HTTP %i responses without a nonretryable flag',statusCode=>{
  expect(isTransientExecutionFailure(apiError({message:'Temporary provider response',statusCode,isRetryable:true}))).toBe(true);
  expect(isTransientExecutionFailure(apiError({message:'Temporary provider response',statusCode},'OpenCode local turn error'))).toBe(true);
 });
 it.each(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_SOCKET'])('recognizes actual %s transport causes through the runtime wrapper',code=>{
  const cause=Object.assign(new Error('Underlying transport failed'),{code});
  expect(isTransientExecutionFailure(new RuntimeExecutionError('runtime_failed','Native transport failed',undefined,{cause:new Error('Native wrapper',{cause})}))).toBe(true);
 });
 it.each([new TypeError('fetch failed'),new Error('socket hang up'),new DOMException('The operation was aborted due to timeout','TimeoutError'),new Error('connect ECONNREFUSED 127.0.0.1:1234'),new Error('Local inference HTTP 503: temporarily unavailable')])('recognizes a known direct transport/provider failure: %s',error=>{
  expect(isTransientExecutionFailure(error)).toBe(true);
 });
 it.each(['output_limit_exhausted','run_budget_exhausted','step_budget_exhausted'] as RuntimeFailureCode[])('never retries typed %s because its message or cause resembles a timeout',code=>{
  expect(isTransientExecutionFailure(new RuntimeExecutionError(code,'Run budget timeout; fetch failed',undefined,{cause:Object.assign(new Error('socket hang up'),{code:'ECONNRESET'})}))).toBe(false);
 });
 it('does not scan incidental error text, malformed envelopes or unsupported nested metadata',()=>{
  for(const error of [new Error('Invalid file /workspace/timeout/socket.md'),new Error('Configuration rejected; HTTP 503 mentioned in input'),new Error('OpenCode session error: {"responseHeaders":{"keep-alive":"timeout=5"}'),apiError({message:'Invalid provider input',url:'http://localhost/timeout',responseBody:'fetch failed'})])expect(isTransientExecutionFailure(error)).toBe(false);
 });
 it('lets a permanent cause override a generic fetch wrapper and bounds cyclic/deep causes',()=>{
  expect(isTransientExecutionFailure(new TypeError('fetch failed',{cause:apiError({message:'Rejected input',statusCode:400,isRetryable:false})}))).toBe(false);
  const cycle=new Error('Unknown');cycle.cause=cycle;expect(isTransientExecutionFailure(cycle)).toBe(false);
  let deep:Error=Object.assign(new Error('Transport cause'),{code:'ECONNRESET'});for(let i=0;i<4;i++)deep=new Error('Wrapper',{cause:deep});expect(isTransientExecutionFailure(deep)).toBe(false);
 });
});
