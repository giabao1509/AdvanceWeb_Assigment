import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const defaultDatabase = resolve('data/lab.sqlite');
export function transaction(db, work) {
  if (work.constructor?.name === 'AsyncFunction') throw new TypeError('SQLite transaction callback must be synchronous');
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    if (result && typeof result.then === 'function') throw new TypeError('SQLite transaction callback must be synchronous');
    db.exec('COMMIT'); return result;
  }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function resetDatabase(db, afterReset = () => {}) {
  return transaction(db, () => {
    db.exec('DELETE FROM tasks; DELETE FROM project_memberships; DELETE FROM projects; DELETE FROM users; DELETE FROM tenants;');
    const tenant = db.prepare('INSERT INTO tenants VALUES (?,?)');
    tenant.run('alpha', 'Tenant Alpha'); tenant.run('beta', 'Tenant Beta');
    const user = db.prepare('INSERT INTO users VALUES (?,?,?,?)');
    for (const row of [
      ['alice','Alice','alpha',0], ['bob','Bob','alpha',0], ['vera','Vera','alpha',0],
      ['charlie','Charlie','beta',0], ['admin-alpha','Admin Alpha','alpha',1], ['admin-beta','Admin Beta','beta',1],
    ]) user.run(...row);
    db.prepare('INSERT INTO projects VALUES (?,?,?)').run('alpha','Project Alpha','alpha');
    db.prepare('INSERT INTO projects VALUES (?,?,?)').run('beta','Project Beta','beta');
    const membership = db.prepare('INSERT INTO project_memberships VALUES (?,?,?)');
    for (const row of [['alpha','alice','Owner'],['alpha','bob','Member'],['alpha','vera','Viewer'],['beta','charlie','Owner']]) membership.run(...row);
    const task = db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?)');
    for (const row of [
      ['A1','alpha','bob','Alpha · Build API','Task assigned to Bob','Open'],
      ['A2','alpha','bob','Alpha · Completed review','Closed task assigned to Bob','Closed'],
      ['A3','alpha',null,'Alpha · Unassigned task','No assignee yet','Open'],
      ['A4','alpha','alice','Alpha · Owner task','Assigned to Alice','Open'],
      ['B1','beta','charlie','Beta · Private roadmap','Private Beta task content','Open'],
      ['B2','beta',null,'Beta · Unassigned task','Beta task without assignee','Open'],
    ]) task.run(...row);
    return afterReset();
  });
}
export function openDatabase(path = defaultDatabase) {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  installRevisionTriggers(db);
  if (!db.prepare('SELECT count(*) AS count FROM tenants').get().count) resetDatabase(db);
  return db;
}

export function authorizationState(db) {
  return db.prepare('SELECT * FROM authorization_state WHERE id = 1').get();
}

function installRevisionTriggers(db) {
  // All SQL writes, including fixtures, cascade deletes and CLI reset, participate.
  const relationColumns = {
    tenants: ['id'], users: ['id','tenantId','isAdmin'],
    projects: ['id','tenantId'], project_memberships: ['projectId','userId','role'],
    tasks: ['id','projectId','assigneeId'],
  };
  for (const [table, columns] of Object.entries(relationColumns)) {
    for (const event of ['INSERT','DELETE','UPDATE']) {
      const changed = event === 'UPDATE' ? columns.map(c => `OLD.${c} IS NOT NEW.${c}`).join(' OR ') : '1';
      db.exec(`CREATE TRIGGER IF NOT EXISTS authz_${table}_${event.toLowerCase()}
        AFTER ${event} ON ${table} BEGIN
          UPDATE authorization_state SET revision = revision + 1 WHERE id = 1;
          UPDATE authorization_state SET desiredRevision = desiredRevision + 1 WHERE id = 1 AND (${changed});
          INSERT OR IGNORE INTO authorization_outbox(revision)
            SELECT desiredRevision FROM authorization_state WHERE id = 1 AND (${changed});
        END;`);
    }
  }
}
