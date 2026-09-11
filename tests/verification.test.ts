import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { canonicalVerification } from '../src/tools/verification.js';
const roots: string[] = [];
function workflow(version: string) {
  const root = mkdtempSync(join(tmpdir(), 'opencorp-verifier-')); roots.push(root);
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  writeFileSync(join(root, '.github/workflows/ci.yml'), `jobs:\n  test:\n    env:\n      WALK_RELEASE_VERSION: ${JSON.stringify(version)}\n`);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
test('WalkLang verification carries canonical version through checks and packaging', () => {
  const command = canonicalVerification('WalkLang', workflow('v6.3.3'));
  expect(command).toContain("export WALK_VERSION='v6.3.3'");
  expect(command).toContain('make conformance');
  expect(command).toContain('make release VERSION="$WALK_VERSION" OUT=dist');
});
test('repository version cannot inject broker shell syntax', () => {
  expect(() => canonicalVerification('WalkLang', workflow('v1.0.0; touch /tmp/escape'))).toThrow(/concrete WALK_RELEASE_VERSION/);
});

test('OpenJob merge verification uses the actual immutable base and rejects missing or injectable refs', () => {
  const base = 'a'.repeat(40);
  expect(canonicalVerification('OpenJob', '/owned/workspace', base)).toBe(`npm run verify -- merge --base '${base}'`);
  expect(() => canonicalVerification('OpenJob', '/owned/workspace')).toThrow(/recorded project base/);
  expect(() => canonicalVerification('OpenJob', '/owned/workspace', 'main; touch /tmp/escape')).toThrow(/recorded project base/);
});
