import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunInspection, inspectionPath, readInspection, pruneInspections, inspectionLimits } from '../src/runtime/inspection.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const root = () => { const path = mkdtempSync(join(tmpdir(), 'inspection-')); roots.push(path); return path; };
it('excludes known credentials and sensitive fields before writing private diagnostic copies', () => {
  const directory = root(), capture = new RunInspection(directory, 'run', ['synthetic-run-credential']);
  capture.record('context', { text: 'synthetic-run-credential password=synthetic-password', authorization: 'Bearer synthetic', reasoning_content: 'hidden', image: 'data:image/png;base64,YWJj', tools: ['read'], access_token: 'synthetic-access', refreshToken: 'synthetic-refresh', 'api-key': 'synthetic-api', apiSecret: 'synthetic-secret' });
  const text = readFileSync(inspectionPath(directory, 'run'), 'utf8');
  expect(text).not.toContain('synthetic'); expect(text).not.toContain('hidden'); expect(text).not.toContain('YWJj');
  expect(readInspection(directory, 'run').records[0].payload.tools).toEqual(['read']);
  expect(statSync(inspectionPath(directory, 'run')).mode & 0o777).toBe(0o600);
  expect(() => inspectionPath(directory, '../owner-token')).toThrow();
});
it('marks capture loss and expires selected failures without deleting execution state', () => {
  const directory = root(), capture = new RunInspection(directory, 'run');
  capture.record('oversize', 'x'.repeat(inspectionLimits.runBytes)); capture.record('later', 'unavailable');
  expect(readInspection(directory, 'run').records.map(r => r.type)).toEqual(['capture.truncated']);
  const path = inspectionPath(directory, 'run'), old = new Date(Date.now() - 8 * 86400000);
  writeFileSync(`${path}.selected`, 'selected', { mode: 0o600 }); utimesSync(path, old, old);
  expect(readInspection(directory, 'run').available).toBe(true);
  pruneInspections(directory, Date.now() + 31 * 86400000);
  expect(readInspection(directory, 'run').available).toBe(false);
});

it('does not recreate a suffix after storage eviction of an active capture', () => {
  const directory = root(), capture = new RunInspection(directory, 'run');
  capture.record('run.context', { prompt: 'original' });
  unlinkSync(inspectionPath(directory, 'run'));
  capture.record('tool.finished', { result: 'later' });
  expect(readInspection(directory, 'run').available).toBe(false);
});
