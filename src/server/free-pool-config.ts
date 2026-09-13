import { createHash } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { DirectFree } from '../runtime/direct-free.js';
import { OpenRouterFree } from '../runtime/openrouter.js';
import type { RuntimeOptions } from '../runtime/types.js';
import { FreeInferencePool } from '../runtime/free-pool/pool.js';
import { PoolState } from '../runtime/free-pool/state.js';
import { PoolAttemptError, type PoolProvider } from '../runtime/free-pool/types.js';
import { providerRegistry, type RegisteredProvider } from '../runtime/free-pool/registry.js';
import { portableBody, readCompletion, readNativeCompletion } from '../runtime/free-pool/transport.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function privateRead(directory: string, name: string, max = 64_000) {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || process.getuid && stat.uid !== process.getuid()) throw new Error('Private pool credential directory required');
  const fd = openSync(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const file = fstatSync(fd); if (!file.isFile() || (file.mode & 0o777) !== 0o600 || file.size > max || process.getuid && file.uid !== process.getuid()) throw new Error(); return readFileSync(fd, 'utf8'); }
  catch { throw new Error('Private pool credential unavailable'); } finally { closeSync(fd); }
}
const modelSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9@][a-zA-Z0-9._/:@-]{0,199}$/), context: z.number().int().min(1024).max(2_000_000), quality: z.union([z.literal(1),z.literal(2),z.literal(3)]), tools: z.boolean(), json: z.boolean().optional(), autoToolsOnly: z.boolean().optional() }).strict();
const configSchema = z.object({ providers: z.array(z.object({
  id: z.enum(Object.keys(providerRegistry) as [RegisteredProvider, ...RegisteredProvider[]]),
  enabled: z.boolean(), account: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), models: z.array(modelSchema).min(1).max(32),
  credentialSha256: z.string().regex(/^[a-f0-9]{64}$/), billingBlocked: z.literal(true),
  /** Account setting evidence, not a pretend live billing API. Must be renewed deliberately. */
  verifiedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), evidence: z.string().min(1).max(2000),
  renewable: z.boolean(), publicOnly: z.boolean().default(true), evaluationOnly: z.boolean().default(true),
  concurrency: z.number().int().min(1).max(4).default(1),
  limits: z.array(z.object({ requests: z.number().int().positive().optional(), tokens: z.number().int().positive().optional(), periodMs: z.number().int().min(0).max(32 * 86400000) }).strict().refine(l => l.requests !== undefined || l.tokens !== undefined)).min(1).max(5),
}).strict()).max(32) }).strict();

/** Existing audited adapters remain authoritative. Additional accounts are opt-in private JSON. */
export function createFreePool(dataRoot: string, options: Pick<RuntimeOptions, 'directFree' | 'openRouterFree'>) {
  const providers: PoolProvider[] = [];
  const directory = join(dataRoot, 'credentials');
  for (const id of ['groq', 'gemini', 'zai'] as const) {
    const config = options.directFree?.[id]; if (!config?.modelIds.length) continue;
    const scope = `${id}:existing-account`;
    const auditPath = join(directory, `${id}-free.json`);
    const revision = existsSync(auditPath) ? hash(privateRead(directory, `${id}-free.json`)) : hash(JSON.stringify(config.modelIds));
    providers.push({ id, scope, revision, renewable: true, ...(id==='gemini'?{dailyReset:'pacific' as const}:{}), concurrency: id === 'zai' ? 1 : 2,
      models: config.modelIds.map(model => ({ id: model, context: 32768, quality: 2, tools: true, autoToolsOnly: id === 'zai' })),
      limits: [{ scope: `${scope}:minute`, periodMs: 60_000, requests: id === 'groq' ? 25 : 8, tokens: id === 'groq' ? 8000 : 180000 }],
      available: async () => { try { await config.readCredentials(); return true; } catch { return false; } },
      complete: async (model, input, signal) => {
        const transport = new DirectFree(id, config, [model.id]);
        const current = (await transport.models(signal)).find(m => m.id === model.id); if (!current) throw new PoolAttemptError(404);
        const body = portableBody(input, model.id);
        // Gemini opaque signatures belong only to Gemini. Other transports get portable history.
        if (id === 'gemini') body.messages = input.messages;
        return readNativeCompletion(await transport.infer(current, body, signal, input.onDispatch));
      },
    });
  }
  if (options.openRouterFree?.modelIds.length) {
    const config = options.openRouterFree, transport = new OpenRouterFree(config), scope = 'openrouter:existing-account';
    providers.push({ id: 'openrouter', scope, revision: hash(JSON.stringify(config.modelIds)), renewable: true, dailyReset:'utc', concurrency: 2,
      models: config.modelIds.map(id => ({ id, context: 32768, quality: 3, tools: true })),
      limits: [{ scope: `${scope}:minute`, periodMs: 60_000, requests: 18 }],
      available: async () => { try { await config.readApiKey(); return true; } catch { return false; } },
      complete: async (model, input, signal) => readNativeCompletion(await transport.infer(model.id, portableBody(input, model.id), signal, input.onDispatch)),
    });
  }
  if (existsSync(join(directory, 'inference-pool.json'))) {
    const config = configSchema.parse(JSON.parse(privateRead(directory, 'inference-pool.json')));
    for (const account of config.providers.filter(p => p.enabled)) {
      if (providers.some(p => p.id === account.id)) throw new Error('Configure each provider account only once; key rotation does not multiply quotas');
      // These providers use their existing stronger per-request zero-price/account verification.
      if (['gemini','groq','zai','openrouter'].includes(account.id)) throw new Error('Use the existing audited configuration for Gemini, Groq, Z.ai and OpenRouter');
      if (['nvidia','cohere'].includes(account.id) && !account.evaluationOnly) throw new Error('Provider trial keys are restricted to evaluation');
      if (Date.parse(account.expiresAt) <= Date.parse(account.verifiedAt) || Date.parse(account.expiresAt) - Date.parse(account.verifiedAt) > 30 * 86400000) throw new Error('Account eligibility requires bounded dated review');
      if (account.id === 'cloudflare' && !/^[a-f0-9]{32}$/.test(account.account)) throw new Error('Invalid Cloudflare account');
      const scope = `${account.id}:${account.account}`, revision = hash(JSON.stringify(account));
      const readKey = () => { const key = privateRead(directory, account.id === 'nvidia' ? 'nvidia-nim-free.key' : `${account.id}-pool.key`, 4096).trim(); if (!key || /\s/.test(key) || hash(key) !== account.credentialSha256) throw new Error('Pool credential binding changed'); return key; };
      providers.push({ id: account.id, scope, revision, models: account.models, concurrency: account.concurrency,
        renewable: account.renewable, publicOnly: account.publicOnly, evaluationOnly: account.evaluationOnly,
        limits: account.limits.map((l, index) => ({ ...l, scope: `${scope}:limit-${index}` })),
        available: async () => { try { readKey(); return Date.parse(account.verifiedAt) <= Date.now() && Date.parse(account.expiresAt) > Date.now(); } catch { return false; } },
        complete: async (model, input, signal) => {
          const endpoint = providerRegistry[account.id].endpoint.replace('{account}', account.account);
          const body = portableBody(input, model.id);
          input.onDispatch?.(body);
          const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal, headers: { authorization: `Bearer ${readKey()}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
          return { completion: await readCompletion(response), headers: response.headers };
        },
      });
    }
  }
  return new FreeInferencePool(new PoolState(join(dataRoot, 'runtime', 'free-pool', 'state.sqlite')), providers);
}
