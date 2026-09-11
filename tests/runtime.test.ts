import { describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, symlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { executeSandboxed, runtimeConfig } from '../src/runtime/index.js';
import { minimalEnvironment } from '../src/runtime/processes.js';
import * as processes from '../src/runtime/processes.js';
import { OwnedOllama } from '../src/runtime/ollama.js';
import { RunGateway } from '../src/runtime/gateway.js';
import type { LocalModel } from '../src/runtime/types.js';
import { awaitSessionReply } from '../src/runtime/session.js';
import type { OpencodeClient } from '@opencode-ai/sdk/v2';

const model: LocalModel = { id: 'small', name: 'qwen3.5:4b', alias: 'opencorp-small-16384:latest', sourceAlias: 'qwen3.5:4b', artifactIdentity: 'test-identity',
  manifestDigest: 'manifest', parametersDigest: 'params', templateDigest: 'template', size: 1,
  capabilities: ['completion', 'tools', 'vision'], contextTokens: 16384, provider: 'ollama', local: true, available: true };

describe('local-only runtime policy', () => {
  it('waits through asynchronous admission and busy tools before returning the completed assistant message', async () => {
    let polls = 0;
    const answer = { info: { role: 'assistant', time: { completed: 123 } }, parts: [{ type: 'text', text: 'completed' }] };
    const session = {
      status: vi.fn(async () => ({ data: ++polls === 2 ? { session: { type: 'busy' } } : {}, response: { ok: true } })),
      messages: vi.fn(async () => ({ data: polls === 1 ? [{ info: { role: 'user' }, parts: [] }] : [answer] })),
    };
    expect(await awaitSessionReply({ session } as unknown as Pick<OpencodeClient, 'session'>, 'session', new AbortController().signal, () => {}, 1)).toEqual(answer);
    expect(polls).toBe(3); expect(session.messages).toHaveBeenCalledTimes(2);
  });
  it('uses explicit local provider for main and background calls and disables unscheduled delegates', () => {
    const config = runtimeConfig(model, 'http://127.0.0.1:54321', 'scoped-placeholder', true);
    expect(config.enabled_providers).toEqual(['opencorp-local']);
    expect(config.small_model).toBe(config.model);
    expect(config.share).toBe('disabled');
    expect(config.tools?.task).toBe(false);
    expect(config.plugin).toEqual([]);
    expect(config.subagent_depth).toBe(0);
  });

  it('builds a fresh environment with no inherited secrets, credential sockets, or shell startup hooks', () => {
    process.env.OPENCORP_TEST_SECRET = 'must-not-leak';
    const env = minimalEnvironment('/owned/runtime');
    expect(env.OPENCORP_TEST_SECRET).toBeUndefined();
    for (const key of ['SSH_AUTH_SOCK', 'GITHUB_TOKEN', 'GH_TOKEN', 'OPENAI_API_KEY', 'BASH_ENV', 'ENV', 'ZDOTDIR']) expect(env[key]).toBeUndefined();
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    delete process.env.OPENCORP_TEST_SECRET;
  });

  it('rejects hosted inference, unrelated routes and pre-binding tools before any dispatch', async () => {
    let calls = 0;
    const ollama = { verifyIdentity: async () => { calls++; }, url: 'http://127.0.0.1:1' } as unknown as OwnedOllama;
    const gateway = new RunGateway(ollama, model, { runId: 'gateway-test', employeeId: 'employee', workspace: '/tmp/unused', modelId: 'small', system: '', prompt: '', brokerUrl: 'http://127.0.0.1:2/mcp/run', token: 'worker' }, () => {});
    await gateway.start();
    try {
      const headers = { authorization: `Bearer ${gateway.secret}`, 'content-type': 'application/json' };
      expect((await fetch(`${gateway.url}/api/v1/control`, { method: 'POST', headers, body: '{}' })).status).toBe(403);
      expect((await fetch(`${gateway.url}/mcp`, { method: 'POST', headers, body: JSON.stringify({ method: 'tools/call' }) })).status).toBe(409);
      gateway.sessionId = 'actual-runtime-session';
      expect((await fetch(`${gateway.url}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'gpt-oss:120b-cloud', messages: [] }) })).status).toBe(403);
      expect(calls).toBe(0);
    } finally { await gateway.close(); }
  });

  it('preserves upstream client errors and maps the observed Ollama truncation defect to non-retryable context overflow', async () => {
    let status = 400, message = 'invalid messages';
    const upstream = createServer((_req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message } })); });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address(); if (!address || typeof address === 'string') throw new Error('No fixture port');
    const events: unknown[] = [];
    const gateway = new RunGateway({ url: `http://127.0.0.1:${address.port}`, verifyIdentity: async () => {} } as unknown as OwnedOllama,
      model, { runId: 'overflow', employeeId: 'employee', workspace: '/unused', modelId: 'small', system: '', prompt: '' }, event => events.push(event));
    await gateway.start(); gateway.sessionId = 'bound';
    const request = () => fetch(`${gateway.url}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${gateway.secret}` }, body: JSON.stringify({ model: model.alias, messages: [{ role: 'user', content: 'original request exists' }, { role: 'tool', content: 'large output' }] }) });
    try {
      expect((await request()).status).toBe(400);
      status = 500; message = 'Error: Jinja Exception: No user query found in messages.';
      const response = await request();
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'context_length_exceeded' } });
      expect(events).toContainEqual(expect.objectContaining({ type: 'runtime.inference.failed', payload: expect.objectContaining({ upstreamStatus: 500, status: 400 }) }));
    } finally { await gateway.close(); upstream.closeAllConnections(); upstream.close(); }
  });

  it('preserves cumulative tool-step and inference caps across separate prompt requests', async () => {
    let calls = 0;
    const upstream = createServer((_req, res) => { calls++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}'); });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address(); if (!address || typeof address === 'string') throw new Error('No fixture port');
    const events: unknown[] = [];
    const gateway = new RunGateway({ url: `http://127.0.0.1:${address.port}`, verifyIdentity: async () => {} } as unknown as OwnedOllama,
      model, { runId: 'budget', employeeId: 'employee', workspace: '/unused', modelId: 'small', system: '', prompt: '' }, event => events.push(event));
    await gateway.start(); gateway.sessionId = 'bound'; gateway.stepCount = 31; gateway.usage.requests = 31;
    const request = (withTools: boolean) => fetch(`${gateway.url}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${gateway.secret}` },
      body: JSON.stringify({ model: model.alias, messages: [{ role: 'user', content: 'continue' }], tools: withTools ? [{ type: 'function', function: { name: 'fixture', parameters: {} } }] : undefined }) });
    try {
      expect((await request(true)).status).toBe(200);
      expect(gateway.stepCount).toBe(32);
      expect((await request(true)).status).toBe(400);
      expect((await request(false)).status).toBe(200); // Compaction keeps its remaining run allowance.
      expect(gateway.usage.requests).toBe(33);
      gateway.usage.requests = 36;
      expect((await request(false)).status).toBe(400);
      expect(calls).toBe(2);
      expect(events).toContainEqual(expect.objectContaining({ type: 'runtime.budget.exhausted', payload: expect.objectContaining({ code: 'step_budget_exhausted' }) }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'runtime.budget.exhausted', payload: expect.objectContaining({ code: 'run_budget_exhausted' }) }));
    } finally { await gateway.close(); upstream.closeAllConnections(); upstream.close(); }
  });
});

