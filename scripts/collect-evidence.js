import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withLab } from './lab-fixture.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'evidence', 'openfga');
mkdirSync(output, { recursive: true });
const manifest = {
  startedAt: new Date().toISOString(), node: process.version, platform: process.platform,
  database: 'Fresh temporary SQLite files; live data/lab.sqlite is never opened or reset.',
  provenance: 'Current OpenFGA Starter/V1 runtime. Before is the preserved pre-OpenFGA reconstructed authentication-only snapshot, not a historical commit; after is a fresh exact current source copy.',
  commands: [], requests: [], sourceSha256: {}, artifactsSha256: {}, status: 'RUNNING',
};
const writeJson = (name, value) => writeFileSync(join(output, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');

async function verifySqliteDatastore() {
  assert.equal(new URL(process.env.FGA_API_URL || 'http://127.0.0.1:8080').origin, 'http://127.0.0.1:8080', 'SQLite evidence expects the local Compose endpoint');
  const id = (await run('docker', ['compose','ps','-q','openfga'], { label: 'docker compose ps -q openfga' })).stdout.trim();
  assert.match(id, /^[0-9a-f]{12,64}$/);
  const container = JSON.parse((await run('docker', ['inspect',id,'--format','{{json .}}'], { label: 'Inspect running OpenFGA datastore (only safe fields exported)' })).stdout);
  const env = new Map(container.Config.Env.map(value => { const i=value.indexOf('='); return [value.slice(0,i),value.slice(i+1)]; }));
  assert.equal(env.get('OPENFGA_DATASTORE_ENGINE'), 'sqlite');
  assert.match(env.get('OPENFGA_DATASTORE_URI'), /^file:\/home\/nonroot\/openfga\.sqlite(?:\?|$)/);
  assert.equal(container.State.Health.Status, 'healthy');
  assert.ok(container.NetworkSettings.Ports['8080/tcp'].some(port => port.HostIp === '127.0.0.1' && port.HostPort === '8080'));
  const mount = container.Mounts.find(mount => mount.Destination === '/home/nonroot');
  assert.equal(mount?.Type, 'volume');
  manifest.datastore = { engine: 'sqlite', image: container.Config.Image, imageId: container.Image,
    databasePath: '/home/nonroot/openfga.sqlite', volume: mount.Name, healthy: true };
  writeJson('datastore.json', manifest.datastore);
}

async function run(executable, args, { cwd = root, env = {}, expected = 0, log, label } = {}) {
  const startedAt = new Date().toISOString();
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolveResult({ code, signal, stdout, stderr }));
  });
  manifest.commands.push({ command: label, startedAt, finishedAt: new Date().toISOString(), expectedExitCode: expected, actualExitCode: result.code, signal: result.signal, log });
  if (log) writeFileSync(join(output, log), `Command: ${label}\nStarted: ${startedAt}\nExpected exit: ${expected}\nActual exit: ${result.code}\n\nSTDOUT\n${result.stdout}\nSTDERR\n${result.stderr}`, 'utf8');
  assert.equal(result.code, expected, `${label}: unexpected exit code; see ${log || 'manifest'}`);
  return result;
}

