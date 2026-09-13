import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { correctAction, expectedAction, nativeMetadata } from '../scripts/verify-nemotron-profile.js';

describe('Nemotron qualification correctness', () => {
  it('requires exact source attribution and bounded structured action', () => {
    expect(correctAction({ ...expectedAction })).toBe(true);
    expect(correctAction({ ...expectedAction, sourceId: 'guessed' })).toBe(false);
    expect(correctAction({ ...expectedAction, headcount: 100 })).toBe(false);
    expect(correctAction({ ...expectedAction, spending: 1 })).toBe(false);
    expect(correctAction({ ...expectedAction, extra: 'claim' })).toBe(false);
    expect(correctAction(null)).toBe(false);
  });
});

it('reports native durations and tool paths without reasoning or tool output text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nemotron-metadata-'));
  const path = join(root, 'native.db');
  const db = new Database(path);
  try {
    db.exec('CREATE TABLE message(session_id TEXT,data TEXT,time_created INTEGER); CREATE TABLE part(session_id TEXT,data TEXT,time_created INTEGER)');
    db.prepare('INSERT INTO message VALUES(?,?,?)').run('s', JSON.stringify({ role: 'assistant', agent: 'compaction', finish: 'length', tokens: { input: 24000, output: 4096 }, time: { created: 0, completed: 500 } }), 0);
    const insert = db.prepare('INSERT INTO part VALUES(?,?,?)');
    insert.run('s', JSON.stringify({ type: 'reasoning', text: 'PRIVATE_SENTINEL', time: { start: 10, end: 100 } }), 0);
    insert.run('s', JSON.stringify({ type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: '/fixture/source.json' }, output: 'PRIVATE_TOOL_OUTPUT' } }), 1);
    const result = nativeMetadata(path, 's');
    expect(result.reasoning).toEqual({ parts: 1, durationMs: 90 });
    expect(result.messages).toEqual([{ agent: 'compaction', finish: 'length', inputTokens: 24000, outputTokens: 4096, durationMs: 500 }]);
    expect(result.tools).toEqual([{ tool: 'read', status: 'completed', filePath: '/fixture/source.json' }]);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_/);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
