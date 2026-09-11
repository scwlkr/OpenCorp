import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { sourceRoot } from '../server/paths.js';
import { brokerEnvironment } from './process.js';
import { safeChild } from './workspaces.js';
import { DomainError } from '../core/types.js';

export const researchHosts = ['github.com', 'raw.githubusercontent.com', 'docs.github.com', 'developer.mozilla.org', 'nodejs.org', 'www.typescriptlang.org', 'react.dev', 'vite.dev', 'guides.rubyonrails.org', 'api.rubyonrails.org', 'rubygems.org', 'registry.npmjs.org', 'www.npmjs.com', 'docs.ollama.com', 'opencode.ai', 'walklang.wlkrlabs.com'];
export function publicUrl(input: string, extraHosts: string[] = []): URL {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || ![...researchHosts, ...extraHosts].includes(url.hostname)) throw new DomainError('network_denied', 'Only configured free public research/product HTTPS endpoints are allowed.', 403);
  return url;
}
export async function fetchPublic(input: string, options: { offset?: number; limit?: number } = {}) {
  const offset = options.offset ?? 0, requestedLimit = options.limit ?? 6000;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(requestedLimit) || requestedLimit < 1) throw new DomainError('invalid_page', 'Use a non-negative character offset and a positive integer limit.');
  const limit = Math.min(requestedLimit, 12000);
  let url = publicUrl(input);
  for (let redirects = 0; redirects < 5; redirects++) {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000), headers: { Accept: 'text/plain,text/html,application/json' } });
    if (response.status >= 300 && response.status < 400) { url = publicUrl(new URL(response.headers.get('location') ?? '', url).href); continue; }
    if (!response.ok) throw new Error(`Public fetch returned ${response.status}`);
    const contentType = response.headers.get('content-type') ?? '';
    if (!/text|json|xml/.test(contentType)) throw new Error('Use the browser adapter for non-text public content.');
    const reader = response.body!.getReader(), decoder = new TextDecoder();
    let size = 0, text = '', sourceTruncated = false;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        const remaining = 100_000 - size, included = chunk.value.subarray(0, remaining);
        size += included.length; text += decoder.decode(included, { stream: true });
        if (included.length < chunk.value.length) { sourceTruncated = true; break; }
      }
    } finally { await reader.cancel(); }
    text += decoder.decode();
    const content = text.slice(offset, offset + limit), hasMore = offset + content.length < text.length;
    return { url: url.href, content, offset, limit, nextOffset: hasMore ? offset + content.length : null, hasMore,
      observedCharacters: text.length, observedBytes: size, sourceTruncated,
      truncated: offset > 0 || hasMore || sourceTruncated,
      ...(sourceTruncated ? { limitation: 'Only the first 100,000 response bytes were observed. Paging cannot retrieve the unobserved tail; no claim of complete source content.' } : {}),
    };
  }
  throw new Error('Too many public redirects.');
}

/** Supplied by the broker, never taken from model arguments. */
export interface ConnectedScope {
  runId: string;
  workspace: string;
  assertActive: () => void;
  signal?: AbortSignal;
}
export interface PreviewReceipt {
  previewId: string;
  url: string;
  files: number;
  bytes: number;
  digest: string;
}
type Preview = PreviewReceipt & { runId: string; origin: string; server: Server };
type BoundRun = { scope: ConnectedScope; controller: AbortController; unbind: () => void };
const staticTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};
const blockedName = /^(?:\.|node_modules$|vendor$|credentials?(?:[._-]|$)|secrets?(?:[._-]|$)|id_(?:rsa|ed25519)(?:\.|$))/i;
// CSP blocks document scripts; an HTML sandbox without allow-scripts would also
// stall Playwright MCP's privileged post-action timer after ordinary link clicks.
const csp = "default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";
const hasControl = (text: string) => [...text].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