function snapshotState(db) {
  return JSON.stringify(['projects', 'tasks', 'project_memberships'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
}

async function captureRequests() {
  const cases = [
    ['starter-idor', 'starter', 'alice', 'GET', 'tasks/B1', 200],
    ['v1-idor', 'v1', 'alice', 'GET', 'tasks/B1', 403],
    ['anonymous', 'v1', null, 'GET', 'tasks/A1', 401],
    ['alice-legitimate', 'v1', 'alice', 'GET', 'tasks/A1', 200],
    ['charlie-legitimate', 'v1', 'charlie', 'GET', 'tasks/B1', 200],
    ['member-not-assigned', 'v3', 'bob', 'PATCH', 'tasks/A4', 403, { title: 'Denied attempt' }],
    ['member-task-closed', 'v3', 'bob', 'PATCH', 'tasks/A2', 403, { title: 'Denied attempt' }],
    ['spoofed-role', 'v2', 'bob', 'DELETE', 'projects/alpha?role=Admin', 403, undefined, { 'X-Role': 'Admin' }],
    ['admin-cross-tenant', 'v4', 'admin-alpha', 'GET', 'tasks/B1?tenantId=beta&role=Admin', 403, undefined, { 'X-Role': 'Admin', 'X-Tenant-Id': 'beta' }],
    ['admin-own-tenant', 'v4', 'admin-alpha', 'GET', 'tasks/A1', 200],
    ['member-assigned-open', 'v3', 'bob', 'PATCH', 'tasks/A1', 200, { title: 'Evidence: assigned open task updated' }],
  ];
  const records = await withLab(async ({ db, baseUrl }) => {
    const results = [];
    for (const [id, version, actor, method, path, expectedStatus, body, extras] of cases) {
      const headers = { ...extras };
      if (actor) headers.Authorization = `Bearer demo-${actor}`;
      if (body) headers['Content-Type'] = 'application/json';
      const before = snapshotState(db), start = performance.now();
      const response = await fetch(`${baseUrl}/api/${version}/${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
      const json = await response.json();
      assert.equal(response.status, expectedStatus, id);
      if (response.status >= 400) {
        assert.equal(json.data, null, id);
        assert.equal(snapshotState(db), before, `${id}: rejected request changed database`);
      }
      if (id === 'starter-idor') assert.match(json.data.description, /Private Beta/);
      if (id === 'v1-idor' || id === 'admin-cross-tenant') assert.doesNotMatch(JSON.stringify(json), /Private Beta|roadmap|charlie/);
      if (id === 'member-assigned-open') assert.equal(db.prepare('SELECT title FROM tasks WHERE id = ?').get('A1').title, body.title);
      const record = {
        id, capturedAt: new Date().toISOString(),
        request: { method, path: `/api/${version}/${path}`, actor: actor || 'Anonymous', headers: { ...extras, ...(actor ? { Authorization: '[REDACTED]' } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body } : {}) },
        expectedStatus, response: { status: response.status, durationMs: Math.round(performance.now() - start), body: json },
        verification: { statusMatches: true, stateUnchanged: snapshotState(db) === before, ...(response.status >= 400 ? { deniedDataIsNull: true } : {}) },
      };
      results.push(record);
      manifest.requests.push({ id, expectedStatus, actualStatus: response.status });
    }
    return results;
  });
  writeJson('starter-idor.json', records.find(r => r.id === 'starter-idor'));
  writeJson('v1-idor.json', records.find(r => r.id === 'v1-idor'));
  writeJson('verification-matrix.json', records);
}

function makeSnapshots() {
  const baseline = join(root, 'evidence', 'snapshots', 'before', 'src');
  assert.match(readFileSync(join(baseline, 'app.js'), 'utf8'), /RECONSTRUCTED_AUTHENTICATION_ONLY/);
  const before = join(output, 'snapshots', 'before');
  const after = join(output, 'snapshots', 'after');
  mkdirSync(before, { recursive: true }); mkdirSync(after, { recursive: true });
  cpSync(baseline, join(before, 'src'), { recursive: true });
  cpSync(join(root, 'src'), join(after, 'src'), { recursive: true });
  mkdirSync(join(after, 'openfga'), { recursive: true });
  copyFileSync(join(root, 'openfga', 'model.json'), join(after, 'openfga', 'model.json'));
  manifest.snapshotReconstruction = {
    before: 'Preserved pre-OpenFGA reconstructed authentication-only snapshot, copied from evidence/snapshots/before/src; not historical source.',
    after: 'Exact current src plus generated OpenFGA model; V1 checks a real, isolated OpenFGA store.',
    beforeAppSha256: hash(join(baseline, 'app.js')),
    afterAppSha256: hash(join(root, 'src', 'app.js')),
  };
}

try {
  await verifySqliteDatastore();
  await captureRequests();
  console.log('Captured 11 real HTTP cases on temporary SQLite.');
  makeSnapshots();
  const diff = await run('git', ['diff', '--no-index', '--no-ext-diff', '--no-color', '--', 'before/src', 'after/src'], {
    cwd: join(output, 'snapshots'), expected: 1, label: 'git diff --no-index before/src after/src',
  });
  assert.match(diff.stdout, /\+.*await authorize\(req.params.version/);
  writeFileSync(join(output, 'authorization.diff'), diff.stdout, 'utf8');
  const regressions = [
    ['starter', 'regression-starter.txt', 1, undefined],
    ['v1', 'regression-v1.txt', 0, undefined],
    ['v1', 'regression-snapshot-before.txt', 1, 'before'],
    ['v1', 'regression-snapshot-after.txt', 0, 'after'],
  ];
  for (const [version, log, expected, stage] of regressions) {
    const r = await run(process.execPath, ['scripts/idor-regression.js', `--version=${version}`], {
      log, expected, env: { LAB_EVIDENCE_APP: stage ? join(output, 'snapshots', stage, 'src/app.js') : '' },
      label: `node scripts/idor-regression.js --version=${version}${stage ? ` [reconstructed snapshot: ${stage}]` : ' [current app]'}`,
    });
    assert.match(r.stdout, expected === 1 ? /# fail 1\b/ : /# fail 0\b/);
    assert.match(r.stdout, expected === 1 ? /# pass 2\b/ : /# pass 3\b/);
  }
  console.log('Regression verified: Starter/before RED (1 failure, 2 positive passes); V1/after GREEN (3 passes).');
  await run(process.execPath, ['scripts/build-openfga-model.js', '--check'], { log: 'model-build.txt', label: 'OpenFGA DSL/JSON check' });
  const full = await run(process.execPath, ['--test'], { log: 'tests-after.txt', label: 'node --test (npm.cmd test)' });
  assert.match(full.stdout, /# fail 0\b/);
  manifest.fullSuite = { tests: Number(full.stdout.match(/# tests (\d+)/)?.[1]), pass: Number(full.stdout.match(/# pass (\d+)/)?.[1]), fail: 0 };
  await run(process.execPath, ['scripts/ui-smoke.js'], { log: 'ui-after.txt', label: 'node scripts/ui-smoke.js (npm.cmd run test:ui)' });
  // Verify the exported patch really transforms the reconstructed before app into after.
  await run('git', ['apply', '--check', '-p2', '../../authorization.diff'], {
    cwd: join(output, 'snapshots', 'before'), label: 'git apply --check -p2 ../../authorization.diff [from snapshots/before]',
  });
  manifest.status = 'PASS';
} catch (error) {
  manifest.status = 'FAIL'; manifest.error = error.message; process.exitCode = 1;
  console.error(error.message);
} finally {
  for (const file of ['src/app.js', 'src/policy.js', 'src/auth.js', 'src/db.js', 'src/schema.sql', 'src/server.js', 'src/reset.js', 'test/authorization.test.js', 'test/policy.test.js', 'scripts/idor-regression.js', 'scripts/lab-fixture.js', 'scripts/collect-evidence.js', 'scripts/ui-smoke.js', 'scripts/openfga-sync.js', 'scripts/build-openfga-model.js', 'scripts/render-report.py', 'public/app.js', 'public/index.html', 'public/styles.css', 'package.json', 'package-lock.json', 'compose.yaml', '.env.example', 'openfga/model.fga', 'openfga/model.json', 'src/openfga/client.js', 'src/openfga/relations.js', 'src/openfga/sync.js', 'test/openfga.test.js', 'README.md', 'POLICY.md', 'DEMO.md', 'UI-PLAN.md', 'OPENFGA-PLAN.md', 'OPENFGA-PROGRESS.md', 'evidence/README.md', 'start.bat', '.gitattributes', 'report.md', 'report.html', 'technical-decisions.html']) manifest.sourceSha256[file] = hash(join(root, file));
  const git = await run('git', ['rev-parse', 'HEAD'], { label: 'git rev-parse HEAD' });
  manifest.gitHead = git.stdout.trim();
  const state = await run('git', ['status', '--porcelain'], { label: 'git status --porcelain' });
  manifest.gitWorkingTree = state.stdout.trim().split(/\r?\n/).filter(Boolean);
  for (const file of readdirSync(output, { recursive: true, withFileTypes: true })) {
    if (!file.isFile()) continue;
    const absolute = join(file.parentPath, file.name);
    const relative = absolute.slice(output.length + 1).replaceAll('\\', '/');
    if (relative !== 'manifest.json') manifest.artifactsSha256[relative] = hash(absolute);
  }
  manifest.finishedAt = new Date().toISOString();
  writeJson('manifest.json', manifest);
}
if (manifest.status === 'PASS') console.log(`Evidence PASS: ${manifest.fullSuite.pass}/${manifest.fullSuite.tests} policy/HTTP tests and browser smoke; see evidence/README.md.`);
