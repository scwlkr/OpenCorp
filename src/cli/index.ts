import { Command } from 'commander';
import { execFile } from 'node:child_process';
import { promisify, stripVTControlCharacters } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { dataDirectory, OwnerClient, readConnection } from './client.js';
import { ensureDaemon, serviceInstall, serviceUninstall, serviceStatus } from '../server/service.js';

const invoke = promisify(execFile);
export function output(value: unknown, json = false): void {
  if (json) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); return; }
  const writePlain = (text: string) => process.stdout.write(stripVTControlCharacters(text));
  if (typeof value !== 'object' || value === null) { writePlain(`${String(value)}\n`); return; }
  if (Array.isArray(value)) {
    if (!value.length) { writePlain('No records.\n'); return; }
    for (const row of value) {
      if (!row || typeof row !== 'object') { writePlain(`${String(row)}\n`); continue; }
      const record = row as Record<string, unknown>;
      const title = record.name || record.title || record.subject || record.type || record.id || 'Record';
      const state = record.status || record.state;
      writePlain(`${String(title)}${state ? ` · ${String(state)}` : ''}\n`);
      if (record.id) writePlain(`  ID: ${String(record.id)}\n`);
      for (const key of ['assessment', 'rationale', 'detail', 'requiredAction']) if (record[key]) writePlain(`  ${String(record[key])}\n`);
    }
    return;
  }
  const record = value as Record<string, any>;
  if (record.company && record.policy && Array.isArray(record.assignments)) {
    const work = record.assignments as Array<{ title: string; status: string }>;
    writePlain(`${record.company.name} · ${record.company.state}\n`);
    writePlain(`${record.products.length} products · ${record.employees.length} employees · ${work.filter((item) => item.status === 'running').length} running · ${work.filter((item) => item.status === 'queued').length} queued · ${work.filter((item) => item.status === 'completed').length} completed\n`);
    writePlain(`Local inference: ${record.runs.filter((item: { status: string }) => item.status === 'running').length}/${record.policy.maxInference} slots · Unapproved spending: $${record.policy.spendingLimit}\n`);
    for (const item of work.filter((item) => !['completed', 'cancelled'].includes(item.status))) writePlain(`  ${item.status}: ${item.title}\n`);
    for (const item of record.attention.filter((item: { status: string }) => item.status === 'open')) writePlain(`  Attention: ${item.title} — ${item.requiredAction || item.detail}\n`);
    return;
  }
  writePlain(`${JSON.stringify(value, null, 2)}\n`);
}
export function createProgram(): Command {
  const program = new Command().name('opencorp').description('Your persistent local company. All interfaces use the same company service.')
    .version('0.1.0').configureHelp({ showGlobalOptions: true }).option('--data-dir <path>', 'Company data directory (default: OPENCORP_DATA_DIR or ~/.local/share/opencorp)')
    .option('--json', 'Print machine-readable JSON');
  const config = () => program.opts<{ dataDir?: string; json?: boolean }>();
  const root = () => dataDirectory(config().dataDir);
  const client = () => new OwnerClient(root());
  const show = (value: unknown) => output(value, config().json);
  program.command('init').description('Initialize the persistent company and start its local service').action(async () => { await ensureDaemon(root()); show(await client().state()); });
  program.command('start').description('Start the service and explicitly start company work').action(async () => { await ensureDaemon(root()); show(await client().control('start')); });
  program.command('status').description('Show actual company state, work, policy, and resources').action(async () => show(await client().state()));
  for (const action of ['full', 'low', 'pause', 'resume', 'stop'] as const) program.command(action).description(({ full: 'Full power: use configured available throughput', low: 'Low power: one lightweight local or permitted hosted turn', pause: 'Pause dispatch and cancel active model turns; preserve work', resume: 'Resume company work after a pause', stop: 'Stop company work and owned runtimes; preserve intentional stop across restarts' })[action]).action(async () => show(await client().control(action)));
  program.command('open').description('Open the authenticated Owner WebUI').action(async () => {
    await ensureDaemon(root()); const { discovery } = await readConnection(root());
    const session = await client().request<{ url: string }>('session', {});
    if (new URL(session.url).origin !== new URL(discovery.url).origin) throw new Error('Service returned an unrelated login destination.');
    await invoke('/usr/bin/open', [session.url]);
    show({ opened: true, url: discovery.url });
  });
  program.command('tui').description('Open the live operational terminal interface').action(async () => { const { launchTui } = await import('../tui/index.js'); await launchTui(client()); });
  program.command('chat').description('Send a durable message to the CEO, employee, or project').argument('<message...>', 'Message content')
    .option('--employee <id>', 'Employee recipient').option('--project <id>', 'Project discussion').action(async (words: string[], options: { employee?: string; project?: string }) => show(await client().chat(words.join(' '), { employeeId: options.employee, projectId: options.project })));
  for (const name of ['products', 'projects', 'employees', 'departments', 'workplace', 'recruitment', 'decisions', 'attention', 'models', 'integrations', 'logs'] as const) program.command(name).description(`List company ${name} from the service`).action(async () => show(await client().request(name)));
  program.command('command').description('Execute an authenticated Owner company command as JSON, including workplace and responsibility controls').argument('<json>', 'JSON object containing type and command fields').action(async (json:string) => { const command:unknown=JSON.parse(json); if(!command||typeof command!=='object'||Array.isArray(command)||typeof (command as {type?:unknown}).type!=='string')throw new Error('Command must be a JSON object containing type.'); show(await client().request('command',command)); });
  program.command('telegram-reconcile').description('Reconcile a held Telegram send after inspecting the private chat').argument('<actionId>').argument('<outcome>', 'delivered or absent').argument('<evidence>').action(async(actionId:string,outcome:string,evidence:string)=>show(await client().request('telegram/reconcile',{actionId,outcome,evidence})));
  program.command('email-reconcile').description('Reconcile a held email send after inspecting delivery records and the Owner mailbox').argument('<actionId>').argument('<outcome>', 'delivered or absent').argument('<evidence>').action(async(actionId:string,outcome:string,evidence:string)=>show(await client().request('email/reconcile',{actionId,outcome,evidence})));
  program.command('doctor').description('Check actual runtime, models, integrations, service, and prerequisites').action(async () => show(await client().request('doctor')));
  program.command('backup').description('Create a consistent database and knowledge snapshot').action(async () => show(await client().request('backup', {})));
  program.command('restore').description('Restore a backup with external actions quarantined for reconciliation').argument('<path>', 'Backup directory').action(async (path: string) => show(await client().request('restore', { path: resolve(path) })));
  const service = program.command('service').description('Manage the macOS user LaunchAgent (company data is retained)');
  service.command('install').description('Install and load the user service with pinned toolchain').action(async () => show(await serviceInstall(root())));
  service.command('uninstall').description('Stop owned processes and remove LaunchAgent; retain company data').action(async () => show(await serviceUninstall(root())));
  service.command('status').description('Inspect LaunchAgent and service discovery').action(async () => show(await serviceStatus(root())));
  return program;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const program = createProgram();
  try { await program.parseAsync(); } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (program.opts<{ json?: boolean }>().json) process.stdout.write(`${JSON.stringify({ error: { message } })}\n`);
    else process.stderr.write(`OpenCorp: ${stripVTControlCharacters(message)}\n`);
    process.exitCode = 1;
  }
}