function relativePath(input: unknown, allowRoot = false): string {
  if (typeof input !== 'string' || !input || isAbsolute(input) || input.includes('\\') || hasControl(input)) throw new DomainError('path_denied', 'Use a relative path inside the assigned product workspace.', 403);
  if (allowRoot && input === '.') return input;
  if (input.split('/').some(part => !part || part === '..' || blockedName.test(part))) throw new DomainError('path_denied', 'Hidden, credential, dependency, and traversal paths are unavailable.', 403);
  return input;
}
function workspacePath(workspace: string, input: unknown, allowRoot = false): string {
  const child = relativePath(input, allowRoot), base = realpathSync(workspace), candidate = resolve(workspace, child);
  // Check lexical ancestry before realpath, and reject every symlink, including
  // links whose destination happens to remain inside the workspace.
  const lexical = relative(resolve(workspace), candidate);
  if (lexical.startsWith('..') || isAbsolute(lexical) || lstatSync(workspace).isSymbolicLink()) throw new DomainError('path_denied', 'Path is outside the assigned workspace.', 403);
  let cursor = base;
  for (const component of lexical.split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    if (lstatSync(cursor).isSymbolicLink()) throw new DomainError('symlink_denied', 'Symlinks are not exposed through application tools.', 403);
  }
  return safeChild(base, candidate);
}
function snapshotStatic(workspace: string, directory: string) {
  workspace = realpathSync(workspace);
  const files = new Map<string, { bytes: Buffer; contentType: string }>();
  let bytes = 0, visited = 0;
  function visit(path: string, name: string) {
    if (++visited > 2000) throw new DomainError('preview_too_large', 'Choose a built static directory with at most 2,000 entries.');
    const current = workspacePath(workspace, relative(workspace, path).split(sep).join('/') || '.', true), stat = lstatSync(current);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(current).sort()) {
        if (blockedName.test(entry)) continue;
        visit(join(current, entry), name ? `${name}/${entry}` : entry);
      }
      return;
    }
    const contentType = staticTypes[extname(current).toLowerCase()];
    if (!contentType) return;
    if (!stat.isFile() || stat.nlink !== 1) throw new DomainError('preview_file_denied', 'Preview files must be ordinary files without hard links.', 403);
    if (stat.size > 8 * 1024 * 1024 || bytes + stat.size > 32 * 1024 * 1024 || files.size >= 500) throw new DomainError('preview_too_large', 'Preview supports at most 500 static files, 8 MiB per file, 32 MiB total.');
    const fd = openSync(current, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const observed = fstatSync(fd);
      // Verify the descriptor before reading bytes: replacing a parent with a
      // symlink during traversal must not make an outside file readable.
      if (workspacePath(workspace, relative(workspace, path).split(sep).join('/')) !== current || !observed.isFile() || observed.nlink !== 1 || observed.ino !== stat.ino || observed.dev !== stat.dev || observed.size !== stat.size) throw new DomainError('preview_changed', 'Static source changed during preview preparation; retry after the build completes.', 409);
      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < buffer.length) { const count = readSync(fd, buffer, length, buffer.length - length, null); if (!count) break; length += count; }
      const data = buffer.subarray(0, length);
      if (data.length !== stat.size || fstatSync(fd).mtimeMs !== observed.mtimeMs) throw new DomainError('preview_changed', 'Static source changed during preview preparation.', 409);
      bytes += data.length;
      files.set(name, { bytes: data, contentType });
    } finally { closeSync(fd); }
  }
  visit(directory, '');
  const hash = createHash('sha256');
  for (const [path, file] of files) hash.update(path).update('\0').update(createHash('sha256').update(file.bytes).digest());
  return { files, bytes, digest: hash.digest('hex') };
}

/** Only broker-produced origins enter this policy; redirects are checked before
 * the browser follows them, and authenticated/non-read requests are rejected. */
