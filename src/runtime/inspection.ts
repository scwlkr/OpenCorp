import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from '../tools/process.js';

const MB = 1024 * 1024;
const DAY = 86400000;
export const inspectionLimits = { runBytes: 16 * MB, totalBytes: 128 * MB, recentDays: 7, selectedDays: 30 };
export function inspectionPath(root: string, id: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid run identifier');
  return join(root, 'runtime', 'inspection', `${id}.jsonl`);
}
/** Never capture transport headers, environment or hidden reasoning. Known run
 * credentials are removed in addition to common credential fields and syntax. */
export function inspectionRedact(value: unknown, secrets: string[] = []): unknown {
  const clean = (text: string) => {
    for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[REDACTED]');
    return redact(text).replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]')
      .replace(/((?:api[_-]?key|password|access[_-]?token|refresh[_-]?token|secret)["']?\s*[=:]\s*["']?)[^\s"',;}]+/gi, '$1[REDACTED]')
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+/gi, '[REDACTED authorization]')
      .replace(/data:[^;\s]+;base64,[A-Za-z0-9+/=]+/g, '[REDACTED attachment]');
  };
  if (typeof value === 'string') return clean(value);
  if (Array.isArray(value)) return value.map(item => inspectionRedact(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /^(authorization|cookie|api[_-]?key|api[_-]?secret|password|(?:access[_-]?|refresh[_-]?)?token|secret|signature|thought_signature|reasoning_content|reasoning)$/i.test(key) ? '[REDACTED]' : inspectionRedact(item, secrets)]));
  return value;
}

/** Prunes diagnostic copies only; execution/effect records are never deleted. */
export function pruneInspections(root: string, now = Date.now()) {
  const directory = join(root, 'runtime', 'inspection');
  if (!existsSync(directory)) return;
  const files = readdirSync(directory).filter(name => name.endsWith('.jsonl')).map(name => {
    const path = join(directory, name), stat = statSync(path);
    const selected = existsSync(`${path}.selected`);
    return { path, size: stat.size, time: stat.mtimeMs, selected };
  }).sort((a, b) => Number(b.selected) - Number(a.selected) || b.time - a.time);
  let bytes = 0;
  for (const file of files) {
    if (now - file.time > (file.selected ? inspectionLimits.selectedDays : inspectionLimits.recentDays) * DAY || bytes + file.size > inspectionLimits.totalBytes) {
      unlinkSync(file.path);
      if (file.selected) unlinkSync(`${file.path}.selected`);
    } else bytes += file.size;
  }
}

export class RunInspection {
  private bytes = 0;
  private stopped = false;
  private readonly path: string;
  constructor(private readonly root: string, id: string, private readonly secrets: string[] = []) {
    const directory = join(root, 'runtime', 'inspection');
    mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
    pruneInspections(root);
    this.path = inspectionPath(root, id);
    this.bytes = existsSync(this.path) ? statSync(this.path).size : 0;
  }
  record(type: string, payload: unknown) {
    if (this.stopped) return;
    // An evicted prefix must never be replaced by a seemingly complete suffix.
    if (this.bytes > 0 && !existsSync(this.path)) { this.stopped = true; return; }
    let line = JSON.stringify({ at: new Date().toISOString(), type, payload: inspectionRedact(payload, this.secrets) }) + '\n';
    if (this.bytes + Buffer.byteLength(line) > inspectionLimits.runBytes - 1024) {
      line = JSON.stringify({ at: new Date().toISOString(), type: 'capture.truncated', payload: 'Detailed capture stopped at the per-run byte limit; subsequent context and events are unavailable.' }) + '\n';
      this.stopped = true;
    }
    appendFileSync(this.path, line, { mode: 0o600 }); chmodSync(this.path, 0o600);
    this.bytes += Buffer.byteLength(line);
    pruneInspections(this.root);
  }
}
export function readInspection(root: string, id: string) {
  pruneInspections(root);
  const path = inspectionPath(root, id);
  if (!existsSync(path)) return { available: false, selected: false, records: [], limitation: 'Capture unavailable: predates inspection, expired, evicted by the storage budget, or no runtime was admitted.' };
  if (statSync(path).size > inspectionLimits.runBytes) throw new Error('Inspection exceeds read limit');
  const records = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { available: true, selected: existsSync(`${path}.selected`), records, limitation: 'Recorded local observations only. Credentials and attachments are redacted; provider internals and hidden reasoning are unavailable. Gateway and provider transport bodies are labeled separately; provider-side transformations are unavailable.' };
}
