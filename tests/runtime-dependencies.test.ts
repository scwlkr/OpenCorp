import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { validateDependencyUrl, npmArtifacts, rubyArtifacts, prepareProductDependencies, validateAdvisoryQuery, validateBrowserArtifactUrl } from '../src/tools/dependencies.js';

function archive(files: Record<string, string>): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, contents] of Object.entries(files)) {
    const content = Buffer.from(contents), header = Buffer.alloc(512);
    header.write(`package/${name}`); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(content.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136);
    header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263);
    header.write(header.reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    chunks.push(header, content, Buffer.alloc((512 - content.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

describe('public dependency boundary', () => {
  it('accepts only noauth exact public artifact endpoints', () => {
    expect(validateDependencyUrl('https://registry.npmjs.org/@scope/thing/-/thing-1.0.0.tgz').hostname).toBe('registry.npmjs.org');
    expect(validateDependencyUrl('https://rubygems.org/downloads/rails-8.1.2.gem').hostname).toBe('rubygems.org');
    for (const url of ['https://registry.npmjs.org/-/user', 'https://registry.npmjs.org/pkg/-/x.tgz?token=secret', 'https://user:password@rubygems.org/downloads/x.gem', 'http://127.0.0.1/downloads/x.gem', 'https://rubygems.org.evil.test/downloads/x.gem']) expect(() => validateDependencyUrl(url)).toThrow();
  });
  it('rejects git/local/unlocked dependencies and Ruby sources without checksums', () => {
    expect(() => npmArtifacts(JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/a': { resolved: 'file:../outside' } } }))).toThrow();
    expect(() => rubyArtifacts('GIT\n  remote: https://example.com/repo.git\n')).toThrow();
    expect(() => rubyArtifacts('GEM\n  remote: https://rubygems.org/\n')).toThrow('checksums');
  });
  it('bounds public advisory payloads and browser redirect destinations', () => {
    expect(validateAdvisoryQuery({ 'chroma-js': ['2.4.2'], '@scope/package': ['1.2.3-beta.1'] })).toHaveProperty('chroma-js');
    for (const query of [{ secret: ['not-a-version'] }, { 'https://owner.test': ['1.2.3'] }, { package: '1.2.3' }, { package: [] }]) expect(() => validateAdvisoryQuery(query)).toThrow();
    expect(validateBrowserArtifactUrl('https://storage.googleapis.com/chrome-for-testing-public/149.0.7827.55/mac-arm64/chrome-mac-arm64.zip').hostname).toBe('storage.googleapis.com');
    for (const url of ['https://127.0.0.1/browser.zip', 'https://storage.googleapis.com/private-bucket/secret', 'https://cdn.playwright.dev/builds/cft/unexpected/149.0.7827.55/mac-arm64/chrome-mac-arm64.zip']) expect(() => validateBrowserArtifactUrl(url)).toThrow();
  });
  it.skipIf(process.platform !== 'darwin').each(['OpenJob','Additional product'])('installs %s from integrity cache offline and confines actual package install scripts', async (productName) => {
    const root = await mkdtemp(join(homedir(), '.local/share/opencorp-dependency-test-'));
    const workspace = join(root, 'workspaces/openjob'); await mkdir(join(workspace, 'native'), { recursive: true });
    const protectedFile = join(root, 'owner-sentinel'); await writeFile(protectedFile, 'preserved');
    const script = `const fs=require('fs');try{fs.writeFileSync(${JSON.stringify(protectedFile)},'escaped');process.exit(7)}catch{}fs.writeFileSync('installed-proof.txt',process.version)`;
    const bytes = archive({ 'package.json': JSON.stringify({ name: 'opencorp-dependency-fixture', version: '1.0.0', scripts: { postinstall: 'node install.cjs' } }), 'install.cjs': script, 'index.js': 'module.exports = 42;\n' });
    // The lifecycle script is a real untrusted npm child; only artifact transport
    // is a fixture. No hosted registry or inference is contacted by this test.
    const transport = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array(bytes)));
    const packageJson = { name: 'fixture-parent', version: '1.0.0', dependencies: { 'opencorp-dependency-fixture': '1.0.0' }, scripts: { postinstall: 'npm --prefix native ci' } };
    await writeFile(join(workspace, 'package.json'), JSON.stringify(packageJson));
    await writeFile(join(workspace, 'package-lock.json'), JSON.stringify({ name: 'fixture-parent', version: '1.0.0', lockfileVersion: 3, packages: { '': packageJson, 'node_modules/opencorp-dependency-fixture': { version: '1.0.0', resolved: 'https://registry.npmjs.org/opencorp-dependency-fixture/-/opencorp-dependency-fixture-1.0.0.tgz', integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, hasInstallScript: true } } }));
    await writeFile(join(workspace, 'native/package.json'), '{"name":"fixture-native","version":"1.0.0"}');
    await writeFile(join(workspace, 'native/package-lock.json'), '{"name":"fixture-native","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"fixture-native","version":"1.0.0"}}}');
    try {
      const result = await prepareProductDependencies({ productName, workspace, dataRoot: root });
      expect(result.installed, JSON.stringify(result.checks)).toBe(true);
      expect(result.incrementalCost).toBe(0);
      expect(await readFile(protectedFile, 'utf8')).toBe('preserved');
      expect(await readFile(join(workspace, 'node_modules/opencorp-dependency-fixture/installed-proof.txt'), 'utf8')).toBe('v22.22.3');
      expect(transport).toHaveBeenCalledTimes(1);
    } finally { transport.mockRestore(); }
  }, 30000);
});
