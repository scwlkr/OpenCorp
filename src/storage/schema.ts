import type Database from 'better-sqlite3';
import type { TableName } from '../core/types.js';

export const TABLES: TableName[] = ['company', 'policy', 'products', 'departments', 'positions', 'employees', 'appointments', 'projects', 'assignments', 'runs', 'decisions', 'votes', 'artifacts', 'reviews', 'messages', 'actions', 'knowledge', 'models', 'integrations', 'attention', 'experiences', 'roleVersions'];

export function migrate(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec('CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const version = (db.prepare('SELECT max(version) AS version FROM migrations').get() as {version: number | null}).version ?? 0;
  if (version < 1) db.transaction(() => {
    for (const table of TABLES) db.exec(`CREATE TABLE ${table} (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL CHECK(json_valid(data)),
      status TEXT GENERATED ALWAYS AS (coalesce(json_extract(data,'$.status'),json_extract(data,'$.state'))) VIRTUAL,
      employee_id TEXT GENERATED ALWAYS AS (json_extract(data,'$.employeeId')) VIRTUAL,
      project_id TEXT GENERATED ALWAYS AS (json_extract(data,'$.projectId')) VIRTUAL,
      assignment_id TEXT GENERATED ALWAYS AS (json_extract(data,'$.assignmentId')) VIRTUAL,
      created_at TEXT GENERATED ALWAYS AS (json_extract(data,'$.createdAt')) VIRTUAL,
      CHECK(json_extract(data,'$.id') = id)
    ); CREATE INDEX ${table}_status ON ${table}(status); CREATE INDEX ${table}_employee ON ${table}(employee_id);`);
    db.exec(`CREATE UNIQUE INDEX action_dedupe ON actions(json_extract(data,'$.dedupeKey'));
      CREATE UNIQUE INDEX elder_vote ON votes(json_extract(data,'$.decisionId'),employee_id);
      CREATE UNIQUE INDEX knowledge_path ON knowledge(json_extract(data,'$.path'));
      CREATE UNIQUE INDEX run_session ON runs(json_extract(data,'$.sessionId')) WHERE json_extract(data,'$.sessionId') IS NOT NULL;
      CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), created_at TEXT NOT NULL);
      CREATE VIRTUAL TABLE knowledge_fts USING fts5(id UNINDEXED, title, content, scope, tokenize='unicode61');`);
    db.prepare('INSERT INTO migrations VALUES(1,?)').run(new Date().toISOString());
  })();
  if(version<2)db.transaction(()=>{
    db.exec("CREATE INDEX assignments_scheduler_key ON assignments(json_extract(data,'$.schedulerKey'),created_at)");
    db.prepare('INSERT INTO migrations VALUES(2,?)').run(new Date().toISOString());
  })();
}
