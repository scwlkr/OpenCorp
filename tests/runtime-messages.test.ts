import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { normalizeAssistantTail } from '../src/runtime/messages.js';

describe('local assistant-prefill compatibility', () => {
  it('retains every text byte, duplicate and original message while joining only the final plain assistant tail', () => {
    const system = Object.freeze({ role: 'system', content: 'Scoped employee authority' });
    const user = Object.freeze({ role: 'user', content: 'Existing task' });
    const text = '  retained text\nΩ\n';
    const tail = [Object.freeze({ role: 'assistant', content: text }), Object.freeze({ role: 'assistant', content: text }), Object.freeze({ role: 'assistant', content: '' })];
    const messages = [system, user, ...tail];
    Object.freeze(messages);
    const result = normalizeAssistantTail(messages);
    expect(result.messages).toEqual([system, user, { role: 'assistant', content: `${text}\n\n${text}\n\n` }]);
    expect(result.messages[0]).toBe(system); expect(result.messages[1]).toBe(user);
    expect(messages).toEqual([system, user, ...tail]); expect(result.messages).not.toBe(messages);
    const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    expect(result.normalization).toEqual({ kind: 'plain_assistant_tail', firstIndex: 2, originalCount: 3, normalizedCount: 1,
      beforeSha256: digest(tail), afterSha256: digest(result.messages.slice(2)) });
    expect(JSON.stringify(result.normalization)).not.toContain('retained text');
  });

  it('keeps completed tool call/result pairs and earlier assistant turns exactly where they were', () => {
    const prefix = [
      { role: 'system', content: 'Original system' }, { role: 'user', content: 'Original request' },
      { role: 'assistant', content: 'Earlier turn' }, { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: 'Observed tool result' },
    ];
    const result = normalizeAssistantTail([...prefix, { role: 'assistant', content: 'First continuation' }, { role: 'assistant', content: 'Second continuation' }]);
    expect(result.messages.slice(0, prefix.length)).toEqual(prefix);
    expect(result.messages.at(-1)).toEqual({ role: 'assistant', content: 'First continuation\n\nSecond continuation' });
    expect(result.messages.filter(message => (message as { role: string }).role === 'user')).toEqual([prefix[1]]);
  });

  it.each([
    { content: [{ type: 'text', text: 'Multipart text' }] },
    { content: [{ type: 'image_url', image_url: { url: 'fixture' } }] },
    { content: null },
    { content: 'Calls', tool_calls: [{ id: 'call-1' }] },
    { content: 'Empty calls', tool_calls: [] },
    { content: 'Legacy call', function_call: { name: 'read', arguments: '{}' } },
    { content: 'Named speaker', name: 'other-assistant' },
    { content: 'Reasoned', reasoning_content: 'Retained reasoning' },
    { content: 'Signed', signature: 'retained-signature' },
    { content: 'Provider metadata', providerMetadata: {} },
    { content: 'Unknown field', unexpected: true },
  ])('leaves an entire mixed or complex assistant tail untouched: %j', extra => {
    for (const tail of [
      [{ role: 'assistant', ...extra }, { role: 'assistant', content: 'Plain' }, { role: 'assistant', content: 'Plain' }],
      [{ role: 'assistant', content: 'Plain' }, { role: 'assistant', ...extra }],
    ]) {
      const messages = [{ role: 'user', content: 'Task' }, ...tail];
      const result = normalizeAssistantTail(messages);
      expect(result.messages).toBe(messages); expect(result.normalization).toBeUndefined();
    }
  });

  it.each([
    [], [null], [{ role: 'assistant', content: 'Single prefill' }],
    [{ role: 'assistant', content: 'Earlier' }, { role: 'assistant', content: 'Earlier' }, { role: 'user', content: 'New task' }],
    [{ role: 'assistant', content: 'Earlier' }, { role: 'tool', tool_call_id: 'call-1', content: 'Result' }, { role: 'assistant', content: 'Single prefill' }],
  ])('does not rewrite a request without a consecutive assistant tail: %j', (...messages) => {
    const result = normalizeAssistantTail(messages);
    expect(result.messages).toBe(messages); expect(result.normalization).toBeUndefined();
  });
});
