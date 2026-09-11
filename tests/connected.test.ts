import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { runInNewContext } from 'node:vm';
import { ConnectedTools, browserRequestPolicy, fetchPublic, publicUrl, type ConnectedScope } from '../src/tools/connected.js';

let root: string, workspace: string, tools: ConnectedTools, scope: ConnectedScope, controller: AbortController, active: boolean;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'opencorp-connected-'))); workspace = join(root, 'workspaces', 'product');
  mkdirSync(join(workspace, 'site'), { recursive: true });
  writeFileSync(join(workspace, 'site', 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1>Actual product docs</h1><script>document.body.textContent="UNSAFE"</script></body></html>');
  writeFileSync(join(workspace, 'site', 'style.css'), 'body { color: #123456; }');
  writeFileSync(join(workspace, 'site', 'script.js'), 'fetch("http://127.0.0.1:4310")');
  writeFileSync(join(workspace, 'site', '.env'), 'DO_NOT_EXPOSE=secret');
  writeFileSync(join(workspace, 'site', 'credentials.txt'), 'DO_NOT_EXPOSE=secret');
  controller = new AbortController(); active = true;
  scope = { runId: 'run-product', workspace, assertActive: () => { if (!active) throw new Error('Company is paused'); }, signal: controller.signal };
  tools = new ConnectedTools(root);
});
afterEach(async () => { await tools.close(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

function http(url: string, path: string, options: { method?: string; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; body: string; headers: Record<string, any> }>((resolve, reject) => {
    const req = request(new URL(url).origin, { path, method: options.method, headers: options.headers }, response => {
      let body = ''; response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, body, headers: response.headers }));
    }); req.on('error', reject); req.end();
  });
}

