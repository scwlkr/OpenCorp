import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { OpencodeClient } from '@opencode-ai/sdk/v2';
import { captureFailureMessages } from '../src/runtime/evidence.js';
import { completeSession } from '../src/runtime/session.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'opencorp-failure-evidence-'));
  return { databasePath: join(root, 'opencode.db'), messagesPath: join(root, 'messages.json'), sessionId: 'bound-session' };
}
async function interruptedDatabase() {
  const paths = await fixture(), db = new Database(paths.databasePath);
  db.exec('CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,time_created INTEGER,data TEXT);');
  const insert = db.prepare('INSERT INTO message VALUES(?,?,?,?)');
  insert.run('initial-user', paths.sessionId, 1, JSON.stringify({ role: 'user', time: { created: 1 } }));
  insert.run('previous-length', paths.sessionId, 2, JSON.stringify({ role: 'assistant', finish: 'length', time: { created: 2, completed: 3 } }));
  insert.run('continuation-user', paths.sessionId, 4, JSON.stringify({ role: 'user', time: { created: 4 } }));
  insert.run('latest-incomplete', paths.sessionId, 5, JSON.stringify({ role: 'assistant', time: { created: 5 } }));
  db.prepare('INSERT INTO part VALUES(?,?,?,?,?)').run('latest-part', 'latest-incomplete', paths.sessionId, 5, JSON.stringify({ type: 'reasoning', text: 'fixture partial content' }));
  insert.run('unrelated-session', 'different-session', 6, JSON.stringify({ role: 'assistant', time: { completed: 6 } }));
  db.close(); return paths;
}

describe('failure provenance before runtime cleanup', () => {
  it('captures a first provider error even when the event check throws before reply polling', async () => {
    const paths = await fixture(); let admitted = false;
    const failed = { info: { id: 'errored-assistant', role: 'assistant', error: { name: 'APIError' }, time: { completed: 2 } }, parts: [] };
    const session = { promptAsync: vi.fn(async () => { admitted = true; }),
      messages: vi.fn(async () => ({ data: admitted ? [failed] : [] })), status: vi.fn() };
    const client = { session } as unknown as Pick<OpencodeClient, 'session'>;
    const onReply = vi.fn(async () => {});
    await expect(completeSession({ client, prompt: { sessionID: paths.sessionId, parts: [] }, signal: new AbortController().signal,
      check: () => { if (admitted) throw new Error('Provider error event before poll'); }, budget: () => ({ requests: 1, steps: 1 }), onReply })).rejects.toThrow('Provider error event');
    expect(onReply).not.toHaveBeenCalled();
    const result = await captureFailureMessages({ ...paths, client });
    expect(result.source).toBe('api');
    expect(JSON.parse(await readFile(paths.messagesPath, 'utf8'))[0].info.error.name).toBe('APIError');
  });

  it('snapshots the latest admitted incomplete continuation after cancellation, without a live server', async () => {
    const paths = await interruptedDatabase(), messages = vi.fn();
    const result = await captureFailureMessages({ ...paths, preferDatabase: true, client: { session: { messages } } as unknown as Pick<OpencodeClient, 'session'> });
    expect(messages).not.toHaveBeenCalled(); expect(result.source).toBe('database');
    expect(result.messages?.map(item => item.info.id)).toEqual(['initial-user', 'previous-length', 'continuation-user', 'latest-incomplete']);
    expect(result.messages?.at(-1)?.parts[0]).toMatchObject({ id: 'latest-part', messageID: 'latest-incomplete', type: 'reasoning' });
    expect(result.messages?.at(-1)?.info.time).not.toHaveProperty('completed');
  });

  it('bounds a hung diagnostic transport and falls back to retained database evidence', async () => {
    const paths = await interruptedDatabase(), messages = vi.fn(() => new Promise(() => {}));
    const began = Date.now();
    const result = await captureFailureMessages({ ...paths, timeoutMs: 20, client: { session: { messages } } as unknown as Pick<OpencodeClient, 'session'> });
    expect(result.source).toBe('database'); expect(Date.now() - began).toBeLessThan(1000);
    const options = (messages.mock.calls as unknown as Array<[unknown, { signal: AbortSignal }]>)[0][1];
    expect(options.signal.aborted).toBe(true);
  });

  it('does not fabricate a session or message artifact when neither was established', async () => {
    const paths = await fixture();
    expect(await captureFailureMessages({ ...paths, sessionId: undefined })).toEqual({ source: 'unavailable' });
    expect(await captureFailureMessages(paths)).toEqual({ source: 'unavailable' });
    await expect(readFile(paths.messagesPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

import { untouchedCapacityRefusal } from '../src/runtime/evidence.js';
it('requires a native capacity error and a complete empty first assistant turn, not zero usage alone',()=>{
 const cause={name:'APIError',data:{statusCode:400,responseBody:JSON.stringify({error:{code:'provider_capacity_wait'}})}};
 const error=new Error('Native error',{cause}),reply={info:{role:'assistant',error:cause},parts:[]} as any;
 expect(untouchedCapacityRefusal(error,[reply])).toBe(true);
 for(const messages of [undefined,[],[{...reply,parts:[{type:'text',text:'partial output'}]}],[{...reply,parts:[{type:'tool',state:{status:'pending'}}]}],[reply,reply]])expect(untouchedCapacityRefusal(error,messages as any)).toBe(false);
 expect(untouchedCapacityRefusal(error,[{...reply,info:{...reply.info,error:{name:'APIError',data:{statusCode:403}}}}])).toBe(false);
 expect(untouchedCapacityRefusal(new Error('Unrelated cleanup failure'),[reply])).toBe(false);
 expect(untouchedCapacityRefusal(new Error('Other provider error',{cause:{...cause,data:{...cause.data,responseBody:'{}'}}}),[reply])).toBe(false);
});
