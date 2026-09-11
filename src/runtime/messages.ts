import { createHash } from 'node:crypto';

type PlainAssistant = { role: 'assistant'; content: string };

function assistant(message: unknown): message is Record<string, unknown> & { role: 'assistant' } {
  return !!message && typeof message === 'object' && !Array.isArray(message)
    && (message as Record<string, unknown>).role === 'assistant';
}

/** Adapt the outbound prefill only; native history and non-text message fields are never rewritten. */
export function normalizeAssistantTail(messages: unknown[]): {
  messages: unknown[];
  normalization?: { kind: 'plain_assistant_tail'; firstIndex: number; originalCount: number; normalizedCount: number; beforeSha256: string; afterSha256: string };
} {
  let firstIndex = messages.length;
  while (firstIndex > 0 && assistant(messages[firstIndex - 1])) firstIndex--;
  const tail = messages.slice(firstIndex);
  if (tail.length < 2 || !tail.every(message => assistant(message) && typeof message.content === 'string'
    && Object.keys(message).every(key => key === 'role' || key === 'content'))) return { messages };

  // Pinned OpenCode preserves separate assistant turns after an unknown finish.
  // Ollama's assistant-prefill template rejects two trailing assistant messages.
  // Keep every text byte (including duplicates), separated without inventing a role.
  // A text-part array is insufficient: Ollama expands each part into a message.
  // https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/session/message-v2.ts
  // https://github.com/ollama/ollama/blob/v0.32.13/openai/openai.go#L511
  const combined: PlainAssistant = { role: 'assistant', content: (tail as PlainAssistant[]).map(message => message.content).join('\n\n') };
  const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return {
    messages: [...messages.slice(0, firstIndex), combined],
    normalization: { kind: 'plain_assistant_tail', firstIndex, originalCount: tail.length, normalizedCount: 1,
      beforeSha256: digest(tail), afterSha256: digest([combined]) },
  };
}
