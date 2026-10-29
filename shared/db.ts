import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import type { Config } from './config.js';
export function database(c: Config, name: string, readonly = false) {
  const db = new Database(resolve(c.dir, `${name}.sqlite`), { readonly, fileMustExist: readonly });
  db.pragma('busy_timeout = 5000'); db.pragma('foreign_keys = ON');
  if (!readonly) { db.pragma('journal_mode = DELETE'); db.pragma('synchronous = FULL'); }
  return db;
}
export const commonSchema = `
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, service TEXT NOT NULL, action TEXT NOT NULL, status INTEGER NOT NULL, detail TEXT NOT NULL, trace_id TEXT);
`;
export function audit(db: Database.Database, service: string, action: string, status: number, detail: unknown, traceId = '') {
  db.prepare('INSERT INTO events(at,service,action,status,detail,trace_id) VALUES(?,?,?,?,?,?)')
    .run(new Date().toISOString(), service, action, status, JSON.stringify(detail), traceId);
  db.prepare('DELETE FROM events WHERE id < (SELECT COALESCE(MAX(id),0)-1000 FROM events)').run();
}
export function events(db: Database.Database) {
  return (db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 80').all() as any[]).map(e => ({ ...e, detail: JSON.parse(e.detail) }));
}
