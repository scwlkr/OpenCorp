import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { access, mkdir, open, readFile, writeFile, readdir } from 'node:fs/promises';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);

export interface ProcessIdentity { pid: number; unique: number; coalition: number; uid: number; startedSeconds: number; startedMicros: number; bootSeconds: number; bootMicros: number }
export interface ProcessReceipt {
  label: string; helper: string; state: 'intent' | 'running' | 'exited' | 'uncertain';
  owner: ProcessIdentity; guardian?: ProcessIdentity; childPid?: number;
  code?: number; reason?: string; updatedAt: string;
  dispatched?: boolean;
}

// The guardian runs in its own launchd resource coalition, outside the worker
// sandbox. Kernel membership survives setsid, detached spawn and double-fork.
const guardian = `
const fs=require('node:fs'),cp=require('node:child_process');
const spec=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
function native(args){return JSON.parse(cp.execFileSync(spec.helper,args,{encoding:'utf8',timeout:5000}))}
function save(value){const temp=spec.receiptPath+'.tmp';const fd=fs.openSync(temp,'w',0o600);fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);fs.closeSync(fd);fs.renameSync(temp,spec.receiptPath)}
const self=native([String(process.pid)]);
const parent=native([String(spec.owner.pid)]);
const receipt={label:spec.label,helper:spec.helper,owner:spec.owner,guardian:self,dispatched:true,state:'running',updatedAt:new Date().toISOString()};
if(!self.coalition||self.coalition===spec.owner.coalition||parent.unique!==spec.owner.unique){save({...receipt,state:'uncertain',reason:'Launch ownership could not be established'});process.exit(1)}
save(receipt);
let ending=false,child,timer;
function end(code){if(ending)return;ending=true;clearInterval(timer);let clean=false;try{clean=native(['terminate',String(self.coalition),String(self.pid),String(self.unique)]).status==='absent'}catch(e){receipt.reason=String(e.message)};save({...receipt,state:clean?'exited':'uncertain',code:clean?code:1,updatedAt:new Date().toISOString()});process.exit(clean?code:1)}
process.on('SIGTERM',()=>end(130));process.on('SIGINT',()=>end(130));
child=cp.spawn(spec.command,spec.args,{cwd:spec.cwd,env:spec.env,stdio:'inherit'});
receipt.childPid=child.pid;save(receipt);
child.on('error',e=>{receipt.reason=e.message;end(1)});
child.on('exit',code=>end(code??1));
timer=setInterval(()=>{try{if(native([String(spec.owner.pid)]).unique!==spec.owner.unique)end(130)}catch{end(130)}},1000);
`;

export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const xml = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

