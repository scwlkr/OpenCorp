import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const fixture = vi.hoisted(() => {
  const home = `/tmp/opencorp-service-test-${process.pid}-${Math.random().toString(16).slice(2)}`;
  return { home, source: `${home}/source` };
});
vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof import('node:os')>(), homedir: () => fixture.home }));
vi.mock('../src/server/paths.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/server/paths.js')>(), sourceRoot: fixture.source }));
vi.mock('../src/tools/process.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/tools/process.js')>(), runProcess: vi.fn() }));
import { serviceInstall } from '../src/server/service.js';
import { runProcess, type ProcessResult } from '../src/tools/process.js';

const dataRoot = join(fixture.home, '.local/share/opencorp');
const plist = join(fixture.home, 'Library/LaunchAgents/com.opencorp.company.plist');
const executable = join(fixture.home, '.local/bin/opencorp');
const missing: ProcessResult = { code: 113, stdout: '', stderr: 'Bad request.\nCould not find service "com.opencorp.company" in domain for user gui: 501' };
const ok: ProcessResult = { code: 0, stdout: '', stderr: '' };
const failed: ProcessResult = { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' };
let registered: 'yes' | 'no' | 'unknown', pid: number | undefined, healthyPid: number | null;
let calls: Array<{ verb: string; at: number }>;
let onBootstrap: () => ProcessResult | Promise<ProcessResult>, onBootout: () => ProcessResult | Promise<ProcessResult>;
function discovery(processId: number) { writeFileSync(join(dataRoot, 'discovery.json'), JSON.stringify({ url: 'http://127.0.0.1:4310', pid: processId, startedAt: new Date().toISOString() })); }
function running(processId = 12345) { registered = 'yes'; pid = processId; healthyPid = processId; discovery(processId); }
function count(verb: string) { return calls.filter(call => call.verb === verb).length; }
async function install() {
  const pending = serviceInstall(dataRoot).then(value => ({ value, error: undefined }), error => ({ value: undefined, error: error as Error }));
  await vi.runAllTimersAsync(); return pending;
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-10T22:04:40Z'));
  mkdirSync(join(fixture.source, 'dist/server'), { recursive: true }); mkdirSync(join(fixture.source, 'bin'), { recursive: true });
  writeFileSync(join(fixture.source, 'dist/server/main.js'), '// Unexecuted test fixture'); writeFileSync(join(fixture.source, 'bin/opencorp'), '#!/bin/sh\n');
  mkdirSync(dataRoot, { recursive: true }); writeFileSync(join(dataRoot, 'company.sqlite'), 'PRESERVED COMPANY'); discovery(11111);
  mkdirSync(join(fixture.home, 'Library/LaunchAgents'), { recursive: true }); writeFileSync(plist, 'OLD PLIST');
  registered = 'no'; pid = undefined; healthyPid = null; calls = [];
  onBootstrap = () => { running(); return ok; }; onBootout = () => { registered = 'no'; healthyPid = null; return ok; };
  vi.mocked(runProcess).mockReset().mockImplementation(async (file, args) => {
    expect(file).toBe('/bin/launchctl'); calls.push({ verb: args[0], at: Date.now() });
    if (args[0] === 'bootstrap') return onBootstrap();
    if (args[0] === 'bootout') return onBootout();
    if (args[0] === 'print') {
      if (registered === 'no') return missing;
      if (registered === 'unknown') return { code: 128, stdout: '', stderr: 'launchctl print did not finish' };
      return { code: 0, stdout: `com.opencorp.company = {\n${pid ? `\tpid = ${pid}\n` : ''}}\n`, stderr: '' };
    }
    throw new Error(`Unexpected launchctl action ${args[0]}`);
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ application: 'OpenCorp', pid: healthyPid }), { status: healthyPid ? 200 : 503 }));
  // Even a regression must never send a real signal during this fixture suite.
  vi.spyOn(process, 'kill').mockImplementation(() => { healthyPid = null; return true; });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); rmSync(fixture.home, { recursive: true, force: true }); });