describe('scoped static application previews', () => {
  it('serves observed static bytes with script/network restrictions and a reproducible digest', async () => {
    const preview = await tools.preparePreview(scope, { path: 'site' });
    const document = await http(preview.url, '/index.html'), style = await http(preview.url, '/style.css');
    expect(new URL(preview.url).hostname).toBe('127.0.0.1'); expect(preview.files).toBe(2); expect(preview.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(document.status).toBe(200); expect(document.body).toContain('Actual product docs'); expect(style.body).toContain('#123456');
    expect(document.headers['content-security-policy']).toContain("script-src 'none'"); expect(document.headers['content-security-policy']).toContain("connect-src 'none'");
    expect(document.headers['content-security-policy']).toContain("form-action 'none'"); expect(document.headers['cache-control']).toBe('no-store');
    const head = await http(preview.url, '/index.html', { method: 'HEAD' }); expect(head.status).toBe(200); expect(head.body).toBe(''); expect(Number(head.headers['content-length'])).toBe(Buffer.byteLength(document.body));
    const again = await tools.preparePreview(scope, { path: 'site' }); expect(again.digest).toBe(preview.digest); expect(again.previewId).not.toBe(preview.previewId);
    await expect(fetch(preview.url)).rejects.toThrow();
  });
  it('denies secrets, scripts, traversal, writes, unrelated hosts and origins', async () => {
    const preview = await tools.preparePreview(scope, { path: 'site' });
    for (const path of ['/.env', '/credentials.txt', '/../company.sqlite', '/%2e%2e/company.sqlite', '/%00', '/%5c..%5ccompany.sqlite', '/%']) expect((await http(preview.url, path)).status).toBe(403);
    expect((await http(preview.url, '/script.js')).status).toBe(404);
    expect((await http(preview.url, '/', { method: 'POST' })).status).toBe(405);
    expect((await http(preview.url, '/', { headers: { Host: 'evil.example' } })).status).toBe(403);
    expect((await http(preview.url, '/', { headers: { Origin: 'http://127.0.0.1:4310' } })).status).toBe(403);
  });
  it('does not follow symlinks or hard links into credential-bearing files', async () => {
    const outside = join(root, 'owner-secret.html'); writeFileSync(outside, 'PRIVATE OWNER DATA');
    symlinkSync(outside, join(workspace, 'site', 'linked.html'));
    await expect(tools.preparePreview(scope, { path: 'site' })).rejects.toThrow(/Symlinks/);
    rmSync(join(workspace, 'site', 'linked.html')); linkSync(outside, join(workspace, 'site', 'linked.html'));
    await expect(tools.preparePreview(scope, { path: 'site' })).rejects.toThrow(/hard links/);
    await expect(tools.preparePreview(scope, { path: '../..' })).rejects.toThrow(/traversal/);
    await expect(tools.preparePreview(scope, { path: '/tmp' })).rejects.toThrow(/relative path/);
  });
  it('keeps a static snapshot after source mutation and closes on abort or finish', async () => {
    const preview = await tools.preparePreview(scope, { path: 'site' });
    rmSync(join(workspace, 'site', 'index.html')); symlinkSync('/etc/passwd', join(workspace, 'site', 'index.html'));
    expect((await http(preview.url, '/')).body).toContain('Actual product docs');
    active = false; expect((await http(preview.url, '/')).status).toBe(403);
    active = true; controller.abort(); await tools.closeRun(scope.runId);
    await expect(fetch(preview.url)).rejects.toThrow();
    await expect(tools.preparePreview({ ...scope, signal: undefined }, { path: 'site' })).rejects.toThrow(/ended/);
  });
  it('rejects concurrent rebuilds and oversized output before starting a server', async () => {
    const first = tools.preparePreview(scope, { path: 'site' });
    await expect(tools.preparePreview(scope, { path: 'site' })).rejects.toThrow(/already preparing/); await first;
    writeFileSync(join(workspace, 'site', 'too-large.txt'), Buffer.alloc(8 * 1024 * 1024 + 1));
    await expect(tools.preparePreview(scope, { path: 'site' })).rejects.toThrow(/8 MiB/);
  });
});

describe('connected tool authority', () => {
  it('allows only the same run to navigate its exact owned preview and retains the public allowlist', async () => {
    const callTool = vi.fn(async () => ({ content: [] })); vi.spyOn(tools as any, 'browserClient').mockResolvedValue({ callTool });
    const preview = await tools.preparePreview(scope, { path: 'site' });
    await tools.macos('open_preview', { previewId: preview.previewId }, scope);
    expect((callTool.mock.calls as any)[0][0]).toMatchObject({ name: 'browser_navigate', arguments: { url: preview.url } });
    await tools.browserTool('browser_navigate', { url: 'https://developer.mozilla.org/en-US/' }, scope);
    await tools.browserTool('browser_click', { element: 'Product docs', ref: 'e9' }, scope);
    expect((callTool.mock.calls as any)[2][0].arguments).toEqual({ element: 'Product docs', target: 'e9' });
    await expect(tools.browserTool('browser_navigate', { url: 'http://127.0.0.1:4310' }, scope)).rejects.toThrow(/configured free/);
    const stranger = { ...scope, runId: 'other-run' };
    await expect(tools.browserTool('browser_navigate', { url: preview.url }, stranger)).rejects.toThrow(/configured free/);
    await expect(tools.macos('open_preview', { previewId: preview.previewId }, stranger)).rejects.toThrow(/this employee run/);
    for (const url of ['https://example.com/', 'https://github.com:8443/', 'https://user:password@github.com/', 'file:///etc/passwd', 'https://github.com.evil.example']) expect(() => publicUrl(url)).toThrow();
  });
  it('refuses arbitrary scripts, screenshot/snapshot paths and browser UI escape keys', async () => {
    for (const name of ['browser_evaluate', 'browser_run_code', 'browser_file_upload']) await expect(tools.browserTool(name, {}, scope)).rejects.toThrow(/inspection tools/);
    for (const name of ['browser_snapshot', 'browser_take_screenshot']) await expect(tools.browserTool(name, { filename: '/tmp/outside' }, scope)).rejects.toThrow(/broker-controlled/);
    await expect(tools.browserTool('browser_press_key', { key: 'Meta+O' }, scope)).rejects.toThrow(/navigation keys/);
    await expect(tools.macos('execute_script', { script_content: 'BAD' }, scope)).rejects.toThrow(/Arbitrary scripts/);
  });
  it('reveals only a validated product path through a fixed, safely encoded JXA program', async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'Revealed assigned product path' }] })); vi.spyOn(tools as any, 'macClient').mockResolvedValue({ callTool });
    const name = 'quote"; throw new Error("bad").html'; writeFileSync(join(workspace, 'site', name), 'Product');
    await tools.macos('reveal_path', { path: `site/${name}` }, scope);
    const args = (callTool.mock.calls as any)[0][0].arguments;
    expect(args.language).toBe('javascript'); expect(args.script_content).toContain(`Path(${JSON.stringify(join(workspace, 'site', name))})`);
    expect(args.timeout_seconds).toBe(10);
    await expect(tools.macos('reveal_path', { path: '../owner-secret.html' }, scope)).rejects.toThrow(/traversal/);
    await expect(tools.macos('reveal_path', { path: 'site/.env' }, scope)).rejects.toThrow(/credential/);
    await expect(tools.macos('reveal_path', { path: '.' })).rejects.toThrow(/assigned product/);
    expect(callTool).toHaveBeenCalledTimes(1);
  });
  it('rechecks pause after connection startup before dispatching a native action', async () => {
    let complete!: (value: unknown) => void;
    const callTool = vi.fn(); vi.spyOn(tools as any, 'macClient').mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const action = tools.macos('reveal_path', { path: 'site/index.html' }, scope);
    active = false; complete({ callTool });
    await expect(action).rejects.toThrow(/paused/); expect(callTool).not.toHaveBeenCalled();
  });
});

