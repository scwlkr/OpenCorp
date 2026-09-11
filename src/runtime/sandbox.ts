import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { realpath } from 'node:fs/promises';
import { wrapCommandWithSandboxMacOS } from '@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js';
import { shellQuote } from './processes.js';
import type { ToolEnvironment } from './types.js';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
export const dependenciesRoot = resolve(dirname(require.resolve('opencode-ai/package.json')), '..');
export const opencodeBinary = join(dependenciesRoot, 'opencode-ai', 'bin', 'opencode.exe');

export interface WorkerSandbox {
  command: string;
  runId: string;
  workspace: string;
  home: string;
  gatewayPort: number;
  serverPort?: number;
  readPaths?: string[];
  toolEnvironment?: ToolEnvironment;
  localTestProxy?: { port: number; url: string };
}

export async function wrapWorker(options: WorkerSandbox): Promise<string> {
  if (process.platform !== 'darwin') throw new Error('This release requires macOS native sandbox-exec. Refusing unsandboxed execution.');
  const workspace = await realpath(options.workspace);
  const home = await realpath(options.home);
  const readable = [workspace, home, dependenciesRoot, dirname(dirname(process.execPath)), ...(options.readPaths ?? []), ...(options.toolEnvironment?.readPaths ?? [])];
  const allowedVariables = new Set(['GEM_HOME', 'GEM_PATH', 'BUNDLE_PATH', 'BUNDLE_CACHE_PATH', 'BUNDLE_USER_CACHE', 'BUNDLE_USER_CONFIG', 'BUNDLE_FROZEN', 'BUNDLE_DISABLE_SHARED_GEMS', 'BUNDLE_IGNORE_CONFIG', 'BUNDLE_BUILD__PG', 'BUNDLER_AUDIT_DB', 'OPENCORP_NPM_AUDIT_CACHE', 'OPENCORP_BRAKEMAN_RELEASE_CACHE', 'OPENCORP_PRODUCT_ROOT', 'RUBYOPT', 'npm_config_cache', 'npm_config_offline', 'npm_config_audit', 'npm_config_fund', 'npm_config_registry', 'PLAYWRIGHT_BROWSERS_PATH']);
  let toolEnvironment = '';
  for (const [name, value] of Object.entries(options.toolEnvironment?.variables ?? {})) {
    if (!allowedVariables.has(name)) throw new Error(`Unapproved toolchain environment variable: ${name}`);
    toolEnvironment += `export ${name}=${shellQuote(value)}; `;
  }
  if (options.toolEnvironment?.binPaths.length) toolEnvironment += `export PATH=${shellQuote(options.toolEnvironment.binPaths.join(':'))}:"$PATH"; `;
  if (options.localTestProxy) {
    const browserShim = resolve(dependenciesRoot, '../src/runtime/browser-proxy.cjs'); readable.push(browserShim);
    toolEnvironment += `export NODE_USE_ENV_PROXY=1; export HTTP_PROXY=${shellQuote(options.localTestProxy.url)}; export HTTPS_PROXY=${shellQuote(options.localTestProxy.url)}; export http_proxy="$HTTP_PROXY"; export https_proxy="$HTTPS_PROXY"; export NO_PROXY=127.0.0.1:${options.gatewayPort}; export no_proxy="$NO_PROXY"; export NODE_OPTIONS=${shellQuote(`--require=${JSON.stringify(browserShim)}`)}; `;
  }
  let appleEnvironment = '';
  // xcrun/clang may be selected from an Owner-installed Xcode outside
  // /Applications. Admit only that concrete platform toolchain read-only.
  try {
    const { stdout } = await exec('/usr/bin/xcode-select', ['-p'], { env: { PATH: '/usr/bin:/bin' } });
    const developer = await realpath(stdout.trim());
    readable.push(developer.endsWith('.app/Contents/Developer') ? resolve(developer, '../..') : developer);
    const compilerBin = join(developer, 'Toolchains', 'XcodeDefault.xctoolchain', 'usr', 'bin');
    const sdk = join(developer, 'Platforms', 'MacOSX.platform', 'Developer', 'SDKs', 'MacOSX.sdk');
    appleEnvironment = `export DEVELOPER_DIR=${shellQuote(developer)}; export xcrun_nocache=1; export PATH=${shellQuote(`${compilerBin}:${join(developer, 'usr/bin')}`)}:"$PATH"; `;
    try { appleEnvironment += `export SDKROOT=${shellQuote(await realpath(sdk))}; `; } catch { /* CommandLineTools uses its own SDK lookup. */ }
  } catch { /* Doctor reports unavailable Apple tools when a task needs them. */ }
  // Shared Git objects are readable for diff/status. All shared metadata remains
  // write-denied; commits/branches/remote effects go through the trusted broker.
  try {
    const { stdout } = await exec('/usr/bin/git', ['-C', workspace, 'rev-parse', '--git-common-dir'], {
      env: { PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    readable.push(await realpath(resolve(workspace, stdout.trim())));
  } catch { /* Non-Git company/disposable workspace. */ }
  let wrapped = wrapCommandWithSandboxMacOS({
    // SRT's generic allowLocalBinding would open every localhost destination.
    // Exact proxy ports give this process only its own gateway and server.
    command: `unset ALL_PROXY all_proxy; export TMPDIR=${shellQuote(join(home, 'tmp'))}; export NO_PROXY=127.0.0.1,localhost; export no_proxy=127.0.0.1,localhost; ${appleEnvironment}${toolEnvironment}${options.command}`,
    commandId: options.runId,
    needsNetworkRestriction: true,
    httpProxyPort: options.gatewayPort,
    socksProxyPort: options.serverPort,
    allowLocalBinding: false,
    allowAllUnixSockets: false,
    allowAppleEvents: false,
    allowGitConfig: true,
    readConfig: {
      denyOnly: [
        '/Users', '/Volumes', '/private/tmp', '/tmp', '/private/var/folders', '/var/folders',
        '/Library/Keychains', '/private/var/db',
        '**/.env', '**/.env.local', '**/.env.production', '**/.env.development',
        '**/.npmrc', '**/.netrc', '**/id_rsa', '**/id_ed25519',
        '**/.git/hooks', '**/.opencode', '**/opencode.json', '**/opencode.jsonc',
      ],
      allowWithinDeny: readable,
    },
    writeConfig: { allowOnly: [workspace, home, ...(options.toolEnvironment?.writePaths ?? [])], denyWithinAllow: [join(workspace, '.git')] },
    binShell: '/bin/bash',
  });
  // The upstream general-purpose profile admits keychain IPC. Employees have
  // no credential authority; only the outside broker may use Keychain.
  wrapped = wrapped.replace('  (global-name "com.apple.securityd.xpc")', '');
  // Only the outside supervisor calls the OpenCode control server. A workspace
  // script cannot create untracked sessions or alter the running configuration.
  if (options.serverPort) wrapped = wrapped.replace(`(allow network-outbound (remote ip "localhost:${options.serverPort}"))`, '');
  if (options.localTestProxy) {
    // Binding a local service grants no outbound authority. All clients must use
    // the proxy, which verifies listener ownership before forwarding bytes.
    wrapped = wrapped.replace('(version 1)', `(version 1)\n(allow network-bind (local ip "localhost:*"))\n(allow network-inbound (local ip "localhost:*"))\n(allow network-outbound (remote ip "localhost:${options.localTestProxy.port}"))\n(allow mach-register (global-name-regex "^org\\\\.chromium\\\\.Chromium\\\\.MachPortRendezvousServer\\\\.[0-9]+$"))\n(allow mach-lookup (global-name-regex "^org\\\\.chromium\\\\.Chromium\\\\.MachPortRendezvousServer\\\\.[0-9]+$"))`);
  }
  return wrapped;
}

export function openCodeCommand(port: number): string {
  return `exec ${shellQuote(opencodeBinary)} serve --pure --hostname=127.0.0.1 --port=${port} --log-level=ERROR`;
}
