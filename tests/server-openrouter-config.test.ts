import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openRouterFreeConfig } from '../src/server/openrouter-config.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'opencorp-free-config-')); roots.push(root);
  const directory = join(root, 'credentials'); mkdirSync(directory, { mode: 0o700 });
  const config = join(directory, 'openrouter-free.json'), key = join(directory, 'openrouter-free.key');
  writeFileSync(config, JSON.stringify({ noByokVerified: true, verifiedAt: '2026-09-12T00:00:00Z', evidence: 'Fixture workspace has no configured BYOK providers.' }), { mode: 0o600 });
  return { root, directory, config, key };
}
it('keeps missing optional configuration local-only', () => {
  const f = fixture(); rmSync(f.config); expect(openRouterFreeConfig(f.root, [])).toBeUndefined();
});
it('does not read the key until requested and retains callback for an empty initial allowlist', async () => {
  const f = fixture(); const config = openRouterFreeConfig(f.root, []);
  expect(config).toMatchObject({ modelIds: [], noByokVerified: true, rateBudgetPath:join(f.root,'runtime','provider-rate-budgets','openrouter.json') });
  expect(JSON.stringify(config)).not.toContain('readApiKey');
  await expect(config!.readApiKey()).rejects.toThrow('private credential unavailable');
  writeFileSync(f.key, 'fixture-secret\n', { mode: 0o600 });
  expect(await config!.readApiKey()).toBe('fixture-secret');
  expect(JSON.stringify(config)).not.toContain('fixture-secret');
});
it.each(['directory-mode', 'config-mode', 'config-link', 'directory-link'])('rejects unsafe %s without exposing contents', kind => {
  const f = fixture();
  if (kind === 'directory-mode') chmodSync(f.directory, 0o755);
  if (kind === 'config-mode') chmodSync(f.config, 0o644);
  if (kind === 'config-link') { const target = join(f.root, 'audit'); writeFileSync(target, 'PRIVATE', { mode: 0o600 }); rmSync(f.config); symlinkSync(target, f.config); }
  if (kind === 'directory-link') { const target = join(f.root, 'elsewhere'); mkdirSync(target, { mode: 0o700 }); writeFileSync(join(target, 'openrouter-free.json'), 'PRIVATE', { mode: 0o600 }); rmSync(f.directory, { recursive: true }); symlinkSync(target, f.directory); }
  expect(() => openRouterFreeConfig(f.root, [])).toThrow('private regular JSON file');
});
it.each(['mode', 'symlink', 'empty', 'multiline'])('rejects unsafe key %s only inside the parent callback', async kind => {
  const f = fixture(); writeFileSync(f.key, kind === 'empty' ? '' : kind === 'multiline' ? 'a\nb' : 'fixture-secret', { mode: kind === 'mode' ? 0o644 : 0o600 });
  if (kind === 'symlink') { rmSync(f.key); const target = join(f.root, 'other'); writeFileSync(target, 'fixture-secret', { mode: 0o600 }); symlinkSync(target, f.key); }
  const config = openRouterFreeConfig(f.root, []);
  await expect(config!.readApiKey()).rejects.toThrow('OpenRouter private credential unavailable');
});
it('requires an explicit dated audit, not merely a true flag or a supplied key path', () => {
  const f = fixture();
  for (const record of [{ noByokVerified: true }, { noByokVerified: false, verifiedAt: '2026-09-12', evidence: 'x' },
    { noByokVerified: true, verifiedAt: '2026-09-12', evidence: 'x', keyPath: '/other' }]) {
    writeFileSync(f.config, JSON.stringify(record)); expect(() => openRouterFreeConfig(f.root, [])).toThrow('explicit dated');
  }
});
it('copies exact Owner allowlist rather than retaining mutable caller state', () => {
  const f = fixture(), ids = ['nvidia/nemotron-3.5-lightning:free'];
  const config = openRouterFreeConfig(f.root, ids); ids.push('paid/model'); expect(config!.modelIds).toHaveLength(1);
  expect(() => openRouterFreeConfig(f.root, ids)).toThrow('exact Owner-allowlisted');
});
