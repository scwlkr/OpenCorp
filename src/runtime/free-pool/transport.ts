import type { IncomingMessage } from 'node:http';
import { PoolAttemptError, type PoolCompletion, type PoolRequest } from './types.js';

/** Only portable text and client tools cross provider boundaries. No paid add-ons. */
export function portableBody(input: PoolRequest, model: string) {
  const body: Record<string, any> = { model, stream: false, max_tokens: input.max_tokens ?? 4096, temperature: input.temperature ?? 0.2,
    messages: input.messages.map(message => ({ role: message.role, content: message.content ?? null,
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
      ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call: any) => ({ id: call.id, type: 'function', function: { name: call.function?.name, arguments: call.function?.arguments } })) } : {}) })) };
  if (input.tools?.length) body.tools = input.tools.map(tool => ({ type: 'function', function: { name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters } }));
  if (input.tool_choice !== undefined) body.tool_choice = typeof input.tool_choice === 'string' ? input.tool_choice : {type:'function',function:{name:(input.tool_choice as any).function.name}};
  if (input.response_format) body.response_format = { type: input.response_format.type };
  return body;
}
export async function readCompletion(response: Response): Promise<PoolCompletion> {
  if (!response.ok) {
    // Inspect only a bounded error prefix for daily quota classification; never retain it.
    let detail='';const reader=response.body?.getReader();
    try{if(reader)while(detail.length<8192){const part=await reader.read();if(part.done)break;detail+=new TextDecoder().decode(part.value).slice(0,8192-detail.length);}}finally{await reader?.cancel().catch(()=>{});}
    throw new PoolAttemptError(response.status,response.headers,/per.?day|daily|requestsperday|tokensperday/i.test(detail));
  }
  if (!response.body) throw new PoolAttemptError(502);
  const reader = response.body.getReader(); let text = '';
  try {
    const decoder = new TextDecoder();
    for (;;) { const next = await reader.read(); if (next.done) break; text += decoder.decode(next.value, { stream: true }); if (text.length > 2_000_000) throw new PoolAttemptError(502); }
    text += decoder.decode();
    if (!response.headers.get('content-type')?.includes('text/event-stream')) { try { return JSON.parse(text); } catch { throw new PoolAttemptError(502); } }
    let id = '', model = '', content = '', finish = '', usage: PoolCompletion['usage'];
    const calls = new Map<number, any>();
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:') || line.slice(5).trim() === '[DONE]') continue;
      let data: any; try { data = JSON.parse(line.slice(5)); } catch { throw new PoolAttemptError(502); }
      if (data.error) throw new PoolAttemptError(502);
      id = data.id ?? id; model = data.model ?? model; usage = data.usage ?? usage;
      for (const choice of data.choices ?? []) {
        if ((choice.index ?? 0) !== 0) throw new PoolAttemptError(502);
        finish = choice.finish_reason ?? finish; content += choice.delta?.content ?? '';
        for (const part of choice.delta?.tool_calls ?? []) {
          const index = part.index ?? (part.id ? [...calls].find(([,c]) => c.id === part.id)?.[0] ?? calls.size : -1);
          if (!Number.isInteger(index) || index < 0 || index > 127) throw new PoolAttemptError(502);
          const call = calls.get(index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (part.id) call.id = part.id;
          call.function.name += part.function?.name ?? ''; call.function.arguments += part.function?.arguments ?? '';
          if (part.extra_content) call.extra_content = part.extra_content;
          calls.set(index, call);
        }
      }
    }
    if (!finish) throw new PoolAttemptError(502);
    return { id, model, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: content || null, ...(calls.size ? { tool_calls: [...calls.values()] } : {}) }, finish_reason: finish }], usage };
  } finally { await reader.cancel().catch(() => {}); }
}
export async function readNativeCompletion(upstream: IncomingMessage) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(upstream.headers)) if (typeof value === 'string') headers.set(key, value);
  // Retain native transport cancellation semantics while buffering a bounded reply.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { upstream.on('data', chunk => controller.enqueue(new Uint8Array(chunk))); upstream.once('end', () => controller.close()); upstream.once('error', error => controller.error(error)); },
    cancel() { upstream.destroy(); },
  });
  return { completion: await readCompletion(new Response(stream, { status: upstream.statusCode, headers })), headers };
}
export function completionSSE(completion: PoolCompletion, alias = 'free-pool'): string {
  const choice = completion.choices[0]!;
  return `data: ${JSON.stringify({ id: completion.id, object: 'chat.completion.chunk', model: alias, choices: [{ index: 0, delta: { ...choice.message, ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls.map((c: any, index: number) => ({ ...c, index })) } : {}) }, finish_reason: choice.finish_reason }], usage: completion.usage })}\n\ndata: [DONE]\n\n`;
}
