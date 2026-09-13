import Database from 'better-sqlite3';
import { isDeepStrictEqual } from 'node:util';
import { writeFile } from 'node:fs/promises';
import type { OpencodeClient, SessionMessagesResponse2 } from '@opencode-ai/sdk/v2';

/** Diagnostic reads use their own short deadline. The worker may already be
 * stopping; a read-only SQLite snapshot retains its latest admitted messages. */
export async function captureFailureMessages(options: {
  client?: Pick<OpencodeClient, 'session'>; sessionId?: string;
  databasePath: string; messagesPath: string; preferDatabase?: boolean; timeoutMs?: number;
}): Promise<{ messages?: SessionMessagesResponse2; messagesPath?: string; source: 'api' | 'database' | 'unavailable' }> {
  if (!options.sessionId) return { source: 'unavailable' };
  let messages: SessionMessagesResponse2 | undefined;
  let source: 'api' | 'database' | 'unavailable' = 'unavailable';
  if (options.client && !options.preferDatabase) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        options.client.session.messages({ sessionID: options.sessionId }, { signal: controller.signal }),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Diagnostic read deadline')); }, options.timeoutMs ?? 1500); }),
      ]);
      if (Array.isArray(response.data)) { messages = response.data; source = 'api'; }
    } catch { /* Server shutdown must not discard the owned database evidence. */ }
    finally { clearTimeout(timer); controller.abort(); }
  }
  if (!messages) {
    let db: Database.Database | undefined;
    try {
      db = new Database(options.databasePath, { readonly: true, fileMustExist: true, timeout: 100 });
      const database = db;
      messages = database.transaction(() => {
        const rows = database.prepare('SELECT id,session_id,data FROM message WHERE session_id=? ORDER BY time_created,id').all(options.sessionId) as Array<{ id: string; session_id: string; data: string }>;
        return rows.map(row => ({ info: { ...JSON.parse(row.data), id: row.id, sessionID: row.session_id },
          parts: (database.prepare('SELECT id,data FROM part WHERE message_id=? AND session_id=? ORDER BY time_created,id').all(row.id, options.sessionId) as Array<{ id: string; data: string }>)
            .map(part => ({ ...JSON.parse(part.data), id: part.id, messageID: row.id, sessionID: row.session_id })) }));
      })();
      source = 'database';
    } catch { /* No session/messages are invented when neither source is available. */ }
    finally { db?.close(); }
  }
  if (!messages) return { source: 'unavailable' };
  await writeFile(options.messagesPath, JSON.stringify(messages, null, 2), { mode: 0o600 });
  return { messages, messagesPath: options.messagesPath, source };
}

/** A typed gateway refusal is retryable as untouched only with a complete,
 * empty first assistant turn. Token counters alone cannot prove no output. */
export function untouchedCapacityRefusal(error: unknown, messages?: SessionMessagesResponse2): boolean {
  const cause = error instanceof Error ? error.cause as { name?: string; data?: { statusCode?: number; responseBody?: string } } | undefined : undefined;
  if (cause?.name !== 'APIError' || cause.data?.statusCode !== 400 || !messages?.length) return false;
  try { if (JSON.parse(cause.data.responseBody ?? '').error?.code !== 'provider_capacity_wait') return false; } catch { return false; }
  const assistants = messages.filter(item => item.info.role === 'assistant');
  return assistants.length === 1 && assistants[0].info.role === 'assistant' && isDeepStrictEqual(assistants[0].info.error, cause)
    && assistants[0].parts.length === 0 && !messages.some(item => item.parts.some(part => part.type === 'tool'));
}