describe.skipIf(process.platform !== 'darwin')('native process-tree boundary', () => {
  it('reaps orphan dependency jobs and detached descendants before claimed work can be reclaimed', async () => {
    const root = await mkdtemp(join(homedir(), '.local/share/opencorp-preparation-recovery-'));
    const workspace = join(root, 'workspaces/product'); await mkdir(workspace, { recursive: true });
    const escaped = "setTimeout(()=>require('fs').writeFileSync('escaped.txt','late mutation'),2200);setInterval(()=>{},10000)";
    const installer = `const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(escaped)}],{detached:true,stdio:'ignore'});child.unref();require('fs').writeFileSync('ready.txt','ready');setInterval(()=>{},10000)`;
    const script = `import {executeSandboxed} from ${JSON.stringify(new URL('../src/runtime/tool-process.ts', import.meta.url).pathname)};await executeSandboxed(${JSON.stringify({ dataRoot: root, workspace, command: [process.execPath, '-e', installer], timeoutMs: 20000 })});`;
    const parent = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd(), stdio: 'ignore' });
    try {
      const until = Date.now() + 10000;
      while (Date.now() < until) { try { await readFile(join(workspace, 'ready.txt')); break; } catch { await new Promise(resolve => setTimeout(resolve, 25)); } }
      expect(await readFile(join(workspace, 'ready.txt'), 'utf8')).toBe('ready');
      const job = (await readdir(join(root, 'runtime/control/jobs')))[0];
      const receiptPath = join(root, 'runtime/control/jobs', job, 'receipt.json');
      const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
      // Suspend the automatic guardian to prove startup reconciliation itself
      // handles a dead daemon while a detached installer descendant is live.
      process.kill(receipt.guardian.pid, 'SIGSTOP');
      await writeFile(receiptPath, JSON.stringify({ ...receipt, guardian: { ...receipt.guardian, unique: receipt.guardian.unique + 1 } }));
      expect((await processes.recoverOwnedJobs(root)).status).toBe('uncertain');
      expect(await processes.inspectProcess(receipt.helper, receipt.guardian.pid)).toMatchObject({ unique: receipt.guardian.unique });
      await writeFile(receiptPath, JSON.stringify(receipt));
      parent.kill('SIGKILL');
      await new Promise<void>(resolve => parent.once('exit', () => resolve()));
      const recovered = await processes.recoverOwnedJobs(root);
      expect(recovered.status, JSON.stringify(recovered)).toBe('absent');
      expect(recovered.jobs).toContainEqual(expect.objectContaining({ workspace, status: 'absent' }));
      await new Promise(resolve => setTimeout(resolve, 2400));
      await expect(readFile(join(workspace, 'escaped.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { parent.kill('SIGKILL'); await processes.recoverOwnedJobs(root); }
  }, 15000);
  it('allows ephemeral HTTP listeners in its own coalition while denying Owner loopback and direct bypass', async () => {
    const root = await mkdtemp(join(homedir(), '.local/share/opencorp-loopback-test-'));
    const workspace = join(root, 'workspaces/check'); await mkdir(workspace, { recursive: true });
    let ownerCalls = 0;
    const owner = createServer((_req, res) => { ownerCalls++; res.end('owner'); });
    await new Promise<void>(resolve => owner.listen(0, '127.0.0.1', resolve));
    const address = owner.address(); if (!address || typeof address === 'string') throw new Error('No owner port');
    const script = `const http=require('http'),net=require('net');const server=http.createServer((q,s)=>s.end('own-server'));server.listen(0,'127.0.0.1',async()=>{try{const actual=await(await fetch('http://127.0.0.1:'+server.address().port)).text();if(actual!=='own-server')throw Error(actual);try{await fetch('http://127.0.0.1:${address.port}');throw Error('owner reached')}catch(e){if(e.message==='owner reached')throw e}await new Promise((resolve,reject)=>{const socket=net.connect(${address.port},'127.0.0.1');socket.on('connect',()=>reject(Error('direct bypass')));socket.on('error',resolve)});console.log('owned-only');}catch(e){console.error(e);process.exitCode=1}finally{server.close()}});`;
    try {
      const result = await executeSandboxed({ dataRoot: root, workspace, command: [process.execPath, '-e', script], localTestNetwork: true, timeoutMs: 15000 });
      expect(result.code, result.stderr).toBe(0); expect(result.stdout.trim()).toBe('owned-only'); expect(ownerCalls).toBe(0);
    } finally { owner.closeAllConnections(); owner.close(); }
  }, 20000);
  it('denies protected files, symlinks, spawned scripts and arbitrary loopback; allows owned work', async () => {
    const root = await mkdtemp(join(homedir(), '.local/share/opencorp-sandbox-test-'));
    const workspace = join(root, 'workspaces', 'check');
    await mkdir(workspace, { recursive: true });
    const protectedPath = join(root, 'owner-token');
    await writeFile(protectedPath, 'controlled-test-sentinel');
    await symlink(protectedPath, join(workspace, 'tempting-link'));
    let networkCalls = 0;
    const owner = createServer((_req, res) => { networkCalls++; res.end('owner'); });
    await new Promise<void>((resolve) => owner.listen(0, '127.0.0.1', resolve));
    const address = owner.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const script = `const fs=require('node:fs'),cp=require('node:child_process');
      const denied=[];for(const p of ${JSON.stringify([protectedPath, join(workspace, 'tempting-link')])}){try{fs.readFileSync(p);process.exit(21)}catch(e){denied.push(e.code)}}
      try{fs.writeFileSync(${JSON.stringify(protectedPath)},'tamper');process.exit(22)}catch(e){denied.push(e.code)}
      const sub=cp.spawnSync(process.execPath,['-e',${JSON.stringify(`try{require('fs').readFileSync(${JSON.stringify(protectedPath)});process.exit(23)}catch{process.exit(0)}`)}]);if(sub.status!==0)process.exit(24);
      fs.writeFileSync('allowed.txt','actual sandbox write');
      fetch('http://127.0.0.1:${address.port}/api/v1/control',{signal:AbortSignal.timeout(1500)}).then(()=>process.exit(25)).catch(()=>console.log(JSON.stringify({denied,childDenied:true,loopbackDenied:true})));`;
    await writeFile(join(workspace, 'workspace-script.cjs'), script);
    try {
      const result = await executeSandboxed({ dataRoot: root, workspace, command: [process.execPath, 'workspace-script.cjs'], timeoutMs: 10000 });
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ denied: ['EPERM', 'EPERM', 'EPERM'], childDenied: true, loopbackDenied: true });
      expect(await readFile(protectedPath, 'utf8')).toBe('controlled-test-sentinel');
      expect(await readFile(join(workspace, 'allowed.txt'), 'utf8')).toBe('actual sandbox write');
      expect(networkCalls).toBe(0);
    } finally { owner.closeAllConnections(); owner.close(); }
  }, 20000);

  it('reports timeout as failure and kills descendants', async () => {
    const root = await mkdtemp(join(homedir(), '.local/share/opencorp-timeout-test-'));
    const workspace = join(root, 'workspace'); await mkdir(workspace);
    const began = Date.now();
    const result = await executeSandboxed({ dataRoot: root, workspace, command: [process.execPath, '-e', 'setInterval(()=>{},1000)'], timeoutMs: 200 });
    expect(result.code).toBe(124);
    expect(Date.now() - began).toBeLessThan(4000);
  }, 5000);

  it('kills detached, reparented descendants before cancellation returns', async () => {
    const root = await mkdtemp(join(homedir(), '.local/share/opencorp-detached-test-'));
    const workspace = join(root, 'workspace'); await mkdir(workspace);
    const grandchild = "const ready=setInterval(()=>{if(process.ppid!==1)return;clearInterval(ready);require('fs').writeFileSync('grandchild.pid',String(process.pid));setTimeout(()=>require('fs').writeFileSync('escaped.txt','escaped'),1400)},10);setTimeout(()=>{},10000)";
    const child = `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{detached:true,stdio:'ignore'});c.unref();`;
    const script = `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:true,stdio:'ignore'});c.unref();setInterval(()=>{},10000)`;
    const controller = new AbortController();
    const execution = executeSandboxed({ dataRoot: root, workspace, command: [process.execPath, '-e', script], signal: controller.signal, timeoutMs: 6000 });
    void execution.catch(() => {}); // Retain early launch failures until the awaited cleanup below.
    try {
      const pid = await vi.waitFor(async () => {
        const pid = Number(await readFile(join(workspace, 'grandchild.pid'), 'utf8'));
        expect(pid).toBeGreaterThan(0); process.kill(pid, 0); return pid;
      }, { timeout: 5000, interval: 25 });
      controller.abort(new Error('Cancel the observed detached descendant'));
      expect((await execution).code).toBe(130);
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
      await new Promise(resolve => setTimeout(resolve, 1500));
      await expect(readFile(join(workspace, 'escaped.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { controller.abort(); await execution; }
  }, 12000);

  it('uses the selected Apple compiler and SDK inside the worker boundary', async () => {
    const root = await mkdtemp(join(homedir(), '.local/share/opencorp-compiler-test-'));
    const workspace = join(root, 'workspace'); await mkdir(workspace);
    await writeFile(join(workspace, 'main.c'), 'int main(void) { return 0; }\n');
    const result = await executeSandboxed({ dataRoot: root, workspace, command: 'clang main.c -o compiled && ./compiled' });
    expect(result.code, result.stderr).toBe(0);
  }, 15000);

  it.each(['before', 'after'])('stop during %s-spawn startup prevents a late Ollama service', async (phase) => {
    const root = await mkdtemp(join(homedir(), '.local/share/opencorp-start-race-test-'));
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const original = processes.spawnOwned;
    const spy = vi.spyOn(processes, 'spawnOwned').mockImplementation(async options => {
      if (phase === 'before') { entered(); await blocked; return original(options); }
      const result = await original(options); entered(); await blocked; return result;
    });
    const ollama = new OwnedOllama({ dataRoot: root });
    try {
      const started = ollama.start().then(() => true, () => false);
      await reached;
      const stopped = ollama.stop(); release(); await stopped;
      expect(await started).toBe(false);
      expect(ollama.status().running).toBe(false);
      expect(ollama.url).toBe('');
      if (phase === 'after') expect((await processes.recoverOwnedReceipt(join(root, 'runtime/ollama/process.json'))).status).toBe('absent');
    } finally { release(); spy.mockRestore(); await ollama.stop(); }
  }, 15000);
});
