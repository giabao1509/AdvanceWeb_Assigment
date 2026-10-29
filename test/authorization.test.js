import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { openDatabase, resetDatabase } from '../src/db.js';

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'task-lab-'));
  const db = openDatabase(join(dir, 'test.sqlite'));
  const app = createApp({ db });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve)); db.close(); rmSync(dir, { recursive:true, force:true });
  });
  async function request(version, user, method, path, body, extras = {}) {
    const headers = { ...(user ? { Authorization:`Bearer demo-${user}` } : {}), ...extras };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/${version}/${path}`, { method, headers, ...(body !== undefined ? { body:JSON.stringify(body) } : {}) });
    return { status:response.status, body:await response.json() };
  }
  return { db, request, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

test('Starter reproduces IDOR; V1–V4 reject cross-project access without leaking content', async t => {
  const { request } = await fixture(t);
  const starter = await request('starter','alice','GET','tasks/B1');
  assert.equal(starter.status,200); assert.match(starter.body.data.description,/Private Beta/);
  assert.ok(starter.body.trace.some(c => c.result === 'SKIPPED'));
  for (const version of ['v1','v2','v3','v4']) {
    const denied = await request(version,'alice','GET','tasks/B1');
    assert.equal(denied.status,403); assert.equal(denied.body.data,null);
    assert.doesNotMatch(JSON.stringify(denied.body),/Private Beta|roadmap|charlie/);
    assert.equal((await request(version,'alice','GET','tasks/A1')).status,200);
    assert.equal((await request(version,'charlie','GET','tasks/B1')).status,200);
  }
});
test('Every version requires a valid bearer token', async t => {
  const { request } = await fixture(t);
  for (const version of ['starter','v1','v2','v3','v4']) {
    assert.equal((await request(version,null,'GET','tasks/A1')).status,401);
    assert.equal((await request(version,'invalid','GET','tasks/A1')).status,401);
  }
});
for (const version of ['starter','v1']) test(`${version}: mutation and member routes unavailable`, async t => {
  const { request } = await fixture(t);
  for (const [method,path] of [['PATCH','tasks/A1'],['DELETE','projects/alpha'],['GET','projects/alpha/members']]) {
    assert.equal((await request(version,'alice',method,path,method === 'PATCH' ? {title:'changed'} : undefined)).status,404);
  }
});
for (const version of ['v2','v3','v4']) {
  test(`${version}: project RBAC read/edit matrix`, async t => {
    const { request, db } = await fixture(t);
    for (const [user,read,edit] of [['alice',200,200],['bob',200,200],['vera',200,403],['charlie',403,403]]) {
      assert.equal((await request(version,user,'GET','tasks/A1')).status,read);
      const before = db.prepare('SELECT * FROM tasks WHERE id = ?').get('A1');
      const result = await request(version,user,'PATCH','tasks/A1',{title:`Updated by ${user}`});
      assert.equal(result.status,edit);
      const after = db.prepare('SELECT * FROM tasks WHERE id = ?').get('A1');
      if (edit === 200) assert.equal(after.title,`Updated by ${user}`); else assert.deepEqual(after,before);
    }
  });
  for (const user of ['alice','bob','vera','charlie']) test(`${version}: ${user} delete-project permission and cascade`, async t => {
    const { request, db } = await fixture(t);
    assert.equal((await request(version,user,'DELETE','projects/alpha')).status,user === 'alice' ? 200 : 403);
    const count = table => db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${table === 'projects' ? 'id' : 'projectId'} = ?`).get('alpha').n;
    for (const table of ['projects','tasks','project_memberships']) assert.equal(count(table) > 0,user !== 'alice');
  });
  for (const user of ['alice','bob','vera','charlie']) test(`${version}: ${user} permission for every membership endpoint`, async t => {
    const { request, db } = await fixture(t);
    const allowed = user === 'alice';
    const before = db.prepare('SELECT * FROM project_memberships ORDER BY projectId,userId').all();
    assert.equal((await request(version,user,'GET','projects/alpha/members')).status,allowed ? 200 : 403);
    assert.equal((await request(version,user,'POST','projects/alpha/members',{userId:'admin-alpha',role:'Viewer'})).status,allowed ? 201 : 403);
    assert.equal((await request(version,user,'PATCH','projects/alpha/members/vera',{role:'Member'})).status,allowed ? 200 : 403);
    assert.equal((await request(version,user,'DELETE','projects/alpha/members/bob')).status,allowed ? 200 : 403);
    if (allowed) {
      assert.equal(db.prepare('SELECT role FROM project_memberships WHERE userId = ?').get('vera').role,'Member');
      assert.equal(db.prepare('SELECT * FROM project_memberships WHERE userId = ?').get('bob'),undefined);
    } else assert.deepEqual(db.prepare('SELECT * FROM project_memberships ORDER BY projectId,userId').all(),before);
  });
}
test('V2 Member can edit unassigned/closed/other-assignee tasks inside project', async t => {
  const { request } = await fixture(t);
  for (const id of ['A2','A3','A4']) assert.equal((await request('v2','bob','PATCH',`tasks/${id}`,{title:'RBAC allows'})).status,200);
});
for (const version of ['v3','v4']) test(`${version}: membership, assignee and current status all enforced`, async t => {
  const { request, db } = await fixture(t);
  for (const [id,reason] of [['A2','TASK_CLOSED'],['A3','NOT_ASSIGNEE'],['A4','NOT_ASSIGNEE'],['B1',version === 'v4' ? 'TENANT_MISMATCH' : 'NOT_PROJECT_MEMBER']]) {
    const before = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    const result = await request(version,'bob','PATCH',`tasks/${id}`,{status:'Open',title:'Attempt'});
    assert.equal(result.status,403); assert.equal(result.body.error.code,reason);
    assert.deepEqual(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id),before);
  }
  assert.equal((await request(version,'bob','PATCH','tasks/A1',{status:'Closed'})).status,200);
  assert.equal((await request(version,'bob','PATCH','tasks/A1',{status:'Open'})).status,403);
  assert.equal((await request(version,'alice','PATCH','tasks/A1',{status:'Open'})).status,200);
  assert.equal((await request(version,'alice','PATCH','tasks/A2',{title:'Owner override'})).status,200);
  assert.equal((await request(version,'alice','DELETE','projects/alpha/members/bob')).status,200);
  assert.equal((await request(version,'bob','PATCH','tasks/A1',{title:'Still assigned but no membership'})).status,403);
});
test('V4 admin permissions: positive within tenant; negative across every resource/action', async t => {
  const { request, db } = await fixture(t);
  for (const [method,path,body] of [
    ['GET','tasks/B1'],['PATCH','tasks/B1',{title:'No'}],['DELETE','projects/beta'],
    ['GET','projects/beta/members'],['POST','projects/beta/members',{userId:'bob',role:'Member'}],
    ['PATCH','projects/beta/members/charlie',{role:'Viewer'}],['DELETE','projects/beta/members/charlie'],
  ]) {
    const denied = await request('v4','admin-alpha',method,`${path}?tenantId=beta&role=Admin`,body,{'X-Tenant-Id':'beta','X-Role':'Admin'});
    assert.equal(denied.status,403); assert.equal(denied.body.error.code,'TENANT_MISMATCH');
  }
  assert.equal((await request('v4','admin-alpha','GET','tasks/A1')).status,200);
  assert.equal((await request('v4','admin-alpha','PATCH','tasks/A2',{status:'Open'})).status,200);
  assert.equal((await request('v4','admin-alpha','GET','projects/alpha/members')).status,200);
  assert.equal((await request('v4','admin-alpha','POST','projects/alpha/members',{userId:'admin-alpha',role:'Viewer'})).status,201);
  assert.equal((await request('v4','admin-alpha','PATCH','projects/alpha/members/vera',{role:'Member'})).status,200);
  assert.equal((await request('v4','admin-alpha','DELETE','projects/alpha/members/vera')).status,200);
  assert.equal((await request('v4','admin-alpha','POST','projects/alpha/members',{userId:'charlie',role:'Member'})).status,403);
  assert.equal((await request('v4','admin-beta','GET','tasks/B1')).status,200);
  assert.equal((await request('v4','admin-alpha','DELETE','projects/alpha')).status,200);
  assert.equal(db.prepare('SELECT count(*) AS n FROM tasks WHERE projectId = ?').get('alpha').n,0);
});
test('Spoofing and validation cannot change identity, tenant, role, project or assignee', async t => {
  const { request } = await fixture(t);
  for (const version of ['v2','v3','v4']) {
    assert.equal((await request(version,'bob','DELETE','projects/alpha?role=Admin',undefined,{'X-Role':'Admin'})).status,403);
    assert.equal((await request(version,'vera','PATCH','tasks/A1',{title:'No',role:'Admin'})).status,403);
    for (const field of ['role','tenantId','projectId','assigneeId','userId']) assert.equal((await request(version,'alice','PATCH','tasks/A1',{[field]:'Admin'})).status,400);
    for (const body of [{},[],null,{status:'Done'},{title:''},{title:5}]) assert.equal((await request(version,'alice','PATCH','tasks/A1',body)).status,400);
    assert.equal((await request(version,'alice','PATCH','projects/alpha/members/vera',{role:'Admin'})).status,400);
    assert.equal((await request(version,'alice','DELETE','projects/alpha/members/alice')).status,409);
    assert.equal((await request(version,'alice','POST','projects/alpha/members',{userId:'bob',role:'Member'})).status,409);
    assert.equal((await request(version,'alice','GET','tasks/missing')).status,404);
    assert.equal((await request(version,'alice','GET','tasks/bad%20id')).status,400);
  }
  assert.equal((await request('v99','alice','GET','tasks/A1')).status,404);
});
test('Malformed JSON, static UI and local reset endpoint work over HTTP', async t => {
  const { db, baseUrl } = await fixture(t);
  const response = await fetch(`${baseUrl}/api/v3/tasks/A1`, {method:'PATCH',headers:{Authorization:'Bearer demo-bob','Content-Type':'application/json'},body:'{broken'});
  assert.equal(response.status,400); assert.equal((await response.json()).error.code,'INVALID_JSON');
  assert.match(await (await fetch(baseUrl)).text(),/Task Authorization Lab/);
  assert.equal((await fetch(`${baseUrl}/app.js`)).status,200);
  db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('Modified','A1');
  assert.equal((await fetch(`${baseUrl}/lab/reset`,{method:'POST',headers:{Origin:'https://other.example'}})).status,403);
  assert.equal(db.prepare('SELECT title FROM tasks WHERE id = ?').get('A1').title,'Modified');
  assert.equal((await fetch(`${baseUrl}/lab/reset`,{method:'POST',headers:{Origin:baseUrl}})).status,200);
  assert.notEqual(db.prepare('SELECT title FROM tasks WHERE id = ?').get('A1').title,'Modified');
});
test('SQLite persists across reopen; reset restores seed and foreign keys cascade', () => {
  const dir = mkdtempSync(join(tmpdir(),'task-lab-persist-')); const path = join(dir,'test.sqlite');
  let db;
  try {
    db = openDatabase(path); db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('Persisted','A1'); db.close();
    db = openDatabase(path); assert.equal(db.prepare('SELECT title FROM tasks WHERE id = ?').get('A1').title,'Persisted');
    resetDatabase(db); assert.notEqual(db.prepare('SELECT title FROM tasks WHERE id = ?').get('A1').title,'Persisted');
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM tasks').get().n,6);
  } finally { db?.close(); rmSync(dir,{recursive:true,force:true}); }
});
