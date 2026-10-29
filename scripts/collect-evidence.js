import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withLab } from './lab-fixture.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'evidence');
mkdirSync(output, { recursive: true });
const manifest = {
  startedAt: new Date().toISOString(), node: process.version, platform: process.platform,
  database: 'Fresh temporary SQLite files; live data/lab.sqlite is never opened or reset.',
  provenance: 'Current Starter/V1 policies plus explicitly reconstructed executable before/after snapshots; not historical commits.',
  commands: [], requests: [], sourceSha256: {}, artifactsSha256: {}, status: 'RUNNING',
};
const writeJson = (name, value) => writeFileSync(join(output, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');

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
  const current = readFileSync(join(root, 'src/app.js'), 'utf8');
  const begin = current.indexOf("        const membership = db.prepare('SELECT * FROM project_memberships");
  const end = current.indexOf('        return work(req, { task, project });', begin);
  assert.ok(begin >= 0 && end > begin, 'Authorization wrapper changed; review snapshot reconstruction before proceeding');
  const protectedBlock = current.slice(begin, end);
  assert.ok(protectedBlock.includes('authorize(req.params.version') && protectedBlock.includes("if (!decision.allowed) fail(403"));
  const before = (current.slice(0, begin) + "        req.trace.push({ name: 'Object authorization', result: 'SKIPPED', reason: 'RECONSTRUCTED_AUTHENTICATION_ONLY' });\n" + current.slice(end))
    .replace("import { authorize, versions } from './policy.js';", "import { versions } from './policy.js';");
  for (const stage of ['before', 'after']) {
    const directory = join(output, 'snapshots', stage, 'src');
    mkdirSync(directory, { recursive: true });
    for (const name of ['auth.js', 'db.js', 'schema.sql', 'policy.js']) copyFileSync(join(root, 'src', name), join(directory, name));
    writeFileSync(join(directory, 'app.js'), stage === 'before' ? before : current, 'utf8');
  }
  manifest.snapshotReconstruction = {
    before: 'Current app with the membership lookup / PDP call / denial block removed from endpoint(). Authentication, lookup, validation and transactions stay in place. This reproduces the authentication-only boundary, not an original historical file.',
    after: 'Exact copy of current src/app.js plus its local dependencies. The regression selects V1.',
    unchangedPolicy: 'policy.js is copied unchanged into both snapshots; the before wrapper does not call authorize().',
  };
}

try {
  await captureRequests();
  console.log('Captured 11 real HTTP cases on temporary SQLite.');
  makeSnapshots();
  const diff = await run('git', ['diff', '--no-index', '--no-ext-diff', '--no-color', '--', 'before/src/app.js', 'after/src/app.js'], {
    cwd: join(output, 'snapshots'), expected: 1, label: 'git diff --no-index before/src/app.js after/src/app.js',
  });
  assert.match(diff.stdout, /\+.*authorize\(req.params.version/);
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
  for (const file of ['src/app.js', 'src/policy.js', 'src/auth.js', 'src/db.js', 'src/schema.sql', 'test/authorization.test.js', 'scripts/idor-regression.js', 'scripts/lab-fixture.js', 'scripts/collect-evidence.js', 'scripts/ui-smoke.js', 'public/app.js', 'public/index.html', 'public/styles.css', 'package.json']) manifest.sourceSha256[file] = hash(join(root, file));
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
if (manifest.status === 'PASS') console.log(`Evidence PASS: ${manifest.fullSuite.pass}/${manifest.fullSuite.tests} HTTP tests and browser smoke; see evidence/README.md.`);
