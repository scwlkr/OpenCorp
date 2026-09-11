import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { OwnerClient, readConnection } from '../src/cli/client.js';
import { deliveriesFor } from '../src/core/delivery.js';
import { invokeCompiledOwnerCLI, ownerMutationSourceIdentity, verifyChatReceipt, verifyControlReceipt, waitForControlReceipt, type ChatTarget, type OwnerControl } from './surfaces.mutations.js';
import type { CompanySnapshot } from '../src/core/types.js';

export { ownerMutationSourceIdentity } from './surfaces.mutations.js';

export interface OwnerMutationActions {
  control(action: OwnerControl): Promise<ReturnType<typeof verifyControlReceipt>>;
  chat(content: string, target?: ChatTarget): Promise<ReturnType<typeof verifyChatReceipt>>;
}
export interface OwnerMutationSurfaces {
  web: OwnerMutationActions & { assertState(): Promise<CompanySnapshot> };
  cli: OwnerMutationActions;
}

/** Actual installed-company mutations; caller owns the control window and final resume. */
export async function withOwnerMutationSurfaces<T>(dataRoot: string, outputDirectory: string, exercise: (surfaces: OwnerMutationSurfaces) => Promise<T>) {
  const client = new OwnerClient(dataRoot), initial = await client.state(), { discovery } = await readConnection(dataRoot);
  const session = await client.request<{ url: string }>('session', {});
  assert.equal(new URL(session.url).origin, new URL(discovery.url).origin, 'Unexpected browser session origin');
  const output = resolve(outputDirectory); await mkdir(output, { recursive: true });
  const evidence = { kind: 'installed-owner-surface-mutations', companyId: initial.company.id, url: discovery.url,
    startedAt: new Date().toISOString(), sourceIdentity: await ownerMutationSourceIdentity(),
    controls: [] as ReturnType<typeof verifyControlReceipt>[], chats: [] as ReturnType<typeof verifyChatReceipt>[],
    screenshots: [] as string[], browserErrors: [] as string[], passed: false, finishedAt: '', error: undefined as string | undefined, result: undefined as T | undefined };
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage(); page.on('pageerror', error => evidence.browserErrors.push(error.message));
  const assertState = async () => {
    const state = await client.state(); assert.equal(state.company.id, initial.company.id, 'Company identity changed');
    await expect(page.locator('.local-label')).toContainText('Local service connected', { timeout: 20_000 });
    await expect(page.locator('.topbar-state .badge')).toHaveText(state.company.state, { timeout: 15_000 });
    await expect(page.locator('.banner.error')).toHaveCount(0); return state;
  };
  const screenshot = async (name: string) => { const path = join(output, `surface-${name}.png`); await page.screenshot({ path, fullPage: true }); evidence.screenshots.push(path); };
  const route = async (name: string) => { await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name, exact: true }).click(); await expect(page.getByRole('heading', { name, level: 1, exact: true })).toBeVisible(); };
  const waitResponse = (path: string) => page.waitForResponse(response => response.url() === `${discovery.url}/api/v1/${path}` && response.request().method() === 'POST', { timeout: 35_000 });
  const web: OwnerMutationSurfaces['web'] = {
    assertState,
    async control(action) {
      const before = await assertState(); await route('Overview');
      const expectedBefore = action === 'pause' ? ['running'] : action === 'resume' ? ['paused'] : action === 'start' ? ['stopped', 'forming'] : ['running', 'paused', 'forming'];
      assert.ok(expectedBefore.includes(before.company.state), `WebUI ${action} is unavailable from ${before.company.state}; do not relabel a different action`);
      if (action === 'stop') { await page.getByRole('button', { name: 'Stop', exact: true }).click(); await expect(page.getByRole('alert').filter({ hasText: 'Stop company work?' })).toBeVisible(); }
      const label = { pause: 'Pause company', resume: 'Resume company', start: 'Start company', stop: 'Stop company' }[action];
      const [response] = await Promise.all([waitResponse('control'), page.getByRole('button', { name: label, exact: true }).click()]);
      expect(response.request().postDataJSON()).toEqual({ action }); expect(response.ok()).toBe(true);
      const snapshot = await response.json();
      const receipt = await waitForControlReceipt('webui', action, before, snapshot, signal => client.state(signal));
      verifyControlReceipt('webui', action, before, snapshot, await assertState());
      evidence.controls.push(receipt); await screenshot(`webui-${evidence.controls.length}-${action}`); return receipt;
    },
    async chat(content, target = {}) {
      const before = await assertState(); assert.ok(['paused', 'stopped'].includes(before.company.state), 'Acceptance chat requires a paused/stopped control window');
      assert.ok(!(target.employeeId && target.projectId), 'Select one conversation target');
      const ceo = before.employees.find(employee => employee.status === 'active' && before.positions.find(position => position.id === employee.positionId)?.level === 'ceo');
      await route('Conversations');
      const recipient = target.projectId ? `project:${target.projectId}` : target.employeeId && target.employeeId !== ceo?.id ? `employee:${target.employeeId}` : 'ceo';
      await page.getByLabel('Conversation', { exact: true }).selectOption(recipient);
      await page.getByLabel('Message', { exact: true }).fill(content);
      const [response] = await Promise.all([waitResponse('chat'), page.getByRole('button', { name: 'Send message', exact: true }).click()]);
      const expectedBody = { content: content.trim(), ...(target.projectId ? { projectId: target.projectId } : { employeeId: target.employeeId ?? ceo?.id }) };
      expect(response.request().postDataJSON()).toEqual(expectedBody); expect(response.ok()).toBe(true);
      const receipt = verifyChatReceipt('webui', before, await response.json(), await client.state(), content, target);
      await expect(page.getByLabel('Message', { exact: true })).toHaveValue(''); await expect(page.getByText(content.trim(), { exact: true })).toBeVisible();
      evidence.chats.push(receipt); await screenshot(`webui-chat-${evidence.chats.length}`); return receipt;
    },
  };
  const cli: OwnerMutationActions = {
    async control(action) {
      const before = await client.state(), response = await invokeCompiledOwnerCLI(dataRoot, [action]);
      const receipt = await waitForControlReceipt('compiled-cli', action, before, response, signal => client.state(signal));
      verifyControlReceipt('compiled-cli', action, before, response, await assertState()); evidence.controls.push(receipt); return receipt;
    },
    async chat(content, target = {}) {
      const before = await client.state(); assert.ok(['paused', 'stopped'].includes(before.company.state), 'Acceptance chat requires a paused/stopped control window');
      const response = await invokeCompiledOwnerCLI(dataRoot, ['chat', content, ...(target.employeeId ? ['--employee', target.employeeId] : []), ...(target.projectId ? ['--project', target.projectId] : [])]);
      const receipt = verifyChatReceipt('compiled-cli', before, response, await client.state(), content, target); evidence.chats.push(receipt); return receipt;
    },
  };
  let failure: unknown;
  try {
    await page.goto(session.url); await expect(page.getByRole('heading', { name: 'Overview', level: 1, exact: true })).toBeVisible(); await assertState();
    evidence.result = await exercise({ web, cli }); expect(evidence.browserErrors).toEqual([]); evidence.passed = true;
  } catch (error) { evidence.error = error instanceof Error ? error.message : String(error); failure = error; }
  finally {
    evidence.finishedAt = new Date().toISOString();
    const failures: string[] = [];
    try { await context.close(); } catch (error) { failures.push(String(error)); }
    try { await browser.close(); } catch (error) { failures.push(String(error)); }
    if (failures.length) { evidence.passed = false; evidence.error = [evidence.error, ...failures].filter(Boolean).join('; '); failure ??= new Error(`Surface browser cleanup failed: ${failures.join('; ')}`); }
    await writeFile(join(output, 'surface-mutations.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  }
  if (failure) throw failure;
  return evidence;
}

/** Exercises the running Owner API and production browser bundle. No fabricated records. */
export async function verifyOwnerWebUI(dataRoot: string, outputDirectory: string) {
  const client = new OwnerClient(dataRoot); const { discovery } = await readConnection(dataRoot);
  const session = await client.request<{ url: string }>('session', {});
  if (new URL(session.url).origin !== new URL(discovery.url).origin) throw new Error('Unexpected browser session origin');
  const state = await client.state();
  const output = resolve(outputDirectory); await mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage(); const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const visited: string[] = [];
  try {
    await page.goto(session.url); await expect(page.getByRole('heading', { name: 'Overview', exact: true, level: 1 })).toBeVisible();
    await expect(page.locator('.topbar-state .badge')).toHaveText(state.company.state);
    for (const product of state.products) await expect(page.getByRole('heading', { name: product.name, exact: true })).toBeVisible();
    await page.keyboard.press('Tab'); await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused(); await page.keyboard.press('Enter'); await expect(page.locator('main')).toBeFocused();
    expect(page.url()).not.toContain('#main-content');
    for (const name of ['Products', 'Projects', 'Organization', 'Conversations', 'Knowledge', 'Attention', 'Settings', 'Overview']) {
      await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name, exact: name !== 'Attention' }).click();
      await expect(page.getByRole('heading', { name, exact: true, level: 1 })).toBeVisible(); visited.push(name);
      await expect(page.locator('.banner.error')).toHaveCount(0);
    }
    const screenshots: string[] = [];
    const desktop = join(output, 'webui-overview.png'); await page.screenshot({ path: desktop, fullPage: true }); screenshots.push(desktop);
    await page.getByRole('navigation').getByRole('link', { name: 'Organization', exact: true }).click();
    if (state.employees[0]) {
      await page.locator(`a[href="#employees/${state.employees[0].id}"]`).first().click();
      await expect(page.getByRole('heading', { name: state.employees[0].name, exact: true, level: 1 }).first()).toBeVisible();
      await expect(page.locator('main')).toContainText(state.employees[0].id); visited.push('Employee detail');
    }
    if (state.projects[0]) {
      await page.getByRole('navigation').getByRole('link', { name: 'Projects', exact: true }).click();
      await page.locator(`a[href="#projects/${state.projects[0].id}"]`).first().click();
      await expect(page.getByRole('heading', { name: state.projects[0].name, exact: true })).toBeVisible(); visited.push('Project detail');
      const project = (await client.state()).projects.find(item => item.id === state.projects[0].id)!;
      for (const delivery of deliveriesFor(project)) {
        const receipt = page.locator(`[data-delivery-artifact="${delivery.artifactId}"]`);
        await expect(receipt).toHaveCount(1); await expect(receipt).toContainText(delivery.identity);
        if (delivery.mergeCommit) await expect(receipt).toContainText(delivery.mergeCommit);
      }
      for (const [index, criterion] of project.acceptance.entries()) {
        const row = page.locator(`[data-acceptance-index="${index}"]`);
        await expect(row).toContainText(criterion);
        const evidence = (project.completionEvidence as Array<{ criterion: string; rationale: string }> | undefined)?.find(item => item.criterion === criterion);
        await expect(row.locator('.badge')).toHaveText(evidence ? 'completed' : 'Remaining');
        if (evidence) await expect(row).toContainText(evidence.rationale);
      }
    }
    if (state.knowledge[0]) {
      await page.getByRole('navigation').getByRole('link', { name: 'Knowledge', exact: true }).click();
      await page.locator(`a[href="#knowledge/${state.knowledge[0].id}"]`).first().click();
      await expect(page.locator('.markdown-content')).not.toBeEmpty(); visited.push('Knowledge Markdown');
    }
    await page.getByRole('navigation').getByRole('link', { name: 'Overview', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('heading', { name: 'Overview', exact: true, level: 1 })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow, 'Mobile layout must not overflow horizontally').toBe(false);
    const mobile = join(output, 'webui-mobile.png'); await page.screenshot({ path: mobile, fullPage: true }); screenshots.push(mobile);
    expect(errors, 'Browser must render without runtime errors').toEqual([]);
    return { url: discovery.url, companyId: state.company.id, employeeIds: state.employees.map((employee) => employee.id), visited, screenshots, browserErrors: errors };
  } finally { await context.close(); await browser.close(); }
}

/** Caller restarts its isolated daemon at the same origin; this verifies persistent browser state. */
export async function verifyOwnerReconnect(dataRoot: string, restart: () => Promise<void>) {
  const client = new OwnerClient(dataRoot); const before = await client.state();
  if (!['paused', 'stopped', 'forming'].includes(before.company.state)) throw new Error('Pause the isolated acceptance company before a surface restart check.');
  const session = await client.request<{ url: string }>('session', {});
  const browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  try {
    await page.goto(session.url); await page.getByRole('navigation').getByRole('link', { name: 'Conversations', exact: true }).click();
    await page.getByLabel('Message', { exact: true }).fill('Preserved Owner context across daemon restart.');
    const disconnected = expect(page.locator('.local-label')).toContainText('Reconnecting', { timeout: 15_000 });
    await restart(); await disconnected;
    await expect(page.locator('.local-label')).toContainText('Local service connected', { timeout: 20_000 });
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Preserved Owner context across daemon restart.');
    await expect(page.getByRole('heading', { name: 'Conversations', level: 1 })).toBeVisible();
    const after = await client.state(); expect(after.company.id).toBe(before.company.id); expect(after.company.state).toBe(before.company.state);
    expect(after.employees.map((employee) => employee.id)).toEqual(before.employees.map((employee) => employee.id));
    return { companyId: after.company.id, state: after.company.state, identityPreserved: true, browserSessionPreserved: true, browserDraftPreserved: true };
  } finally { await browser.close(); }
}
