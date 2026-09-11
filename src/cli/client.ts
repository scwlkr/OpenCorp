import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CompanySnapshot } from '../core/types.js';

export function dataDirectory(explicit?: string): string {
  return resolve(explicit || process.env.OPENCORP_DATA_DIR || join(homedir(), '.local', 'share', 'opencorp'));
}
export interface Discovery { url: string; pid?: number; startedAt?: string }
export async function readConnection(dataRoot: string): Promise<{ discovery: Discovery; token: string }> {
  let discovery: Discovery;
  let token: string;
  try {
    [discovery, token] = await Promise.all([
      readFile(join(dataRoot, 'discovery.json'), 'utf8').then((value) => JSON.parse(value) as Discovery),
      readFile(join(dataRoot, 'owner-token'), 'utf8').then((value) => value.trim()),
    ]);
  } catch { throw new Error('OpenCorp is unavailable. Run opencorp start, or check opencorp service status.'); }
  const url = new URL(discovery.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || !token) {
    throw new Error('Invalid local service discovery. Restart OpenCorp to refresh its connection.');
  }
  return { discovery, token };
}
export class ApiError extends Error {
  constructor(message: string, public status?: number) { super(message); this.name = 'ApiError'; }
}
export class OwnerClient {
  constructor(readonly dataRoot: string) {}
  async request<T = unknown>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const { discovery, token } = await readConnection(this.dataRoot);
    let response: Response;
    try {
      response = await fetch(`${discovery.url}/api/v1/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal || AbortSignal.timeout(30_000),
      });
    } catch (error) { throw new ApiError(`Cannot reach OpenCorp. ${error instanceof Error ? error.message : 'Connection failed'}`); }
    const text = await response.text();
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new ApiError(`OpenCorp returned an invalid response (${response.status}).`, response.status); }
    if (!response.ok) {
      const failure = value as { error?: string | { message?: string }; message?: string };
      throw new ApiError(typeof failure.error === 'string' ? failure.error : failure.error?.message || failure.message || `Request failed (${response.status}).`, response.status);
    }
    return value as T;
  }
  state(signal?: AbortSignal): Promise<CompanySnapshot> { return this.request('state', undefined, signal); }
  control(action: 'start' | 'pause' | 'resume' | 'stop'): Promise<CompanySnapshot> { return this.request('control', { action }); }
  chat(content: string, target: { projectId?: string; employeeId?: string } = {}): Promise<unknown> { return this.request('chat', { content, ...target }); }
  async events(onEvent: () => void, signal: AbortSignal, lastEventId = ''): Promise<void> {
    const { discovery, token } = await readConnection(this.dataRoot);
    const response = await fetch(`${discovery.url}/api/v1/events`, { headers: { Authorization: `Bearer ${token}`, ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}) }, signal });
    if (!response.ok || !response.body) throw new ApiError(`Event connection failed (${response.status}).`, response.status);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    try {
      while (!signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        pending = pending.replace(/\r\n/g, '\n');
        let boundary: number;
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          const event = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          if (event.split('\n').some((line) => line.startsWith('data:'))) onEvent();
        }
      }
    } finally { reader.releaseLock(); }
  }
}