export function browserRequestPolicy(previewOrigins: string[] = [], publicResearch = true): string {
  return `const hosts=new Set(${JSON.stringify(publicResearch ? researchHosts : [])}),previews=new Set(${JSON.stringify(previewOrigins)});
const permitted=u=>!u.username&&!u.password&&((u.protocol==='https:'&&(!u.port||u.port==='443')&&hosts.has(u.hostname))||(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&previews.has(u.origin)));
exports.default=async({page})=>{const context=page.context();if(context.__openCorpPolicy)return;context.__openCorpPolicy=true;
await context.route('**/*',async route=>{try{const request=route.request(),u=new URL(request.url());if(!permitted(u)||!['GET','HEAD'].includes(request.method()))return route.abort();
const headers={...request.headers()};for(const key of ['cookie','authorization','proxy-authorization'])delete headers[key];
const response=await route.fetch({headers,maxRedirects:0,timeout:15000});const location=response.headers()['location'];if(location&&!permitted(new URL(location,u)))return route.abort();
const responseHeaders={...response.headers()};delete responseHeaders['set-cookie'];return route.fulfill({response,headers:responseHeaders});}catch{return route.abort();}});
await context.routeWebSocket('**/*',ws=>ws.close());const guard=p=>p.on('download',d=>d.cancel());guard(page);context.on('page',guard);};\n`;
}

export class ConnectedTools {
  private mac?: Promise<Client>;
  private browsers = new Map<string, Promise<Client>>();
  private socketRoots = new Map<string, string>();
  private browserModes = new Map<string, 'preview' | 'research'>();
  private previews = new Map<string, Preview>();
  private runs = new Map<string, BoundRun>();
  private closedRuns = new Set<string>();
  private preparing = new Set<string>();
  private closingRuns = new Map<string, Promise<void>>();
  private globalController = new AbortController();
  constructor(public dataRoot: string) {}

  private bind(scope: ConnectedScope): BoundRun {
    scope.assertActive(); scope.signal?.throwIfAborted();
    if (!scope.runId || this.closedRuns.has(scope.runId)) throw new DomainError('run_closed', 'Application session ended with its employee run.', 409);
    const existing = this.runs.get(scope.runId);
    if (existing) {
      if (existing.scope.workspace !== scope.workspace) throw new DomainError('scope_changed', 'A browser session cannot change its assigned workspace.', 403);
      existing.scope.assertActive(); existing.controller.signal.throwIfAborted();
      return existing;
    }
    const controller = new AbortController(), abort = () => { void this.closeRun(scope.runId); };
    scope.signal?.addEventListener('abort', abort, { once: true });
    const bound = { scope, controller, unbind: () => scope.signal?.removeEventListener('abort', abort) };
    this.runs.set(scope.runId, bound);
    return bound;
  }
  private home(name: string) {
    const home = join(this.dataRoot, 'runtime', 'connected', name);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    return home;
  }
  private async macClient() {
    if (!this.mac) this.mac = (async () => {
      const home = this.home('macos'), transport = new StdioClientTransport({ command: process.execPath, args: [join(sourceRoot, 'node_modules/@steipete/macos-automator-mcp/dist/server.js')], env: { PATH: brokerEnvironment().PATH!, HOME: home, TMPDIR: home, LANG: 'en_US.UTF-8', LOCAL_KB_PATH: join(home, 'knowledge') }, stderr: 'pipe' });
      transport.stderr?.on('data', () => {});
      const client = new Client({ name: 'OpenCorp controlled macOS broker', version: '0.1.0' });
      try { await client.connect(transport); return client; } catch (error) { await transport.close(); this.mac = undefined; throw error; }
    })();
    return this.mac;
  }
  async macos(action: string, args: Record<string, unknown> = {}, scope?: ConnectedScope) {
    if (action === 'open_preview') {
      if (!scope) throw new DomainError('product_scope_required', 'Opening a preview requires a product assignment.', 403);
      this.bind(scope);
      const preview = this.previews.get(String(args.previewId));
      if (!preview || preview.runId !== scope.runId) throw new DomainError('preview_denied', 'Use a preview prepared by this employee run.', 403);
      return this.browserTool('browser_navigate', { url: preview.url }, scope);
    }
    if (!['system_version', 'reveal_path'].includes(action)) throw new DomainError('macos_action_denied', 'Supported native actions: system_version, reveal_path, open_preview. Arbitrary scripts are not permitted.', 403);
    if (action === 'reveal_path' && !scope) throw new DomainError('product_scope_required', 'Finder reveal requires the assigned product workspace.', 403);
    const bound = scope ? this.bind(scope) : undefined;
    if (action === 'reveal_path') workspacePath(scope!.workspace, args.path, true);
    const client = await this.macClient();
    if (scope) this.bind(scope);
    // The JXA program is fixed. The validated path is encoded as a string value,
    // never inserted into shell commands or interpreted as caller-supplied code.
    const path = action === 'reveal_path' ? workspacePath(scope!.workspace, args.path, true) : undefined;
    if (path && lstatSync(path).isFile() && lstatSync(path).nlink !== 1) throw new DomainError('path_denied', 'Hard-linked files cannot be revealed.', 403);
    return client.callTool({ name: 'execute_script', arguments: {
      script_content: path ? `const finder = Application('Finder'); finder.reveal(Path(${JSON.stringify(path)})); finder.activate(); 'Revealed assigned product path';` : 'return system version of (system info)',
      language: path ? 'javascript' : 'applescript', timeout_seconds: 10,
    } }, undefined, { signal: bound?.controller.signal ?? this.globalController.signal, timeout: 15_000 });
  }