it('the real browser policy blocks unchecked redirects/localhost/writes and strips credentials', async () => {
  const exports: any = {}; runInNewContext(browserRequestPolicy(['http://127.0.0.1:12345']), { exports, URL });
  let routeHandler!: (route: any) => Promise<unknown>;
  const context: any = { route: async (_: string, handle: any) => { routeHandler = handle; }, routeWebSocket: vi.fn(), on: vi.fn() };
  await exports.default({ page: { context: () => context, on: vi.fn() } });
  async function route(url: string, method = 'GET', location?: string) {
    const mock: any = {
      request: () => ({ url: () => url, method: () => method, headers: () => ({ cookie: 'owner', authorization: 'secret', accept: 'text/html' }) }),
      abort: vi.fn(), fulfill: vi.fn(), fetch: vi.fn(async () => ({ headers: () => ({ ...(location ? { location } : {}), 'set-cookie': 'session=secret' }) })),
    };
    await routeHandler(mock); return mock;
  }
  const permitted = await route('http://127.0.0.1:12345/index.html'); expect(permitted.fulfill).toHaveBeenCalledOnce();
  expect(permitted.fetch.mock.calls[0][0].headers).toEqual({ accept: 'text/html' }); expect(permitted.fulfill.mock.calls[0][0].headers['set-cookie']).toBeUndefined();
  for (const url of ['http://127.0.0.1:4310', 'file:///etc/passwd', 'https://evil.example', 'https://github.com:8443']) expect((await route(url)).fetch).not.toHaveBeenCalled();
  expect((await route('https://github.com/', 'POST')).fetch).not.toHaveBeenCalled();
  const redirect = await route('https://github.com/', 'GET', 'http://127.0.0.1:4310'); expect(redirect.abort).toHaveBeenCalledOnce(); expect(redirect.fulfill).not.toHaveBeenCalled();
  expect(permitted.fetch.mock.calls[0][0].maxRedirects).toBe(0); expect(context.routeWebSocket).toHaveBeenCalledOnce();
  const previewExports: any = {};
  runInNewContext(browserRequestPolicy(['http://127.0.0.1:12345'], false), { exports: previewExports, URL });
  delete context.__openCorpPolicy;
  await previewExports.default({ page: { context: () => context, on: vi.fn() } });
  expect((await route('https://github.com/')).fetch).not.toHaveBeenCalled();
  expect((await route('http://127.0.0.1:12345/style.css')).fulfill).toHaveBeenCalledOnce();
});

it('pages public source with a 6,000 character default, 12,000 maximum and an explicit unread tail', async () => {
  const source = 'a'.repeat(7000) + 'b'.repeat(150000);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(source, { headers: { 'Content-Type': 'text/plain' } }));
  const first = await fetchPublic('https://developer.mozilla.org/docs');
  expect(first.content).toHaveLength(6000); expect(first.nextOffset).toBe(6000); expect(first.observedBytes).toBe(100000);
  expect(first.sourceTruncated).toBe(true); expect(first.limitation).toContain('unobserved tail');
  const next = await fetchPublic('https://developer.mozilla.org/docs', { offset: 6000, limit: 20000 });
  expect(next.content).toBe('a'.repeat(1000) + 'b'.repeat(11000)); expect(next.limit).toBe(12000);
  const tail = await fetchPublic('https://developer.mozilla.org/docs', { offset: 99000, limit: 12000 });
  expect(tail.content).toHaveLength(1000); expect(tail.hasMore).toBe(false); expect(tail.nextOffset).toBeNull(); expect(tail.sourceTruncated).toBe(true);
});

it('does not label an entirely observed public response complete when its returned page is partial', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('unicode café '.repeat(1000), { headers: { 'Content-Type': 'text/plain' } }));
  const result = await fetchPublic('https://github.com/docs');
  expect(result.sourceTruncated).toBe(false); expect(result.truncated).toBe(true); expect(result.hasMore).toBe(true);
  const complete = await fetchPublic('https://github.com/docs', { limit: 12000 });
  expect(complete.truncated).toBe(true); // 13,000 observed characters need another page.
  await expect(fetchPublic('https://github.com/docs', { offset: -1 })).rejects.toThrow(/non-negative/);
});
