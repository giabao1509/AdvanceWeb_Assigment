import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { config } from './config.js';
import { importLegacy } from './migration.js';
import type { Operation, StoredResult, ResultBody } from './types.js';

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function openDatabase(service: string, schema: string, seed: (db: DatabaseSync) => void = () => {}): DatabaseSync {
  mkdirSync(config.dataDir,{recursive:true});
  const target=join(config.dataDir,`${service}.sqlite`);
  const fresh=!existsSync(target);
  const staged=fresh?join(config.dataDir,`.migrate-${service}-${randomUUID()}.sqlite`):target;
  const db=new DatabaseSync(staged,{timeout:2000});
  try{
    db.exec('PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
    db.exec(schema);
    let sources:Record<string,unknown>[]=[];
    transaction(db, () => {
      if(fresh)sources=importLegacy(db,config.dataDir,service);
      if (service !== 'order') {
        const columns = db.prepare('PRAGMA table_info(operations)').all() as { name: string }[];
        if (!columns.some(c => c.name === 'status')) db.exec("ALTER TABLE operations ADD COLUMN status TEXT NOT NULL DEFAULT 'SUCCEEDED'");
        db.exec("UPDATE operations SET status=CASE WHEN http_status BETWEEN 200 AND 299 THEN 'SUCCEEDED' ELSE 'FAILED' END");
      }
      seed(db);
      if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error(`Foreign key check failed for ${service}; original files are unchanged.`);
    });
    if(!fresh){db.exec('PRAGMA journal_mode=WAL;');return db;}
    db.close();renameSync(staged,target);
    if(sources.length)writeFileSync(join(config.dataDir,`migration-${service}.json`),JSON.stringify({time:new Date().toISOString(),target,sources},null,2));
    const live=new DatabaseSync(target,{timeout:2000});live.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');return live;
  }catch(error){
    try{db.close();}catch{}
    if(fresh)rmSync(staged,{force:true});
    throw error;
  }
}

export const participantSchema = `
  CREATE TABLE IF NOT EXISTS operations (
    id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, action TEXT NOT NULL,
    order_id TEXT NOT NULL, http_status INTEGER NOT NULL, result TEXT NOT NULL,
    created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'SUCCEEDED'
  );
  CREATE TABLE IF NOT EXISTS faults (key TEXT PRIMARY KEY, count INTEGER NOT NULL);
`;

export function replay(db: DatabaseSync, id: string, fingerprint: string): StoredResult | null {
  const op = db.prepare('SELECT * FROM operations WHERE id=?').get(id) as Operation | undefined;
  if (!op) return null;
  if (op.fingerprint !== fingerprint) return { status: 409, body: { error: 'IDEMPOTENCY_CONFLICT' } };
  return { status: op.http_status, body: JSON.parse(op.result) };
}

export function remember(db: DatabaseSync, id: string, fingerprint: string, action: string, orderId: string, status: number, body: ResultBody): StoredResult {
  db.prepare('INSERT INTO operations (id,fingerprint,action,order_id,http_status,result,created_at,status) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, fingerprint, action, orderId, status, JSON.stringify(body), new Date().toISOString(), status >= 200 && status < 300 ? 'SUCCEEDED' : 'FAILED');
  return { status, body };
}

export function consumeFault(db: DatabaseSync, key: string, limit = 1): boolean {
  const count = (db.prepare('SELECT count FROM faults WHERE key=?').get(key) as { count: number } | undefined)?.count || 0;
  if (count >= limit) return false;
  db.prepare('INSERT INTO faults VALUES (?,1) ON CONFLICT(key) DO UPDATE SET count=count+1').run(key);
  return true;
}
