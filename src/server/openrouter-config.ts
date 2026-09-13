import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeOptions } from '../runtime/types.js';
import { validOpenRouterFreeId } from '../core/inference-policy.js';

/** Parent-only metadata. Neither this object nor its key belongs in company
 * state, worker environments, prompts, diagnostics, or portable backups. */
export function openRouterFreeConfig(dataRoot: string, modelIds: string[]): RuntimeOptions['openRouterFree'] {
  const directory = join(dataRoot, 'credentials');
  const configPath = join(directory, 'openrouter-free.json');
  const keyPath = join(directory, 'openrouter-free.key');
  try { lstatSync(configPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('OpenRouter credential configuration unavailable'); }
  const secureDirectory = () => {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o7777) !== 0o700
      || process.getuid && stat.uid !== process.getuid()) throw new Error('OpenRouter credential directory must be private and owned');
  };
  const readPrivate = (path: string, maximumBytes: number): string => {
    secureDirectory();
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o7777) !== 0o600 || stat.size > maximumBytes
        || process.getuid && stat.uid !== process.getuid()) throw new Error('OpenRouter credential file must be private and owned');
      return readFileSync(fd, 'utf8');
    } finally { closeSync(fd); }
  };
  let audit: unknown;
  try { audit = JSON.parse(readPrivate(configPath, 4096)); }
  catch { throw new Error('OpenRouter credential audit must be a private regular JSON file'); }
  const record = audit as Record<string, unknown> | null;
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.noByokVerified !== true
    || typeof record.verifiedAt !== 'string' || !Number.isFinite(Date.parse(record.verifiedAt))
    || typeof record.evidence !== 'string' || !record.evidence.trim() || record.evidence.length > 2000
    || Object.keys(record).some(key => !['noByokVerified', 'verifiedAt', 'evidence'].includes(key))) {
    throw new Error('OpenRouter requires an explicit dated no-BYOK audit with evidence');
  }
  if (!modelIds.every(validOpenRouterFreeId)) throw new Error('OpenRouter configuration requires exact Owner-allowlisted free IDs');
  return { rateBudgetPath:join(dataRoot,'runtime','provider-rate-budgets','openrouter.json'), modelIds: [...modelIds], noByokVerified: true, readApiKey: async () => {
    try {
      const key = readPrivate(keyPath, 4096).trim();
      if (!key || /[\r\n]/.test(key)) throw new Error();
      return key;
    } catch { throw new Error('OpenRouter private credential unavailable'); }
  } };
}