export function minimalEnvironment(home: string): NodeJS.ProcessEnv {
  const nodeBin = dirname(process.execPath);
  return {
    HOME: home, USER: 'opencorp', LOGNAME: 'opencorp',
    PATH: `${nodeBin}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    SHELL: '/bin/bash', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8',
    TMPDIR: join(home, 'tmp'), XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache'),
    XDG_STATE_HOME: join(home, 'state'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/false', SSH_ASKPASS: '/usr/bin/false', CI: '1', NO_COLOR: '1',
  };
}

async function nativeHelper(controlRoot: string): Promise<string> {
  const source = resolve(dirname(require.resolve('opencode-ai/package.json')), '..', '..', 'src/runtime/process-identity.c');
  const hash = createHash('sha256').update(await readFile(source)).digest('hex').slice(0,16);
  const binary = join(controlRoot, `process-identity-${hash}`);
  try { await access(binary); return binary; } catch { /* Compile the pinned local helper. */ }
  await exec('/usr/bin/clang', ['-O2', '-Wall', '-Wextra', '-Werror', source, '-o', binary], { timeout: 30000 });
  return binary;
}

export async function inspectProcess(helper: string, pid: number): Promise<ProcessIdentity | { status: 'absent' | 'uncertain' }> {
  try { return JSON.parse((await exec(helper, [String(pid)], { timeout: 5000 })).stdout); }
  catch { return { status: 'uncertain' }; }
}

async function durableWrite(path: string, value: unknown): Promise<void> {
  const file = await open(path, 'w', 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
}

export class OwnedProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  pid?: number;
  private ended = false;
  private offsets = [0, 0];
  private polling?: ReturnType<typeof setInterval>;
  private reading = false;
  constructor(readonly receiptPath: string, readonly label: string, private readonly logs: [string,string]) { super(); }

  begin(): void {
    this.polling = setInterval(() => { void this.poll(); }, 50);
    void this.poll();
  }
  private async poll(): Promise<void> {
    if (this.reading || this.ended) return;
    this.reading = true;
    try {
      for (let n=0;n<2;n++) {
        const data = await readFile(this.logs[n]!).catch(() => Buffer.alloc(0));
        if (data.length > this.offsets[n]!) (n === 0 ? this.stdout : this.stderr).write(data.subarray(this.offsets[n]));
        this.offsets[n] = data.length;
      }
      const receipt = JSON.parse(await readFile(this.receiptPath, 'utf8')) as ProcessReceipt;
      this.pid = receipt.guardian?.pid;
      if (receipt.state === 'exited' || receipt.state === 'uncertain') {
        this.ended = true; clearInterval(this.polling);
        this.exitCode = receipt.state === 'exited' ? receipt.code ?? 1 : 1;
        await exec('/bin/launchctl', ['bootout', `gui/${process.getuid!()}/${this.label}`], { timeout: 3000 }).catch(() => {});
        this.stdout.end(); this.stderr.end(); this.emit('exit', this.exitCode, null);
      }
    } catch { /* Atomic receipt replacement/startup may not be visible yet. */ }
    finally { this.reading = false; }
  }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    void (async () => {
      const receipt = JSON.parse(await readFile(this.receiptPath, 'utf8')) as ProcessReceipt;
      if (!receipt.guardian) return;
      const identity = await inspectProcess(receipt.helper, receipt.guardian.pid);
      if ('status' in identity || identity.unique !== receipt.guardian.unique) return;
      process.kill(identity.pid, signal);
    })().catch(() => {});
    return true;
  }
}

export async function spawnOwned(options: {
  controlRoot: string; command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
  receiptPath?: string; signal?: AbortSignal; onOutput?: (chunk: string) => void;
}): Promise<OwnedProcess> {
  options.signal?.throwIfAborted();
  await mkdir(options.controlRoot, { recursive: true, mode: 0o700 });
  const helper = await nativeHelper(options.controlRoot);
  options.signal?.throwIfAborted();
  const owner = await inspectProcess(helper, process.pid);
  if ('status' in owner) throw new Error('Native process ownership unavailable; refusing unowned execution');
  const id = randomUUID(), label = `com.opencorp.process.${id}`;
  const jobRoot = join(options.controlRoot, 'jobs', id);
  await mkdir(jobRoot, { recursive: true, mode: 0o700 });
  const guardPath = join(jobRoot, 'guardian.cjs');
  const specPath = join(jobRoot, 'spec.json');
  const receiptPath = options.receiptPath ?? join(jobRoot, 'receipt.json');
  const logs: [string,string] = [join(jobRoot,'stdout.log'), join(jobRoot,'stderr.log')];
  const spec = { ...options, owner, helper, label, receiptPath }; delete (spec as Record<string,unknown>).signal; delete (spec as Record<string,unknown>).onOutput;
  await writeFile(guardPath, guardian, { mode: 0o600 });
  await durableWrite(specPath, spec);
  const intent = { label, helper, owner, state: 'intent', dispatched: false, updatedAt: new Date().toISOString() };
  await durableWrite(receiptPath, intent);
  const plistPath = join(jobRoot, 'job.plist');
  const args = [process.execPath, guardPath, specPath];
  await writeFile(plistPath, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map(a=>`<string>${xml(a)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>ExitTimeOut</key><integer>3</integer><key>StandardOutPath</key><string>${xml(logs[0])}</string><key>StandardErrorPath</key><string>${xml(logs[1])}</string></dict></plist>`, { mode: 0o600 });
  if (options.signal?.aborted) {
    await durableWrite(receiptPath, { ...intent, state: 'exited', code: 130 });
    options.signal.throwIfAborted();
  }
  await durableWrite(receiptPath, { ...intent, dispatched: true });
  await exec('/bin/launchctl', ['bootstrap', `gui/${process.getuid!()}`, plistPath], { timeout: 10000 });
  const child = new OwnedProcess(receiptPath, label, logs);
  child.stdout.on('data', (chunk: Buffer) => options.onOutput?.(chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => options.onOutput?.(chunk.toString()));
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as ProcessReceipt;
    if (receipt.guardian) {
      child.pid = receipt.guardian.pid; child.begin();
      if (options.signal?.aborted) { await stopOwned(child); options.signal.throwIfAborted(); }
      return child;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  await exec('/bin/launchctl', ['bootout', `gui/${process.getuid!()}/${label}`], { timeout: 3000 }).catch(() => {});
  throw new Error(`Owned launchd guardian did not establish native identity. Receipt: ${receiptPath}; stderr: ${await readFile(logs[1], 'utf8').catch(()=>'')}`);
}

export async function recoverOwnedReceipt(receiptPath: string, reapOrphan = false): Promise<{ status: 'absent' | 'running' | 'uncertain'; receiptPath: string; members?: ProcessIdentity[] }> {
  let receipt: ProcessReceipt;
  try { receipt = JSON.parse(await readFile(receiptPath, 'utf8')); }
  catch { return { status: 'uncertain', receiptPath }; }
  const runtimeIndex = receiptPath.lastIndexOf('/runtime/');
  const expectedControl = join(receiptPath.slice(0, runtimeIndex), 'runtime', 'control');
  if (runtimeIndex < 0 || dirname(receipt.helper) !== expectedControl || !/\/process-identity-[a-f0-9]{16}$/.test(receipt.helper) ||
      !/^com\.opencorp\.process\.[a-f0-9-]{36}$/.test(receipt.label) || !Number.isSafeInteger(receipt.owner?.unique)) return { status: 'uncertain', receiptPath };
  if (!receipt.guardian || !receipt.guardian.coalition) {
    const owner = await inspectProcess(receipt.helper, receipt.owner.pid);
    if (receipt.dispatched === false && (receipt.state === 'exited' || ('status' in owner && owner.status === 'absent') || (!('status' in owner) && owner.unique !== receipt.owner.unique))) return { status: 'absent', receiptPath, members: [] };
    return { status: 'uncertain', receiptPath };
  }
  if (!Number.isSafeInteger(receipt.guardian.unique) || !Number.isSafeInteger(receipt.guardian.bootSeconds) || !Number.isSafeInteger(receipt.guardian.bootMicros)) return { status: 'uncertain', receiptPath };
  try {
    const self = await inspectProcess(receipt.helper, process.pid);
    if ('status' in self) return { status: 'uncertain', receiptPath };
    if (receipt.guardian.bootSeconds !== self.bootSeconds || receipt.guardian.bootMicros !== self.bootMicros) return { status: 'absent', receiptPath, members: [] };
    const before = await observeMembers(receipt);
    if (before.status !== 'observed') return { status: 'uncertain', receiptPath };
    if (!before.members?.length) return { status: 'absent', receiptPath, members: [] };
    const guardian = await inspectProcess(receipt.helper, receipt.guardian.pid);
    if (('status' in guardian && guardian.status === 'uncertain') || (!('status' in guardian) &&
      (guardian.unique !== receipt.guardian.unique || guardian.coalition !== receipt.guardian.coalition))) return { status: 'uncertain', receiptPath };
    const owner = await inspectProcess(receipt.helper, receipt.owner.pid);
    if (reapOrphan && (('status' in owner && owner.status === 'absent') || (!('status' in owner) && owner.unique !== receipt.owner.unique))) {
      await terminateReceipt(receipt);
      await durableWrite(receiptPath, { ...receipt, state: 'exited', code: 130, updatedAt: new Date().toISOString() });
    }
    const result = await observeMembers(receipt);
    if (result.status !== 'observed') return { status: 'uncertain', receiptPath };
    if (!result.members?.length) return { status: 'absent', receiptPath, members: [] };
    return { status: 'running', receiptPath, members: result.members };
  } catch { return { status: 'uncertain', receiptPath }; }
}

export interface ToolRecovery {
  status: 'absent' | 'running' | 'uncertain';
  jobs: Array<{ workspace?: string; receiptPath: string; status: 'absent' | 'running' | 'uncertain' }>;
}

/** Account for every owned native job before scheduler reclaim, including
 * dependency preparation and canonical tools which predate employee dispatch. */
export async function recoverOwnedJobs(dataRoot: string): Promise<ToolRecovery> {
  const controlRoot = resolve(dataRoot, 'runtime/control');
  const jobsRoot = join(controlRoot, 'jobs');
  const jobs: ToolRecovery['jobs'] = [];
  let entries;
  try { entries = await readdir(jobsRoot, { withFileTypes: true }); }
  catch (error) { return { status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'uncertain', jobs: (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : [{ receiptPath: jobsRoot, status: 'uncertain' }] }; }
  for (const entry of entries) {
    const jobRoot = join(jobsRoot, entry.name);
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) { jobs.push({ receiptPath: jobRoot, status: 'uncertain' }); continue; }
    let spec: { cwd?: unknown; receiptPath?: unknown; label?: unknown; helper?: unknown };
    try { spec = JSON.parse(await readFile(join(jobRoot, 'spec.json'), 'utf8')); }
    catch (error) {
      // spawnOwned cannot bootstrap before spec + receipt + plist are written.
      // A directory abandoned before a plist was written has no launch intent.
      let dispatched = true;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        try { await access(join(jobRoot, 'job.plist')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') dispatched = false; }
      }
      jobs.push({ receiptPath: join(jobRoot, 'receipt.json'), status: dispatched ? 'uncertain' : 'absent' }); continue;
    }
    const workspace = typeof spec.cwd === 'string' ? resolve(spec.cwd) : undefined;
    const receiptPath = typeof spec.receiptPath === 'string' ? resolve(spec.receiptPath) : join(jobRoot, 'receipt.json');
    if (!workspace || spec.label !== `com.opencorp.process.${entry.name}` || typeof spec.helper !== 'string' || dirname(spec.helper) !== controlRoot
      || !receiptPath.startsWith(resolve(dataRoot, 'runtime') + '/')) {
      jobs.push({ workspace, receiptPath, status: 'uncertain' }); continue;
    }
    const result = await recoverOwnedReceipt(receiptPath, true);
    jobs.push({ workspace, receiptPath, status: result.status });
  }
  return { status: jobs.some(job => job.status === 'uncertain') ? 'uncertain' : jobs.some(job => job.status === 'running') ? 'running' : 'absent', jobs };
}

async function terminateReceipt(receipt: ProcessReceipt): Promise<void> {
  if (!receipt.guardian?.bootSeconds) throw new Error('Native ownership receipt incomplete');
  let absent = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const result = JSON.parse((await exec(receipt.helper, ['cleanup', String(receipt.guardian.coalition),
        String(receipt.guardian.bootSeconds), String(receipt.guardian.bootMicros)], { timeout: 5000 })).stdout);
      if (result.status === 'absent') { absent = true; break; }
    } catch { /* A dying process can briefly lack complete libproc metadata. */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!absent) throw new Error('Owned coalition cleanup remains uncertain');
  await exec('/bin/launchctl', ['bootout', `gui/${process.getuid!()}/${receipt.label}`], { timeout: 3000 }).catch(() => {});
}

async function observeMembers(receipt: ProcessReceipt): Promise<{ status: string; members?: ProcessIdentity[] }> {
  // Retry observation, never infer absence from elapsed time. This also handles
  // receipts referencing older helper versions during a rolling local upgrade.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const observed = JSON.parse((await exec(receipt.helper, ['members', String(receipt.guardian!.coalition)], { timeout: 5000 })).stdout);
      if (observed.status === 'observed') return observed;
    } catch { /* Preserve uncertainty unless a fresh native enumeration succeeds. */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return { status: 'uncertain' };
}

export async function stopOwned(child: OwnedProcess | undefined): Promise<void> {
  if (!child) return;
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3500);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  let observed = await recoverOwnedReceipt(child.receiptPath);
  if (observed.status === 'running') {
    const receipt = JSON.parse(await readFile(child.receiptPath, 'utf8')) as ProcessReceipt;
    await terminateReceipt(receipt);
    await durableWrite(child.receiptPath, { ...receipt, state: 'exited', code: 130, updatedAt: new Date().toISOString() });
    observed = await recoverOwnedReceipt(child.receiptPath);
  }
  if (observed.status !== 'absent') throw new Error(`Owned process tree absence unconfirmed; quarantine workspace. Receipt: ${child.receiptPath}`);
}

export async function prepareHome(home: string): Promise<void> {
  for (const dir of ['', 'tmp', 'config', 'data', 'cache', 'state']) await mkdir(join(home, dir), { recursive: true, mode: 0o700 });
}
