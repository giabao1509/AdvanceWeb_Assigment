import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { withLab } from '../scripts/lab-fixture.js';
import { createApp } from '../src/app.js';
import { openDatabase, resetDatabase, transaction } from '../src/db.js';
import { AuthorizationService, model } from '../src/openfga/sync.js';
import { FgaClient } from '../src/openfga/client.js';
import { projectTuples, tupleIdentity, tupleValue, permissionQuery } from '../src/openfga/relations.js';

async function request(lab, version, user, method, path, body) {
  const response = await fetch(`${lab.baseUrl}/api/${version}/${path}`, {
    method, headers: { Authorization: `Bearer demo-${user}`, ...(body ? { 'Content-Type':'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve=r; }); return { promise, resolve }; };
const sorted = tuples => tuples.map(tupleValue).sort();

test('model matrix: real OpenFGA evaluates all versions, users, tasks and actions', async t => {
  await withLab(async lab => {
    const { db, authorization } = lab;
    const tasks=db.prepare('SELECT * FROM tasks ORDER BY id').all();
    const users=db.prepare('SELECT * FROM users ORDER BY id').all();
    let assertions=0;
    for (const version of ['v1','v2','v3','v4']) {
      for (const principal of users) {
        for (const task of tasks) {
          const project=db.prepare('SELECT * FROM projects WHERE id=?').get(task.projectId);
          const membership=db.prepare('SELECT * FROM project_memberships WHERE projectId=? AND userId=?').get(project.id,principal.id);
          for (const action of ['read','edit']) {
            const role=membership?.role;
            let expected=Boolean(role);
            if (version!=='v1' && action==='edit') expected=role==='Owner' || role==='Member';
            if (['v3','v4'].includes(version) && action==='edit' && role==='Member') expected=task.assigneeId===principal.id && task.status==='Open';
            if (version==='v4') expected=principal.tenantId===project.tenantId && (Boolean(principal.isAdmin) || expected);
            const actual=await authorization.check(permissionQuery(version,principal,action,{project,task}));
            assert.equal(actual,expected,`${version}/${principal.id}/${action}/${task.id}`); assertions++;
          }
        }
        for(const project of db.prepare('SELECT * FROM projects ORDER BY id').all()) {
          const m=db.prepare('SELECT role FROM project_memberships WHERE projectId=? AND userId=?').get(project.id,principal.id);
          for(const action of ['read','delete','members']) {
            let expected=action==='read' || version==='v1' ? Boolean(m) : m?.role==='Owner';
            if(version==='v4') expected=principal.tenantId===project.tenantId && (Boolean(principal.isAdmin) || expected);
            assert.equal(await authorization.check(permissionQuery(version,principal,action,{project})),expected,`${version}/${principal.id}/${action}/${project.id}`); assertions++;
          }
        }
      }
    }
    t.diagnostic(`${assertions} independent expected decisions checked against persisted OpenFGA tuples.`);
  });
});

test('model ID stays pinned when a different newer model is published', async () => {
  await withLab(async ({ authorization }) => {
    const changed=structuredClone(model);
    changed.type_definitions.find(t=>t.type==='project').relations.can_read_v2={ computedUserset:{relation:'owner'} };
    const newer=await authorization.client.writeModel(authorization.storeId,changed);
    const query={user:'user:bob',relation:'can_read_v2',object:'project:alpha'};
    assert.equal(await authorization.check(query),true);
    assert.equal(await authorization.client.check(authorization.storeId,newer.authorization_model_id,query),false);
  });
});

test('stored role changes, cross-tenant memberships and cascades follow selected version', async () => {
  await withLab(async lab => {
    assert.equal((await request(lab,'v1','alice','POST','projects/alpha/members',{userId:'charlie',role:'Member'})).status,201);
    for(const v of ['v1','v2','v3']) assert.equal((await request(lab,v,'charlie','GET','tasks/A1')).status,200);
    assert.equal((await request(lab,'v4','charlie','GET','tasks/A1')).status,403);
    assert.equal((await request(lab,'v2','alice','PATCH','projects/alpha/members/bob',{role:'Viewer'})).status,200);
    const graph=await lab.authorization.client.readTuples(lab.authorization.storeId);
    assert.ok(graph.some(t=>t.user==='user:bob'&&t.object==='project:alpha'&&t.relation==='viewer'));
    assert.ok(!graph.some(t=>t.user==='user:bob'&&t.object==='project:alpha'&&t.relation==='member'));
    assert.equal((await request(lab,'v2','bob','PATCH','tasks/A1',{title:'No stale Member grant'})).status,403);
    assert.equal((await request(lab,'v2','alice','DELETE','projects/alpha')).status,200);
    const after=await lab.authorization.client.readTuples(lab.authorization.storeId);
    assert.ok(!after.some(t=>t.object==='project:alpha'||t.user==='project:alpha'||/^task:A/.test(t.object)));
  });
});

test('partial sync stays closed; durable outbox recovers after service restart', async () => {
  await withLab(async lab => {
    const {authorization,db}=lab;
    const originalWrite=authorization.client.writeTuples.bind(authorization.client);
    authorization.client.writeTuples=async (...args)=>{ await originalWrite(...args); throw new Error('crash after remote write'); };
    const result=await request(lab,'v4','alice','DELETE','projects/alpha/members/bob');
    assert.equal(result.status,202); assert.equal(result.body.data.committed,true);
    assert.equal(result.body.trace.at(-1).result,'PENDING');
    assert.equal(db.prepare('SELECT count(*) AS n FROM project_memberships WHERE userId=?').get('bob').n,0);
    assert.equal((await request(lab,'v4','bob','GET','tasks/A1')).status,503);
    assert.ok(db.prepare('SELECT count(*) AS n FROM authorization_outbox').get().n>0);
    const op=result.body.data.operationId;
    const getOp=async user=>fetch(`${lab.baseUrl}/lab/operations/${op}`,{headers:{Authorization:`Bearer demo-${user}`}});
    assert.equal((await getOp('bob')).status,404);
    assert.equal((await (await getOp('alice')).json()).data.authorizationSync,'pending');
    authorization.client.writeTuples=originalWrite;
    const restarted=new AuthorizationService(db,{client:authorization.client});
    await restarted.sync();
    assert.equal(restarted.state().storeId,authorization.state().storeId);
    assert.equal(restarted.state().modelId,authorization.state().modelId);
    // A new app/service sees the same pinned graph after recovery.
    assert.equal(await restarted.check({user:'user:bob',relation:'can_read_v4',object:'task:A1'}),false);
    assert.equal(db.prepare('SELECT count(*) AS n FROM authorization_outbox').get().n,0);
    assert.equal(authorization.ready(),true,'another synchronizer recovers the pinned graph for the existing service');
    assert.equal((await (await getOp('alice')).json()).data.authorizationSync,'complete');
    assert.equal((await request(lab,'v4','bob','GET','tasks/A1')).status,403);
  });
});

test('failed Check cannot write; Starter remains independent of engine availability', async () => {
  await withLab(async lab => {
    const original=lab.authorization.client.check;
    lab.authorization.client.check=async()=>{throw new Error('network unavailable');};
    const before=lab.db.prepare('SELECT * FROM tasks WHERE id=?').get('A1');
    const result=await request(lab,'v4','bob','PATCH','tasks/A1',{title:'Must not write'});
    assert.equal(result.status,503); assert.equal(result.body.data,null);
    assert.deepEqual(lab.db.prepare('SELECT * FROM tasks WHERE id=?').get('A1'),before);
    assert.equal((await request(lab,'starter','alice','GET','tasks/B1')).status,200);
    lab.authorization.client.check=original;
  });
});

test('missing condition context is an engine error, not a permission denial or ALLOW', async () => {
  await withLab(async ({authorization})=>{
    await assert.rejects(authorization.check({user:'user:bob',relation:'can_edit_v3',object:'task:A1'}),{message:'AUTHORIZATION_UNAVAILABLE'});
  });
});

test('changed pinned binding fails closed before business writes', async () => {
  await withLab(async lab=>{
    lab.db.prepare('UPDATE authorization_state SET modelHash=? WHERE id=1').run('invalid-binding');
    const before=lab.db.prepare('SELECT * FROM tasks WHERE id=?').get('A1');
    assert.equal((await request(lab,'v4','alice','PATCH','tasks/A1',{title:'Must not write'})).status,503);
    assert.deepEqual(lab.db.prepare('SELECT * FROM tasks WHERE id=?').get('A1'),before);
    await assert.rejects(lab.authorization.sync(),{message:'AUTHORIZATION_MODEL_MISMATCH'});
  });
});

test('snapshot race also rejects an outdated DENY after a membership grant', async () => {
  await withLab(async lab=>{
    const entered=deferred(),release=deferred(),original=lab.authorization.client.check.bind(lab.authorization.client);
    lab.authorization.client.check=async(...args)=>{const allowed=await original(...args);assert.equal(allowed,false);entered.resolve();await release.promise;return allowed;};
    const pending=request(lab,'v3','admin-alpha','GET','tasks/A1'); await entered.promise;
    try{lab.db.prepare('INSERT INTO project_memberships VALUES (?,?,?)').run('alpha','admin-alpha','Viewer');}
    finally{release.resolve();}
    assert.equal((await pending).status,409);
    lab.authorization.client.check=original; await lab.authorization.sync();
    assert.equal((await request(lab,'v3','admin-alpha','GET','tasks/A1')).status,200);
  });
});

for (const mutation of ['status','membership','reset','delete']) {
  test(`snapshot race: ${mutation} during Check rejects stale ALLOW before read/write`, async () => {
    await withLab(async lab => {
      const {authorization,db}=lab, entered=deferred(), release=deferred();
      const original=authorization.client.check.bind(authorization.client);
      authorization.client.check=async (...args)=>{
        const answer=await original(...args); entered.resolve(); await release.promise; return answer;
      };
      const pending=request(lab,'v4','bob',mutation==='delete'?'GET':'PATCH','tasks/A1',mutation==='delete'?undefined:{title:'Stale edit'});
      await entered.promise;
      try {
        if(mutation==='status') db.prepare('UPDATE tasks SET status=? WHERE id=?').run('Closed','A1');
        if(mutation==='membership') db.prepare('DELETE FROM project_memberships WHERE projectId=? AND userId=?').run('alpha','bob');
        if(mutation==='reset') resetDatabase(db);
        if(mutation==='delete') db.prepare('DELETE FROM projects WHERE id=?').run('alpha');
      } finally {release.resolve();}
      const result=await pending;
      assert.equal(result.status,409); assert.equal(result.body.error.code,'AUTHORIZATION_CONTEXT_CHANGED'); assert.equal(result.body.data,null);
      assert.notEqual(db.prepare('SELECT title FROM tasks WHERE id=?').get('A1')?.title,'Stale edit');
      assert.ok(!result.body.trace.some(t=>t.name==='Authorization decision' && t.result==='ALLOW'));
      authorization.client.check=original;
      await authorization.sync();
    });
  });
}

test('reconciliation handles paged graphs, batches and removes stale conditioned tuples', async () => {
  await withLab(async ({authorization,db}) => {
    transaction(db,()=>{
      const insert=db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?)');
      for(let i=0;i<130;i++) insert.run(`X${i}`,'alpha','bob','Bulk fixture','','Open');
    });
    await authorization.sync();
    assert.deepEqual(sorted(await authorization.client.readTuples(authorization.storeId)),sorted(projectTuples(db)));
    const keys=(await authorization.client.readTuples(authorization.storeId)).map(tupleIdentity);
    assert.equal(new Set(keys).size,keys.length);
    resetDatabase(db); await authorization.sync();
    assert.deepEqual(sorted(await authorization.client.readTuples(authorization.storeId)),sorted(projectTuples(db)));
  });
});

test('synchronizers use a SQLite lease and do not edit a store concurrently', async () => {
  await withLab(async ({authorization,db}) => {
    const other=new AuthorizationService(db,{client:authorization.client});
    const owner=deferred(),release=deferred(),original=authorization.client.readTuples.bind(authorization.client);
    authorization.client.readTuples=async (...args)=>{owner.resolve(); await release.promise; return original(...args);};
    const first=authorization.sync(); await owner.promise;
    try {await assert.rejects(other.sync(),{message:'AUTHORIZATION_SYNC_BUSY'});}
    finally {release.resolve(); await first; authorization.client.readTuples=original;}
  });
});

test('SDK enforces an actual network timeout without retrying or returning ALLOW', async () => {
  const connections=new Set(); let requests=0;
  const server=createServer(()=>{requests++;});
  server.on('connection',s=>{connections.add(s);s.on('close',()=>connections.delete(s));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const client=new FgaClient({apiUrl:`http://127.0.0.1:${server.address().port}`,timeout:100});
  const started=performance.now();
  try {
    await assert.rejects(client.check('01ARZ3NDEKTSV4RRFFQ69G5FAV','01ARZ3NDEKTSV4RRFFQ69G5FAW',{user:'user:bob',relation:'read',object:'task:A1'}));
    assert.equal(requests,1); assert.ok(performance.now()-started<2000);
  } finally {for(const socket of connections) socket.destroy(); await new Promise(resolve=>server.close(resolve));}
});

test('SQLite refuses an async transaction callback and rolls back synchronous writes', () => {
  const db=openDatabase(':memory:');
  try {
    assert.throws(()=>transaction(db,async()=>{db.prepare('UPDATE tasks SET title=? WHERE id=?').run('Never committed','A1');}),/must be synchronous/);
    assert.notEqual(db.prepare('SELECT title FROM tasks WHERE id=?').get('A1').title,'Never committed');
  } finally {db.close();}
});

test('new app with unavailable OpenFGA fails closed instead of falling back to local PDP', async () => {
  const db=openDatabase(':memory:');
  const authorization=new AuthorizationService(db,{client:new FgaClient({apiUrl:'http://127.0.0.1:1',timeout:100})});
  const app=createApp({db,authorization});
  const server=app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
  try {
    assert.equal(await app.locals.ready,false);
    const baseUrl=`http://127.0.0.1:${server.address().port}`;
    const lab={baseUrl};
    assert.equal((await request(lab,'v4','alice','GET','tasks/A1')).status,503);
    assert.equal((await request(lab,'starter','alice','GET','tasks/B1')).status,200);
    const reset=await fetch(`${baseUrl}/lab/reset`,{method:'POST',headers:{Authorization:'Bearer demo-alice'}});
    assert.equal(reset.status,202);
    assert.equal((await reset.json()).data.committed,true);
  } finally {await new Promise(resolve=>server.close(resolve));db.close();}
});
