import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { wrapWorker } from './sandbox.js';
import { minimalEnvironment, prepareHome, shellQuote, spawnOwned, stopOwned } from './processes.js';
import type { ToolEnvironment } from './types.js';
import { OwnedLoopbackProxy } from './loopback.js';

export async function executeSandboxed(options: {
  workspace: string; command: string | string[]; runId?: string;
  dataRoot?: string; timeoutMs?: number; signal?: AbortSignal;
  gatewayPort?: number; serverPort?: number;
  readPaths?: string[];
  toolEnvironment?: ToolEnvironment;
  localTestNetwork?: boolean;
}): Promise<{ code: number; stdout: string; stderr: string }> {
  const dataRoot = options.dataRoot ?? join(homedir(), '.local', 'share', 'opencorp');
  const runId = options.runId ?? randomUUID();
  const home = join(dataRoot, 'runtime', 'tools', runId);
  await prepareHome(home);
  const denialServer = options.gatewayPort ? undefined : createServer((_request, response) => { response.writeHead(403); response.end('Network outside approved broker denied'); });
  if (denialServer) await new Promise<void>((resolve) => denialServer.listen(0, '127.0.0.1', resolve));
  const address = denialServer?.address();
  const gatewayPort = options.gatewayPort ?? (address && typeof address !== 'string' ? address.port : 0);
  if (!gatewayPort) throw new Error('No sandbox network boundary');
  let child: Awaited<ReturnType<typeof spawnOwned>> | undefined;
  const localTestProxy = options.localTestNetwork ? new OwnedLoopbackProxy() : undefined;
  await localTestProxy?.start();
  try {
    const script = await wrapWorker({ runId, workspace: options.workspace, home,
      command: typeof options.command === 'string' ? options.command : options.command.map(shellQuote).join(' '),
      gatewayPort, serverPort: options.serverPort, readPaths: options.readPaths, toolEnvironment: options.toolEnvironment, localTestProxy });
    let stdout = '', stderr = '';
    child = await spawnOwned({ controlRoot: join(dataRoot, 'runtime', 'control'),
      command: '/bin/bash', args: ['--noprofile', '--norc', '-c', script],
      cwd: options.workspace, env: minimalEnvironment(home), signal: options.signal });
    if (localTestProxy) localTestProxy.receiptPath = child.receiptPath;
    child.stdout?.on('data', (chunk: Buffer) => { stdout = (stdout + chunk).slice(-1000000); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk).slice(-1000000); });
    let cancelled = false, timedOut = false;
    const cancel = (): void => { cancelled = true; void stopOwned(child).catch(() => { /* The final absence check below propagates uncertainty. */ }); };
    options.signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => { timedOut = true; cancel(); }, options.timeoutMs ?? 120000);
    try {
      const code = await new Promise<number>((resolve, reject) => {
        child!.once('error', reject);
        child!.once('exit', (code) => resolve(code ?? 1));
        if (options.signal?.aborted) cancel();
      });
      return { code: timedOut ? 124 : cancelled ? 130 : code, stdout, stderr };
    } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); }
  } finally { await localTestProxy?.close(); await stopOwned(child); denialServer?.closeAllConnections(); denialServer?.close(); }
}