  async preparePreview(scope: ConnectedScope, args: { path?: string; entry?: string } = {}): Promise<PreviewReceipt> {
    if (this.preparing.has(scope.runId)) throw new DomainError('preview_busy', 'This run is already preparing a static preview.', 409);
    this.preparing.add(scope.runId);
    try { return await this.prepareStaticPreview(scope, args); } finally { this.preparing.delete(scope.runId); }
  }
  private async prepareStaticPreview(scope: ConnectedScope, args: { path?: string; entry?: string }): Promise<PreviewReceipt> {
    const bound = this.bind(scope), directory = workspacePath(scope.workspace, args.path ?? '.', true), entry = relativePath(args.entry ?? 'index.html');
    if (!lstatSync(directory).isDirectory() || !/\.html?$/i.test(entry)) throw new DomainError('preview_entry_required', 'Choose a static directory and its relative HTML entry.');
    const snapshot = snapshotStatic(scope.workspace, directory);
    if (!snapshot.files.has(entry)) throw new DomainError('preview_entry_required', 'The HTML entry does not exist in the prepared static files.');
    // One immutable preview per run. Rebuilding explicitly replaces both the
    // listener and browser policy, so stale ports never remain whitelisted.
    await this.closeBrowser(scope.runId);
    await this.closePreviews(scope.runId);
    this.bind(scope);
    const previewId = randomUUID();
    let origin = '';
    const server = createServer((request, response) => {
      const finish = (status: number, message: string) => { response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(request.method === 'HEAD' ? undefined : message); };
      try {
        bound.scope.assertActive(); bound.controller.signal.throwIfAborted();
        if (request.headers.host !== new URL(origin).host || request.headers.origin && request.headers.origin !== origin) return finish(403, 'Unrelated host or origin.');
        if (!['GET', 'HEAD'].includes(request.method ?? '')) { response.setHeader('Allow', 'GET, HEAD'); return finish(405, 'Read-only static preview.'); }
        const raw = (request.url ?? '').split('?')[0]!;
        const decoded = decodeURIComponent(raw);
        if (!decoded.startsWith('/') || decoded.includes('\\') || hasControl(decoded) || decoded.slice(1).split('/').some(p => p === '..' || p === '.' || p && blockedName.test(p))) return finish(403, 'Path unavailable.');
        let path = decoded.slice(1);
        if (!path || path.endsWith('/')) path += 'index.html';
        const file = snapshot.files.get(path);
        if (!file) return finish(404, 'Static file not included in preview.');
        response.writeHead(200, { 'Content-Type': file.contentType, 'Content-Length': file.bytes.length, 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'Cross-Origin-Resource-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=()' });
        response.end(request.method === 'HEAD' ? undefined : file.bytes);
      } catch { finish(403, 'Preview permission ended or path invalid.'); }
    });
    server.requestTimeout = 10_000; server.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const receipt = { previewId, url: `${origin}/${entry.split('/').map(encodeURIComponent).join('/')}`, files: snapshot.files.size, bytes: snapshot.bytes, digest: snapshot.digest };
    this.previews.set(previewId, { ...receipt, runId: scope.runId, server, origin });
    try { this.bind(scope); } catch (error) { await this.closePreviews(scope.runId); throw error; }
    return receipt;
  }

