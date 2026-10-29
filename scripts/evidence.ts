import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ready } from './runtime.js';
import { config, type Mode } from '../shared/config.js';
import { runCase } from '../shared/cases.js';
import { smoke, ApiDriver } from './smoke.js';

const runId = process.env.LAB_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');
const output = resolve('evidence', runId); mkdirSync(output, { recursive: true });
// Config's dataRoot is evaluated at module import, so run the isolated harness in a fresh process.
if (!process.env.LAB_EVIDENCE_CHILD) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/evidence.ts'], { stdio: 'inherit', windowsHide: true,
    env: { ...process.env, LAB_DATA_ROOT: resolve('.local', 'evidence', runId), LAB_PORT_OFFSET: '2000', LAB_EVIDENCE_CHILD: '1', LAB_RUN_ID: runId, LAB_OUTPUT: output } });
  process.exit(await new Promise<number>(resolve => child.on('exit', code => resolve(code ?? 1))));
}
// Parent has already selected the isolated root. Do not change that imported root here.
const runOutput = process.env.LAB_OUTPUT!, observed: any[] = [];
function save(name: string, data: unknown) { const path = resolve(runOutput, name); mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(data, null, 2) + '\n'); }
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
function sourceHashes() { const result: Record<string, string> = {}; for (const dir of ['apps', 'shared', 'scripts', 'public']) for (const file of readdirSync(dir)) { const path = resolve(dir, file); result[relative(process.cwd(), path)] = digest(path); } return result; }
const sourcesAtStart = sourceHashes(), lockAtStart = digest('package-lock.json');
const { setup } = await import('./setup.js');
await setup();
const supervisor = spawn(process.execPath, ['--import', 'tsx', 'scripts/run.ts', 'both'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true, env: process.env });
try {
  const configs = (['baseline', 'secure'] as Mode[]).map(mode => config(mode));
  await ready(configs);
  for (const c of configs) {
    const result = await smoke(c); save(`${c.mode}/happy-path.json`, result);
    const all = [];
    for (const id of ['redirect', 'pkce', 'code_replay', 'wrong_verifier', 'wrong_secret', 'other_client', 'refresh_replay', 'other_refresh']) {
      const result = await runCase(c, id); all.push(result);
      if (c.mode === 'secure') assert.equal(result.protected, true, `${id} must be protected`);
    }
    save(`${c.mode}/attacks.json`, all); observed.push(...all);
  }
  // Real 60s code expiry and real 120s offline-job evidence run concurrently, using fresh grants.
  const expiry = Promise.all(configs.map(async c => { const result = await runCase(c, 'code_expired'); assert.equal(result.protected, c.mode === 'secure'); save(`${c.mode}/code-expiry.json`, result); observed.push(result); }));
  await Promise.all(configs.map(async c => {
    const driver = new ApiDriver(c); await driver.link();
    const before = await driver.observe(); const job = await driver.action('schedule'); assert.equal(job.status, 201);
    before.link = (await driver.state()).link;
    await driver.action('logout'); assert.equal((await driver.observe()).user, null);
    for (let i = 0; i < 145; i++) {
      const state = await driver.observe(), row = state.jobs.find((j: any) => j.id === job.body.job);
      if (row?.status === 'completed') {
        assert.equal(row.detail.active_taxi_sessions, 0); assert.equal(state.wallet.charge_count, before.wallet.charge_count + 1);
        assert.equal(row.detail.steps[0].service, 'Wallet AS');
        save(`${c.mode}/offline-job.json`, { token_exp_before: before.link.token_exp, scheduled: job.body, observed_at: state.now, job: row, charge_count_before: before.wallet.charge_count, charge_count_after: state.wallet.charge_count });
        break;
      }
      if (row?.status === 'failed' || i === 144) throw new Error(`${c.mode} offline job did not complete`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    await driver.action('login');
    await driver.revoke();
    const balance = await driver.action('balance'); assert.equal(balance.body.steps.at(-1).status, 200);
    const refresh = await driver.action('refresh');
    assert.equal(refresh.status, c.mode === 'secure' ? 409 : 200);
    save(`${c.mode}/consent-revocation.json`, { balance_after_revoke: balance.body, refresh_after_revoke: refresh });
  }));
  await expiry;
  const { concurrency } = await import('./protocol.js');
  save('secure/concurrency.json', await concurrency(config('secure')));
  // Grant table from observed, verified JWT responses, including a no-offline consent.
  const { exchangeFixture, rawToken } = await import('../shared/fixtures.js');
  const { tokenSummary } = await import('../shared/oauth-client.js');
  for (const c of configs) {
    const withOffline = await exchangeFixture(c), withoutOffline = await exchangeFixture(c, { scope: 'wallet:read' });
    const refresh = await rawToken(c, { grant_type: 'refresh_token', refresh_token: withOffline.tokens.body.refresh_token });
    const m2m = await rawToken(c, { grant_type: 'client_credentials', scope: 'rates:read' }, 'taxi-m2m');
    assert.equal(Boolean(withOffline.tokens.body.refresh_token), true);
    assert.equal(Boolean(withoutOffline.tokens.body.refresh_token), false);
    assert.equal(Boolean(m2m.body.refresh_token), false);
    save(`${c.mode}/grants.json`, await Promise.all([
      tokenSummary(c, withOffline.tokens.body as any, 'authorization_code + offline_access'), tokenSummary(c, withoutOffline.tokens.body as any, 'authorization_code without offline_access'),
      tokenSummary(c, refresh.body as any, 'refresh_token'), tokenSummary(c, m2m.body as any, 'client_credentials')
    ]));
  }
  assert.deepEqual(sourceHashes(), sourcesAtStart, 'Source changed during evidence run; rerun for a consistent snapshot.');
  assert.equal(digest('package-lock.json'), lockAtStart, 'Lockfile changed during run');
  const rows = observed.map(x => `<tr><td>${x.mode}</td><td>${x.id}</td><td>${x.protected ? 'Đã bảo vệ' : 'Baseline chấp nhận'}</td><td>${x.steps.map((s: any) => s.status).join(' → ')}</td></tr>`).join('');
  const esc = (s: unknown) => String(s).replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]!));
  const read = (file: string) => JSON.parse(readFileSync(resolve(runOutput, file), 'utf8'));
  let sections = '';
  for (const mode of ['baseline', 'secure']) {
    const grants = read(`${mode}/grants.json`), job = read(`${mode}/offline-job.json`), revoke = read(`${mode}/consent-revocation.json`);
    sections += `<h2>${mode === 'secure' ? 'Full security' : 'Baseline'}</h2><h3>Grant table từ response thật</h3><table><tr><th>Grant</th><th>Refresh?</th><th>sub / principal</th><th>aud</th><th>scope</th><th>expires_in</th></tr>${grants.map((g: any) => `<tr><td>${esc(g.grant)}</td><td>${g.refresh_token}</td><td>${esc(g.sub)} / ${esc(g.principal_type)}</td><td>${esc(g.aud)}</td><td>${esc(g.scope)}</td><td>${g.expires_in}</td></tr>`).join('')}</table><h3>Offline job</h3><p>Token exp: ${job.token_exp_before}; job quan sát hoàn tất lúc ${job.observed_at}. Session Taxi khi job bắt đầu: <b>${job.job.detail.active_taxi_sessions}</b>. Counter: <b>${job.charge_count_before} → ${job.charge_count_after}</b>. ${esc(job.job.detail.steps.map((s: any) => `${s.service} ${s.status}`).join(' → '))}.</p><h3>Gỡ consent</h3><p>Đọc số dư khi access token còn hạn: ${revoke.balance_after_revoke.steps.at(-1).status}. Taxi yêu cầu refresh sau revoke: HTTP ${revoke.refresh_after_revoke.status}, ${esc(revoke.refresh_after_revoke.body.error || 'baseline vẫn chấp nhận')}.</p>`;
    for (const name of ['happy-path', 'attacks', 'code-expiry', 'offline-job', 'consent-revocation']) sections += `<details><summary>${mode}/${name}.json — dữ liệu đầy đủ đã che</summary><pre>${esc(JSON.stringify(read(`${mode}/${name}.json`), null, 2))}</pre></details>`;
  }
  sections += `<h2>Kiểm tra đồng thời</h2><pre>${esc(JSON.stringify(read('secure/concurrency.json'), null, 2))}</pre>`;
  writeFileSync(resolve(runOutput, 'REPORT.html'), `<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Block 5 — Evidence</title><style>body{font:14px/1.7 system-ui;max-width:1100px;margin:40px auto;padding:0 20px;color:#25314a}table{border-collapse:collapse;width:100%;font-size:12px}td,th{padding:9px;border:1px solid #ddd;text-align:left}th{background:#f2f5fa}pre{background:#f6f8fb;white-space:pre-wrap;word-break:break-word;padding:16px;font-size:11px}details{margin:12px 0}summary{cursor:pointer;color:#3159df}h2{margin-top:40px}</style><h1>Block 5 · Kết quả chạy thật</h1><p>Run: ${process.env.LAB_RUN_ID}. Happy path, idempotency, M2M, code expiry 60s, offline job sau exp 120s và consent revoke đều có assertions.</p><p>HTTP loopback theo yêu cầu. Token/secret đã che. Báo cáo tự chứa dữ liệu; bộ chạy HTTP này không thay thế kiểm tra browser thật (kết quả UI riêng tại evidence/ui).</p><table><tr><th>Mode</th><th>Case</th><th>Quan sát</th><th>HTTP status</th></tr>${rows}</table>${sections}<h2>Giới hạn</h2><p>Một process mỗi service, shared local revocation store, không kiểm load/HA, không chứng minh power-loss hoặc production security. Source/lockfile được giữ nguyên suốt lượt chạy, hashes nằm trong manifest.json.</p></html>`);
  const artifacts: Record<string, string> = {};
  const forbidden = configs.flatMap(c => [...Object.values(c.clients), c.vaultKey, String(c.privateJwk.d)]);
  function inspect(dir: string) {
    for (const file of readdirSync(dir)) {
      const path = resolve(dir, file); if (statSync(path).isDirectory()) { inspect(path); continue; }
      const text = readFileSync(path, 'utf8');
      assert(!forbidden.some(secret => text.includes(secret)), 'Secret value leaked into evidence');
      assert(!/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(text), 'Raw JWT leaked into evidence');
      assert(!/"(?:access_token|refresh_token)"\s*:\s*"(?!\[REDACTED\])/.test(text), 'Raw token field leaked into evidence');
      artifacts[relative(runOutput, path)] = digest(path);
    }
  }
  inspect(runOutput);
  save('manifest.json', { run_id: process.env.LAB_RUN_ID, completed_at: new Date().toISOString(), status: 'PASS', transport: 'HTTP loopback', node: process.version, lockfile_sha256: lockAtStart,
    versions: Object.fromEntries(Object.entries(JSON.parse(readFileSync('package-lock.json', 'utf8')).packages).map(([name, value]: [string, any]) => [name || 'root', value.version])), source_hashes: sourcesAtStart, artifact_hashes: artifacts, secret_scan: 'PASS',
    ttl: { code: 60, access_token: 120, refresh_token: 604800 }, observations: observed.map(x => ({ id: x.id, mode: x.mode, protected: x.protected })), limits: ['Local HTTP driver, real browser verification is separate in evidence/ui', 'No HA, multi-host, crash/power-loss proof or production certification'] });
  console.log(`Evidence PASS: ${runOutput}`);
} catch (error: any) {
  save('failure.json', { status: 'FAIL', message: error.message, at: new Date().toISOString() }); process.exitCode = 1; console.error('Evidence FAILED:', error.message);
} finally { if (supervisor.connected) supervisor.send('shutdown'); else supervisor.kill('SIGTERM'); }
