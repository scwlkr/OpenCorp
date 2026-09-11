import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const invoke = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const { stdout } = await invoke(process.execPath, [cli, '--help'], { timeout: 10_000 });
assert.match(stdout, /OpenCorp|Your persistent local company/);
// A piped launch imports the compiled TUI before its terminal guard, without
// connecting to a company. Run after Vite, which replaces the dist/web directory.
await assert.rejects(invoke(process.execPath, [cli, 'tui'], { timeout: 10_000 }), (error) => {
  assert.equal(error.code, 1);
  assert.match(error.stderr, /^OpenCorp: The TUI needs an interactive terminal\./);
  return true;
});
const dataRoot = await mkdtemp(join(tmpdir(), 'opencorp-built-cli-'));
const fixtureToken = 'built-cli-fixture-token';
const state = { company: { id: 'built-company', name: 'Fixture company', state: 'paused' }, policy: { maxInference: 1, spendingLimit: 0 }, products: [{ id: 'built-product' }], employees: [], assignments: [], runs: [], attention: [], history: 'Retained company evidence. '.repeat(12000) };
const mutations = [];
const server = createServer(async (request, response) => {
  const send = (value) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
  if (request.method === 'GET' && request.url === '/health') { send({ application: 'OpenCorp', pid: process.pid }); return; }
  if (request.headers.authorization !== `Bearer ${fixtureToken}`) { response.writeHead(403); response.end(); return; }
  if (request.method === 'GET' && request.url === '/api/v1/state') { send(state); return; }
  if (request.method === 'POST' && ['/api/v1/control', '/api/v1/chat'].includes(request.url)) {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); mutations.push({ method: request.method, path: request.url, body });
    if (request.url === '/api/v1/control') { state.company.state = body.action === 'pause' ? 'paused' : body.action === 'stop' ? 'stopped' : 'running'; send(state); }
    else send({ id: 'fixture-message', senderId: 'owner', recipientId: body.employeeId, projectId: body.projectId, content: body.content });
    return;
  }
  response.writeHead(404); response.end();
});
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await writeFile(join(dataRoot, 'discovery.json'), JSON.stringify({ url: `http://127.0.0.1:${address.port}`, pid: process.pid }));
  await writeFile(join(dataRoot, 'owner-token'), fixtureToken, { mode: 0o600 });
  for (const args of [
    ['--data-dir', dataRoot, '--json', 'status'],
    ['--data-dir', dataRoot, 'status', '--json'],
    ['status', '--json', '--data-dir', dataRoot],
    ['--json', 'status', '--data-dir', dataRoot],
  ]) {
    const { stdout: json, stderr } = await invoke(process.execPath, [cli, ...args], { maxBuffer: 16 * 1024 * 1024, timeout: 15000 });
    assert.equal(stderr, ''); assert.ok(json.length > 120000, 'Fixture must exceed the broker log-tail limit');
    assert.deepEqual(JSON.parse(json), state, `Compiled JSON output was incomplete for ${args.join(' ')}`);
  }
  // Transport regression only: these fixture responses never count as installed
  // company control or conversation evidence in verify:acceptance.
  for (const action of ['pause', 'resume', 'stop', 'start']) {
    const { stdout: json, stderr } = await invoke(process.execPath, [cli, action, '--data-dir', dataRoot, '--json'], { timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(stderr, ''); assert.deepEqual(JSON.parse(json), state);
    assert.deepEqual(mutations.at(-1), { method: 'POST', path: '/api/v1/control', body: { action } });
  }
  const content = 'Compiled CLI acknowledgment: quotes "and" $() stay literal.';
  const { stdout: chat, stderr: chatError } = await invoke(process.execPath, [cli, '--data-dir', dataRoot, '--json', 'chat', content, '--employee', 'fixture-recipient', '--project', 'fixture-project'], { timeout: 15000 });
  assert.equal(chatError, ''); assert.deepEqual(mutations.at(-1), { method: 'POST', path: '/api/v1/chat', body: { content, employeeId: 'fixture-recipient', projectId: 'fixture-project' } });
  assert.deepEqual(JSON.parse(chat), { id: 'fixture-message', senderId: 'owner', recipientId: 'fixture-recipient', projectId: 'fixture-project', content });
  assert.equal(mutations.length, 5);
} finally {
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  await rm(dataRoot, { recursive: true, force: true });
}
const { stdout: browserCheck, stderr: browserError } = await invoke(process.execPath,
  ['--import', 'tsx', fileURLToPath(new URL('./check-owner-surface-controls.ts', import.meta.url))],
  { timeout: 90000, maxBuffer: 1024 * 1024 });
assert.equal(browserError, ''); process.stdout.write(browserCheck);
process.stdout.write('Compiled CLI/TUI startup, large JSON option orders, and control/chat transport checks passed.\n');