describe('bounded LaunchAgent replacement', () => {
  it('waits for the old registration to disappear before attempting a replacement', async () => {
    registered = 'yes'; pid = 22222;
    onBootout = () => { setTimeout(() => { registered = 'no'; }, 600); return ok; };
    const start = Date.now(), result = await install();
    expect(result.error).toBeUndefined(); expect(result.value?.running).toBe(true); expect(count('bootout')).toBe(1); expect(count('bootstrap')).toBe(1);
    expect(calls.find(call => call.verb === 'bootstrap')!.at - start).toBeGreaterThanOrEqual(600);
    expect(readFileSync(join(dataRoot, 'company.sqlite'), 'utf8')).toBe('PRESERVED COMPANY');
    expect(readlinkSync(executable)).toBe(join(fixture.source, 'bin/opencorp'));
  });
  it('recovers the observed error 5 race with one delayed retry after confirmed absence', async () => {
    onBootstrap = () => { if (count('bootstrap') === 1) return failed; running(); return ok; };
    const result = await install();
    expect(result.error).toBeUndefined(); expect(result.value?.installed).toBe(true); expect(result.value?.running).toBe(true); expect(count('bootstrap')).toBe(2);
    const attempts = calls.filter(call => call.verb === 'bootstrap'); expect(attempts[1].at - attempts[0].at).toBeGreaterThanOrEqual(1000);
    expect(calls.slice(calls.indexOf(attempts[0]) + 1, calls.indexOf(attempts[1])).filter(call => call.verb === 'print')).toHaveLength(2);
  });
  it('reconciles a failed bootstrap that actually registered and became healthy without retrying', async () => {
    onBootstrap = () => { registered = 'yes'; pid = undefined; setTimeout(() => running(), 2000); return failed; };
    const result = await install();
    expect(result.error).toBeUndefined(); expect(result.value?.running).toBe(true); expect(count('bootstrap')).toBe(1);
  });
  it('reconciles registration after a thrown bootstrap transport error', async () => {
    onBootstrap = () => { running(); throw new Error('Transport ended without a result'); };
    const result = await install(); expect(result.error).toBeUndefined(); expect(count('bootstrap')).toBe(1);
  });
  it('rechecks absence immediately before retry so a late registration is not bootstrapped twice', async () => {
    onBootstrap = () => { setTimeout(() => running(), 500); return failed; };
    const result = await install(); expect(result.error).toBeUndefined(); expect(result.value?.running).toBe(true); expect(count('bootstrap')).toBe(1);
  });
  it('does not retry when registration is uncertain after the failed bootstrap', async () => {
    onBootstrap = () => { registered = 'unknown'; return failed; };
    const result = await install(); expect(result.error?.message).toContain('uncertain; no retry'); expect(count('bootstrap')).toBe(1);
  });
  it('does not treat an unrelated print error as proof that this registration is absent', async () => {
    vi.mocked(runProcess).mockResolvedValue({ code: 113, stdout: '', stderr: 'Could not find domain for user gui: 501' });
    const result = await install(); expect(result.error?.message).toContain('Cannot establish existing LaunchAgent registration');
    expect(vi.mocked(runProcess).mock.calls.map(call => call[1][0])).toEqual(['print']);
    expect(readFileSync(plist, 'utf8')).toBe('OLD PLIST');
  });
  it('stops after the single absence-confirmed retry also fails', async () => {
    onBootstrap = () => failed;
    const result = await install(); expect(result.error?.message).toContain('after one retry with confirmed absence'); expect(count('bootstrap')).toBe(2);
  });
  it('does not confuse a healthy old daemon with the PID registered by launchd', async () => {
    onBootstrap = () => { registered = 'yes'; pid = 33333; healthyPid = 11111; return failed; };
    const result = await install(); expect(result.error?.message).toContain('registered PID'); expect(count('bootstrap')).toBe(1);
  });
  it('does not replace a registration whose removal is unconfirmed', async () => {
    registered = 'yes'; pid = 22222; onBootout = () => ({ ...failed, stderr: 'Boot-out outcome uncertain' });
    const result = await install(); expect(result.error?.message).toContain('removal was not confirmed'); expect(count('bootstrap')).toBe(0);
    expect(readFileSync(plist, 'utf8')).toBe('OLD PLIST');
  });
  it('preserves an unrelated installed executable before any launchd action', async () => {
    mkdirSync(join(fixture.home, '.local/bin'), { recursive: true }); writeFileSync(executable, 'UNRELATED EXECUTABLE');
    const result = await install(); expect(result.error?.message).toContain('Preserved existing'); expect(calls).toEqual([]);
    expect(readFileSync(executable, 'utf8')).toBe('UNRELATED EXECUTABLE'); expect(existsSync(plist)).toBe(true);
  });
  it('preserves an unrelated executable symlink and its target', async () => {
    mkdirSync(join(fixture.home, '.local/bin'), { recursive: true }); const target = join(fixture.home, 'other-cli'); writeFileSync(target, 'OTHER CLI'); symlinkSync(target, executable);
    const result = await install(); expect(result.error?.message).toContain('Preserved existing'); expect(calls).toEqual([]);
    expect(readlinkSync(executable)).toBe(target); expect(readFileSync(target, 'utf8')).toBe('OTHER CLI');
  });
});
