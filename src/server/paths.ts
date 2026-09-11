import { homedir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, chmodSync, writeFileSync, renameSync, readFileSync } from 'node:fs';
export const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const sourceRoot = appRoot.endsWith('/dist') ? dirname(appRoot) : appRoot;
export const defaultDataRoot = () => resolve(process.env.OPENCORP_DATA_DIR || join(homedir(), '.local/share/opencorp'));
export function ensureDataRoot(dataRoot: string) { mkdirSync(dataRoot, {recursive: true, mode: 0o700}); chmodSync(dataRoot, 0o700); for (const dir of ['logs','runtime','workspaces','repositories','backups']) mkdirSync(join(dataRoot, dir), {recursive: true, mode: 0o700}); }
export function writePrivate(path: string, content: string) { const temporary = `${path}.${process.pid}.tmp`; writeFileSync(temporary, content, {mode: 0o600}); renameSync(temporary, path); chmodSync(path, 0o600); }
export function readDiscovery(dataRoot: string): {url: string; pid: number; startedAt: string} | null { try { return JSON.parse(readFileSync(join(dataRoot,'discovery.json'),'utf8')); } catch { return null; } }
export function preferredOwnerPort(dataRoot: string, configured = process.env.OPENCORP_PORT): number {
 if (configured !== undefined) { const port=Number(configured); if(!Number.isInteger(port)||port<0||port>65535)throw new Error('OPENCORP_PORT must be an integer between 0 and 65535.'); return port; }
 try { const prior=new URL(readDiscovery(dataRoot)?.url??''); if(prior.protocol==='http:'&&prior.hostname==='127.0.0.1'&&prior.port)return Number(prior.port); } catch { /* First launch has no discovery record. */ }
 return 4310;
}
