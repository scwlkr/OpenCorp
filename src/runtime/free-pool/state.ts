import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import type { PoolProvider } from './types.js';

/** Small durable admission ledger. No prompts, completions, keys, or raw errors. */
export class PoolState {
  private readonly db: Database.Database;
  constructor(path: string) {
    if (path !== ':memory:') {
      if (!isAbsolute(path)) throw new Error('Pool state requires an absolute protected path');
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const directory = lstatSync(dirname(path));
      if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o777) !== 0o700 || process.getuid && directory.uid !== process.getuid()) throw new Error('Pool directory must be private');
      if (existsSync(path)) { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || process.getuid && stat.uid !== process.getuid()) throw new Error('Pool database must be private'); }
    }
    this.db = new Database(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.pragma('busy_timeout = 1000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS holds (scope TEXT PRIMARY KEY, revision TEXT NOT NULL, until_ms INTEGER NOT NULL, failures INTEGER NOT NULL, reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, scope TEXT NOT NULL, at_ms INTEGER NOT NULL, tokens INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS reservations_scope ON reservations(scope, at_ms);
      CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, scope TEXT NOT NULL, until_ms INTEGER NOT NULL);`);
  }
  close() { this.db.close(); }
  hold(scope: string, revision: string, until: number, reason: string) {
    this.db.prepare(`INSERT INTO holds VALUES(?,?,?,1,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,
      until_ms=CASE WHEN holds.revision=excluded.revision THEN MAX(holds.until_ms,excluded.until_ms) ELSE excluded.until_ms END,
      failures=CASE WHEN holds.revision=excluded.revision THEN holds.failures+1 ELSE 1 END,reason=excluded.reason`).run(scope, revision, until, reason);
  }
  health(scope: string, revision: string): { until_ms: number; failures: number; reason: string } {
    return this.db.prepare('SELECT until_ms,failures,reason FROM holds WHERE scope=? AND revision=?').get(scope, revision) as any ?? { until_ms: 0, failures: 0, reason: 'unknown' };
  }
  success(scope: string, revision: string, now: number) {
    // A concurrent success must not clear another request's newer rate-limit hold.
    this.db.prepare('DELETE FROM holds WHERE scope=? AND revision=? AND until_ms<=?').run(scope, revision, now);
  }
  private budget(provider: PoolProvider, tokens: number, now: number) {
    let retryAt = 0, remainingFraction = 1;
    for (const limit of provider.limits) {
      const entries = this.db.prepare('SELECT at_ms,tokens FROM reservations WHERE scope=? AND at_ms>? ORDER BY at_ms').all(limit.scope, limit.periodMs ? now - limit.periodMs : -1) as Array<{ at_ms: number; tokens: number }>;
      let count = entries.length, total = entries.reduce((sum, e) => sum + e.tokens, 0);
      remainingFraction = Math.min(remainingFraction, limit.requests ? Math.max(0, 1 - count / limit.requests) : 1, limit.tokens ? Math.max(0, 1 - total / limit.tokens) : 1);
      if ((limit.requests === undefined || count < limit.requests) && (limit.tokens === undefined || total + tokens <= limit.tokens)) continue;
      let until = Number.MAX_SAFE_INTEGER;
      if (limit.periodMs) for (const entry of entries) {
        count--; total -= entry.tokens;
        if ((limit.requests === undefined || count < limit.requests) && (limit.tokens === undefined || total + tokens <= limit.tokens)) { until = entry.at_ms + limit.periodMs; break; }
      }
      retryAt = Math.max(retryAt, until);
    }
    return { retryAt, remainingFraction };
  }
  availability(provider: PoolProvider, model: string, tokens: number, now: number) {
    const health = this.health(provider.scope, provider.revision), modelHealth = this.health(`${provider.scope}/${model}`, provider.revision);
    const budget = this.budget(provider, tokens, now);
    const leases = this.db.prepare('SELECT until_ms FROM leases WHERE scope=? AND until_ms>? ORDER BY until_ms').all(provider.scope, now) as Array<{ until_ms: number }>;
    return { retryAt: Math.max(health.until_ms, modelHealth.until_ms, budget.retryAt, leases.length >= provider.concurrency ? leases[0]!.until_ms : 0), remainingFraction: budget.remainingFraction };
  }
  reserve(provider: PoolProvider, model: string, tokens: number, now: number, deadline: number): string | undefined {
    return this.db.transaction(() => {
      if (this.availability(provider, model, tokens, now).retryAt > now) return;
      const id = randomUUID();
      this.db.prepare('DELETE FROM leases WHERE until_ms<=?').run(now);
      this.db.prepare('INSERT INTO leases VALUES(?,?,?)').run(id, provider.scope, deadline);
      for (const limit of provider.limits) {
        if (limit.periodMs) this.db.prepare('DELETE FROM reservations WHERE scope=? AND at_ms<=?').run(limit.scope, now - limit.periodMs);
        this.db.prepare('INSERT INTO reservations VALUES(?,?,?,?)').run(`${id}/${limit.scope}`, limit.scope, now, tokens);
      }
      return id;
    }).immediate();
  }
  release(id: string) { this.db.prepare('DELETE FROM leases WHERE id=?').run(id); }
}