  private async browserClient(scope?: ConnectedScope, mode: 'preview' | 'research' = 'research') {
    const key = `${scope?.runId ?? 'unscoped'}:${mode}`;
    if (scope) this.bind(scope);
    let pending = this.browsers.get(key);
    if (!pending) {
      pending = (async () => {
        const home = this.home(`browser-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`), init = join(home, 'request-policy.cjs');
        // macOS Unix sockets have a short path limit. The browser keeps its
        // private profile/output in dataRoot, with only sockets in this unique
        // short, broker-created directory.
        const sockets = mkdtempSync('/tmp/oc-pw-'); this.socketRoots.set(key, sockets);
        const origins = mode === 'preview' ? [...this.previews.values()].filter(p => p.runId === scope?.runId).map(p => p.origin) : [];
        writeFileSync(init, browserRequestPolicy(origins, mode === 'research'), { mode: 0o600 });
        const transport = new StdioClientTransport({ command: process.execPath, args: [join(sourceRoot, 'node_modules/@playwright/mcp/cli.js'), '--headless', '--isolated', '--block-service-workers', '--init-page', init, '--caps', 'vision', '--output-dir', home, '--output-max-size', '20000000', '--image-responses', 'allow'], env: { PATH: brokerEnvironment().PATH!, HOME: home, TMPDIR: home, LANG: 'en_US.UTF-8', PWTEST_SOCKETS_DIR: sockets }, stderr: 'pipe' });
        transport.stderr?.on('data', () => {});
        const client = new Client({ name: 'OpenCorp product browser broker', version: '0.1.0' });
        try { await client.connect(transport); if (scope) this.bind(scope); return client; } catch (error) { await transport.close(); rmSync(sockets, { recursive: true, force: true }); if (this.socketRoots.get(key) === sockets) this.socketRoots.delete(key); throw error; }
      })();
      this.browsers.set(key, pending);
      pending.catch(() => { if (this.browsers.get(key) === pending) this.browsers.delete(key); });
    }
    return pending;
  }
  async browserTool(name: string, args: Record<string, unknown>, scope?: ConnectedScope) {
    const fields: Record<string, string[]> = {
      browser_navigate: ['url'], browser_snapshot: ['target', 'depth', 'boxes'], browser_take_screenshot: ['type', 'fullPage', 'element', 'target', 'ref'],
      browser_click: ['element', 'target', 'ref', 'doubleClick', 'button'], browser_press_key: ['key'], browser_tabs: ['action', 'index'], browser_close: [],
    };
    if (!fields[name]) throw new DomainError('browser_tool_denied', 'Browser exposes inspection tools only; external writes require the communication broker.', 403);
    if (!args || Object.keys(args).some(key => !fields[name]!.includes(key))) throw new DomainError('browser_argument_denied', 'Only inspection arguments are accepted. File paths and scripts are broker-controlled.', 403);
    // The pinned MCP uses `target`; accept a snapshot's familiar `ref` spelling
    // at this boundary without forwarding an unsupported upstream argument.
    const forwarded = { ...args };
    if (forwarded.ref !== undefined) { if (forwarded.target === undefined) forwarded.target = forwarded.ref; delete forwarded.ref; }
    const bound = scope ? this.bind(scope) : undefined;
    if (name === 'browser_navigate') {
      const url = new URL(String(args.url));
      const preview = [...this.previews.values()].find(p => p.runId === scope?.runId && p.origin === url.origin);
      if (!preview || url.username || url.password) publicUrl(url.href);
      this.browserModes.set(scope?.runId ?? 'unscoped', preview ? 'preview' : 'research');
    }
    if (name === 'browser_press_key' && !/^(?:Shift\+Tab|Tab|Enter|Escape|Arrow(?:Up|Down|Left|Right)|Home|End|PageUp|PageDown|Space)$/.test(String(args.key))) throw new DomainError('browser_key_denied', 'Only page navigation keys are allowed.', 403);
    if (name === 'browser_tabs' && !['list', 'new', 'close', 'select'].includes(String(args.action))) throw new DomainError('browser_argument_denied', 'Use list, new, close or select for isolated tabs.');
    const client = await this.browserClient(scope, this.browserModes.get(scope?.runId ?? 'unscoped') ?? 'research');
    if (scope) this.bind(scope);
    return client.callTool({ name, arguments: forwarded }, undefined, { signal: bound?.controller.signal ?? this.globalController.signal, timeout: 40_000 });
  }
  async doctor() {
    try {
      const client = await this.macClient(), tools = await client.listTools();
      return { name: 'macOS', status: tools.tools.some(t => t.name === 'execute_script') ? 'connected' : 'unavailable', detail: 'macOS Automator MCP 0.4.7: fixed system_version and assigned-product Finder reveal. Run-owned HTML/CSS previews open in isolated Playwright MCP with screenshots. Finder consent is checked only when requested; arbitrary scripts, personal browser profiles, and arbitrary localhost are disabled.' };
    } catch (error) { return { name: 'macOS', status: 'unavailable', detail: String(error) }; }
  }
  private async closeBrowser(key: string) {
    this.browserModes.delete(key);
    await Promise.all([...this.browsers.keys()].filter(k => k === key || k.startsWith(`${key}:`)).map(async k => {
      const pending = this.browsers.get(k); this.browsers.delete(k);
      const sockets = this.socketRoots.get(k); this.socketRoots.delete(k);
      try { if (pending) await pending.then(client => client.close(), () => {}); }
      finally { if (sockets) rmSync(sockets, { recursive: true, force: true }); }
    }));
  }
  private async closePreviews(runId: string) {
    await Promise.all([...this.previews.values()].filter(p => p.runId === runId).map(async p => {
      this.previews.delete(p.previewId);
      p.server.closeAllConnections();
      await new Promise<void>(resolve => p.server.close(() => resolve()));
    }));
  }
  async closeRun(runId: string) {
    const closing = this.closingRuns.get(runId); if (closing) return closing;
    this.closedRuns.add(runId);
    const bound = this.runs.get(runId); bound?.controller.abort(); bound?.unbind(); this.runs.delete(runId);
    const pending = Promise.all([this.closePreviews(runId), this.closeBrowser(runId)]).then(() => {});
    this.closingRuns.set(runId, pending);
    try { await pending; } finally { this.closingRuns.delete(runId); }
  }
  async close() {
    this.globalController.abort();
    const pendingMac = this.mac; this.mac = undefined;
    await Promise.allSettled([...this.runs.keys()].map(runId => this.closeRun(runId)));
    await Promise.allSettled([...this.browsers.keys()].map(key => this.closeBrowser(key)));
    if (pendingMac) await pendingMac.then(client => client.close(), () => {});
    this.globalController = new AbortController();
  }
}
