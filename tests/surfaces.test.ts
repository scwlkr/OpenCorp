import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server, type RequestListener } from 'node:http';
import { OwnerClient, readConnection } from '../src/cli/client.js';
import { createProgram } from '../src/cli/index.js';
import { tuiRecords } from '../src/tui/index.js';
import { CompanyStore } from '../src/storage/store.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Narratives } from '../src/web/narratives.js';
import { ArtifactLink, artifactContentHref } from '../src/web/artifacts.js';
import type { Artifact, Project } from '../src/core/types.js';
const roots: string[] = []; const servers: Server[] = [];
async function root(): Promise<string> { const path = await mkdtemp(join(tmpdir(), 'opencorp-surfaces-')); roots.push(path); return path; }
afterEach(async () => { vi.restoreAllMocks(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture(handler: RequestListener): Promise<{ client: OwnerClient; dataRoot: string }> {
  const dataRoot = await root(); const server = createServer(handler); servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('No server');
  await writeFile(join(dataRoot, 'discovery.json'), JSON.stringify({ url: `http://127.0.0.1:${address.port}`, pid: process.pid })); await writeFile(join(dataRoot, 'owner-token'), 'private-test-owner', { mode: 0o600 });
  return { client: new OwnerClient(dataRoot), dataRoot };
}
describe('Owner surfaces use the shared authenticated API', () => {
  it('sends control/chat intent with the discovered Owner token', async () => {
    const received: Array<{ url: string; token: string; body: unknown }> = [];
    const { client } = await fixture((request, response) => { let body = ''; request.on('data', (chunk) => { body += chunk; }); request.on('end', () => { received.push({ url: request.url!, token: request.headers.authorization!, body: JSON.parse(body) }); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ id: 'actual-result' })); }); });
    await client.control('pause'); expect(await client.chat('Preserve the roadmap.', { projectId: 'project-id' })).toEqual({ id: 'actual-result' });
    expect(received).toEqual([{ url: '/api/v1/control', token: 'Bearer private-test-owner', body: { action: 'pause' } }, { url: '/api/v1/chat', token: 'Bearer private-test-owner', body: { content: 'Preserve the roadmap.', projectId: 'project-id' } }]);
  });
  it('never sends the Owner token to a non-loopback discovery URL', async () => {
    const dataRoot = await root(); await writeFile(join(dataRoot, 'owner-token'), 'private-test-owner'); await writeFile(join(dataRoot, 'discovery.json'), JSON.stringify({ url: 'https://example.com' }));
    await expect(readConnection(dataRoot)).rejects.toThrow('Invalid local service discovery');
  });
  it('reports server policy errors instead of claiming success', async () => {
    const { client } = await fixture((_request, response) => { response.writeHead(403, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'COST_BLOCKED', message: 'New spending requires explicit approval.' } })); });
    await expect(client.request('command', { type: 'action.request' })).rejects.toThrow('New spending requires explicit approval');
  });
  it('receives authenticated live events and supports cancellation', async () => {
    const { client } = await fixture((request, response) => { expect(request.headers.authorization).toBe('Bearer private-test-owner'); response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write('id: 12\ndata: {"type":"company.changed"}\n\n'); });
    const controller = new AbortController(); let received = 0;
    await client.events(() => { received++; controller.abort(); }, controller.signal).catch((error: unknown) => { if (!(error instanceof Error && error.name === 'AbortError')) throw error; });
    expect(received).toBe(1);
  });
  it('CLI exposes all required commands and forwards JSON queries', async () => {
    const { dataRoot } = await fixture((_request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify([{ id: 'product-id', name: 'Live product' }])); });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const program = createProgram();
    for (const name of ['init', 'start', 'status', 'pause', 'resume', 'stop', 'open', 'tui', 'chat', 'products', 'projects', 'employees', 'decisions', 'attention', 'models', 'integrations', 'logs', 'doctor', 'backup', 'restore', 'service']) expect(program.commands.some((command) => command.name() === name)).toBe(true);
    await program.parseAsync(['--data-dir', dataRoot, 'products', '--json'], { from: 'user' });
    expect(JSON.parse(String(write.mock.calls.at(-1)?.[0]))).toEqual([{ id: 'product-id', name: 'Live product' }]);
  });
  it('terminal browsing retains real identities, product assessment, and Elder dissent', async () => {
    const store = new CompanyStore(await root());
    try {
      const state = store.bootstrap();
      state.products[0].assessment = 'A recorded product finding';
      state.decisions.push({ id: 'decision', createdAt: '', updatedAt: '', authorId: state.employees[0].id, subject: 'Executive appointment', rationale: 'Staff actual work.', kind: 'appointment', payload: {}, status: 'approved', policyRevision: 1 });
      state.votes.push({ id: 'vote', createdAt: '', updatedAt: '', decisionId: 'decision', employeeId: state.employees[1].id, approve: false, rationale: 'Candidate lacks relevant delivery.', runId: 'review-run', phase: 'initial' });
      expect(tuiRecords(state, 1)[0].detail).toContain('A recorded product finding');
      expect(tuiRecords(state, 3)[0].detail).toContain(state.employees[0].id);
      expect(tuiRecords(state, 4)[0].detail).toContain('DISSENT');
      expect(tuiRecords(state, 4)[0].detail).toContain('Candidate lacks relevant delivery.');
    } finally { store.close(); }
  });
  it('shows canonical product outcomes and success measures without opening record details in either interface', async () => {
    const goal = { outcome: 'Maintain stable compiler releases and establish contributor onboarding pipeline', measure: 'Release v6.4.1 within 4 weeks with documented CI workflow; onboarding guide completed.' };
    const visibleWeb = renderToStaticMarkup(createElement(Narratives, { values: [goal], empty: 'No goals' })).split('<details')[0];
    expect(visibleWeb).toContain(`<strong>${goal.outcome}</strong>`);
    expect(visibleWeb).toContain(`Success measure: ${goal.measure}`);
    expect(visibleWeb).not.toContain('Recorded objective');
    const store = new CompanyStore(await root());
    try {
      const state = store.bootstrap(); state.products[0].goals = [goal];
      const terminal = tuiRecords(state, 1)[0].detail;
      expect(terminal).toContain(`Goals:\n${goal.outcome}\nSuccess measure: ${goal.measure}`);
      expect(terminal).not.toContain('"outcome"');
    } finally { store.close(); }
  });
  it('retains plain acceptance text and prior descriptive goal fields', () => {
    const html = renderToStaticMarkup(createElement(Narratives, { values: ['Existing acceptance condition', { title: 'Existing objective', successMeasure: 'Observed result', rationale: 'Recorded reason' }], empty: 'No goals' }));
    expect(html).toContain('<li>Existing acceptance condition</li>');
    expect(html).toContain('<strong>Existing objective</strong><p>Recorded reason</p><p>Success measure: Observed result</p>');
  });
  it('distinguishes external PR authorship from employee import custody and links immutable content', async () => {
    const store = new CompanyStore(await root());
    try {
      const state = store.bootstrap(), employee = state.employees[0];
      const artifact = { id: 'candidate/id', projectId: 'external-review-project', kind: 'commit', summary: 'Review the existing correction', employeeId: employee.id,
        uri: 'https://github.com/fixture/product/pull/12', identity: 'immutable-external-head', checks: [],
        sourcePullRequest: { repository: 'fixture/product', number: 12, url: 'https://github.com/fixture/product/pull/12', authorLogin: 'outside-contributor', baseRef: 'main', baseSha: 'base', headRepository: 'outside/product', headRef: 'correction', headSha: 'immutable-external-head', observedAt: '2026-09-10T00:00:00Z' },
        reviewWorkspace: { workspace: '/owned/candidate', gitDir: '/owned/metadata', mirror: '/owned/mirror', branch: 'candidate', baseCommit: 'base' } } as unknown as Artifact;
      const html = renderToStaticMarkup(createElement(ArtifactLink, { artifact, importer: employee.name }));
      expect(html).toContain('href="/api/v1/artifacts/candidate%2Fid/content"');
      expect(html).toContain('PR author: outside-contributor'); expect(html).toContain(`Imported by ${employee.name}`);
      expect(html).toContain('href="https://github.com/fixture/product/pull/12"'); expect(html).toContain('immutable-external-head');
      state.artifacts.push(artifact); state.projects.push({ id: artifact.projectId, name: 'Existing PR review', outcome: 'Assess actual proposed correction', status: 'active', acceptance: ['Review candidate'], supervisorId: employee.id } as Project);
      const terminal = tuiRecords(state, 2)[0].detail;
      expect(terminal).toContain('External pull request #12 · PR author: outside-contributor');
      expect(terminal).toContain(`Imported by ${employee.name}`); expect(terminal).toContain('Artifact content: /api/v1/artifacts/candidate%2Fid/content');
      expect(terminal).not.toContain(`\nBy ${employee.name}\n`);
    } finally { store.close(); }
  });
  it('does not relabel missing imported provenance or navigate an unsafe source URL', () => {
    const artifact = { id: 'candidate', kind: 'commit', summary: '<script>untrusted</script>', uri: 'https://github.com/fixture/product/pull/12', identity: 'head', reviewWorkspace: {}, sourcePullRequest: { url: 'javascript:alert(1)' } } as unknown as Artifact;
    const html = renderToStaticMarkup(createElement(ArtifactLink, { artifact, importer: 'Importing employee' }));
    expect(html).toContain('PR author: Not recorded'); expect(html).toContain('Imported by Importing employee');
    expect(html).not.toContain('href="javascript:'); expect(html).not.toContain('<script>');
    delete artifact.sourcePullRequest;
    expect(renderToStaticMarkup(createElement(ArtifactLink, { artifact, importer: 'Importing employee' }))).toContain('External pull request');
    delete artifact.reviewWorkspace;
    expect(artifactContentHref(artifact)).toBe('/api/v1/artifacts/candidate/content');
  });
});
