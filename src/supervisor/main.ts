import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../shared/config.js';
import { createLoggerOptions, registerCommonHooks } from '../shared/http.js';
import type { SigningAlgorithm } from '../shared/signing.js';
import { evidenceCaseFlows, runEvidenceSuite, writeEvidence, type EvidenceCaseId, type EvidenceRunEvent } from '../testing/evidence.js';
import { endToEndCases, runEndToEndCase, runRetiredSigningKeyCheck, type EndToEndCaseId, type EndToEndResult } from '../testing/end-to-end.js';
import { ProcessManager } from './process-manager.js';

const app = Fastify({ logger: createLoggerOptions('supervisor') });
await app.register(cookie);
registerCommonHooks(app);
const manager = new ProcessManager();
let activeSigning: { algorithm: SigningAlgorithm; kid?: 'ed-1' | 'ed-2' } = { algorithm: 'hmac-sha256' };
const adminSession = randomBytes(24).toString('base64url');
const dashboardRoot = join(process.cwd(), 'dist', 'dashboard');

if (!existsSync(join(dashboardRoot, 'index.html'))) {
  throw new Error('Dashboard bundle not found. Run npm run build before starting the supervisor.');
}

await app.register(fastifyStatic, { root: join(dashboardRoot, 'assets'), prefix: '/assets/' });

app.addHook('preHandler', async (request, reply) => {
  if (!request.url.startsWith('/api/')) return;
  const origin = request.headers.origin;
  if (origin && !config.origins.includes(origin)) return reply.code(403).send({ code: 'FORBIDDEN_ORIGIN' });
  if (request.cookies.lab_admin !== adminSession) return reply.code(401).send({ code: 'LAB_ADMIN_REQUIRED' });
});

app.get('/', async (_request, reply) => {
  reply.setCookie('lab_admin', adminSession, { httpOnly: true, sameSite: 'strict', path: '/' });
  return reply.type('text/html').send(readFileSync(join(dashboardRoot, 'index.html'), 'utf8'));
});

app.get('/api/processes', async () => ({ supervisor: { pid: process.pid, port: config.ports.supervisor }, workers: await manager.statuses() }));
app.get('/api/logs', async () => ({ logs: manager.recentLogs() }));

app.get('/api/logs/stream', async (request, reply) => {
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  for (const entry of manager.recentLogs().slice(-100)) reply.raw.write(`data: ${JSON.stringify(entry)}\n\n`);
  const unsubscribe = manager.subscribe((entry) => reply.raw.write(`data: ${JSON.stringify(entry)}\n\n`));
  request.raw.on('close', unsubscribe);
});

app.post('/api/demo/reset', async () => {
  manager.sendAll({ type: 'reset' });
  return { ok: true };
});

app.get('/api/end-to-end/cases', async () => ({ cases: endToEndCases }));

app.post('/api/flows/run', async (request, reply) => {
  if (testRunActive) return reply.code(409).send({ code: 'RUN_ALREADY_ACTIVE' });
  const body = (request.body ?? {}) as { flowId?: string; caseId?: string };
  const selected = endToEndCases.find((item) => item.id === body.caseId && item.flowId === body.flowId);
  if (!selected || (body.flowId !== 'baseline-e2e' && body.flowId !== 'secure-e2e')) {
    return reply.code(400).send({ code: 'INVALID_FLOW_CASE' });
  }
  testRunActive = true;
  try {
    const result = await runEndToEndCase({
      caseId: selected.id as EndToEndCaseId,
      signing: activeSigning,
      waitForInternalExchange: (traceId) => manager.waitForHttpExchange(traceId),
    });
    const file = join(config.evidenceDir, 'end-to-end-runs.json');
    const existing = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as { results?: EndToEndResult[] } : { results: [] };
    const results = [...(existing.results ?? []), result].slice(-100);
    writeFileSync(file, `${JSON.stringify({ generatedAt: result.completedAt, results }, null, 2)}\n`);
    return result;
  } finally {
    testRunActive = false;
  }
});

app.get('/api/end-to-end/evidence', async () => {
  const file = join(config.evidenceDir, 'end-to-end-runs.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { generatedAt: null, results: [] };
});

app.post('/api/demo/signing-mode', async (request, reply) => {
  const body = request.body as { algorithm?: string; kid?: string };
  if (body.algorithm !== 'hmac-sha256' && body.algorithm !== 'ed25519') return reply.code(400).send({ code: 'INVALID_MODE' });
  if (body.algorithm === 'ed25519' && body.kid !== 'ed-1' && body.kid !== 'ed-2') return reply.code(400).send({ code: 'INVALID_KID' });
  manager.send('secure-inventory', { type: 'set-verifier-mode', algorithm: body.algorithm });
  manager.send('secure-order', { type: 'set-signing', algorithm: body.algorithm, kid: body.kid as 'ed-1' | 'ed-2' | undefined });
  await Promise.all([
    manager.waitForWorkerState('secure-inventory', (state) => state?.activeAlgorithm === body.algorithm),
    manager.waitForWorkerState('secure-order', (state) => state !== undefined && state.activeAlgorithm === body.algorithm
      && (body.algorithm !== 'ed25519' || state.activeSigningKid === body.kid)),
  ]);
  activeSigning = body.algorithm === 'ed25519'
    ? { algorithm: 'ed25519', kid: body.kid as 'ed-1' | 'ed-2' }
    : { algorithm: 'hmac-sha256' };
  return { ok: true, algorithm: body.algorithm, kid: body.kid };
});

app.post('/api/demo/rotation/initial', async () => {
  activeSigning = { algorithm: 'ed25519', kid: 'ed-1' };
  manager.send('secure-inventory', { type: 'add-trusted-key', kid: 'ed-1' });
  manager.send('secure-inventory', { type: 'set-verifier-mode', algorithm: 'ed25519' });
  manager.send('secure-order', { type: 'set-signing', algorithm: 'ed25519', kid: 'ed-1' });
  return { ok: true, step: 'initial' };
});
app.post('/api/demo/rotation/prepare', async () => {
  manager.send('secure-inventory', { type: 'add-trusted-key', kid: 'ed-2' });
  return { ok: true, step: 'prepare', note: 'Order continues signing with ed-1' };
});
app.post('/api/demo/rotation/switch', async () => {
  activeSigning = { algorithm: 'ed25519', kid: 'ed-2' };
  manager.send('secure-order', { type: 'set-signing', algorithm: 'ed25519', kid: 'ed-2' });
  return { ok: true, step: 'switch' };
});
app.post('/api/demo/rotation/retire', async (request, reply) => {
  const body = request.body as { confirmNoInflight?: boolean };
  if (!body.confirmNoInflight) return reply.code(409).send({ code: 'CONFIRM_GRACE_PERIOD_REQUIRED' });
  manager.send('secure-inventory', { type: 'remove-trusted-key', kid: 'ed-1' });
  return { ok: true, step: 'retire' };
});
app.post('/api/demo/rotation/check-retired', async (_request, reply) => {
  if (testRunActive) return reply.code(409).send({ code: 'RUN_ALREADY_ACTIVE' });
  const state = await manager.waitForWorkerState('secure-inventory', (workerState) => workerState !== undefined
    && workerState.activeAlgorithm === 'ed25519'
    && Array.isArray(workerState.trustedKids) && !workerState.trustedKids.includes('ed-1'));
  if (!state.trustedKids || state.trustedKids.includes('ed-1')) return reply.code(409).send({ code: 'OLD_KEY_STILL_TRUSTED' });
  testRunActive = true;
  try {
    return await runRetiredSigningKeyCheck();
  } finally {
    testRunActive = false;
  }
});

let testRunActive = false;
interface DashboardRunState {
  status: 'idle' | 'running' | 'complete' | 'failed';
  activeCase: string | null;
  activeFlow: string | null;
  activeObjective: string | null;
  completed: number;
  total: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  events: EvidenceRunEvent[];
}

let dashboardRunState: DashboardRunState = {
  status: 'idle', activeCase: null, activeFlow: null, activeObjective: null,
  completed: 0, total: 10, startedAt: null, finishedAt: null, error: null, events: [],
};

app.get('/api/tests/state', async () => dashboardRunState);

app.post('/api/tests/run', async (request, reply) => {
  if (testRunActive) return reply.code(409).send({ code: 'TEST_RUN_ACTIVE' });
  const body = (request.body ?? {}) as { caseId?: string };
  if (!body.caseId || !(body.caseId in evidenceCaseFlows)) {
    return reply.code(400).send({ code: 'INVALID_CASE_ID' });
  }
  const caseId = body.caseId as EvidenceCaseId;
  const flow = evidenceCaseFlows[caseId];
  testRunActive = true;
  dashboardRunState = {
    status: 'running', activeCase: caseId, activeFlow: flow, activeObjective: `Preparing ${caseId}`,
    completed: 0, total: 1, startedAt: new Date().toISOString(), finishedAt: null, error: null, events: [],
  };
  try {
    const evidence = await runEvidenceSuite({
      caseIds: [caseId],
      signing: activeSigning,
      stepDelayMs: 350,
      onEvent: (event) => {
        const events = [...dashboardRunState.events, event].slice(-40);
        if (event.type === 'case-start') {
          dashboardRunState = {
            ...dashboardRunState,
            activeCase: event.caseId ?? null,
            activeFlow: event.flow ?? null,
            activeObjective: event.objective ?? null,
            completed: event.completed,
            total: event.total,
            events,
          };
        } else if (event.type === 'case-complete') {
          dashboardRunState = { ...dashboardRunState, completed: event.completed, total: event.total, events };
        } else if (event.type === 'suite-complete') {
          dashboardRunState = {
            ...dashboardRunState,
            status: 'complete', activeCase: null, activeFlow: null,
            activeObjective: `${caseId} completed`, completed: event.completed, total: event.total,
            finishedAt: event.at, events,
          };
        } else {
          dashboardRunState = { ...dashboardRunState, completed: event.completed, total: event.total, events };
        }
      },
    });
    const file = join(config.evidenceDir, 'smoke-results.json');
    const existing = existsSync(file)
      ? JSON.parse(readFileSync(file, 'utf8')) as { results?: typeof evidence.results }
      : { results: [] };
    const merged = new Map((existing.results ?? []).map((result) => [result.id, result]));
    for (const result of evidence.results) merged.set(result.id, result);
    writeEvidence({ generatedAt: evidence.generatedAt, results: [...merged.values()] });
    return evidence;
  } catch (error) {
    dashboardRunState = {
      ...dashboardRunState,
      status: 'failed', activeCase: null, activeFlow: null,
      activeObjective: 'Run failed', finishedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
    throw error;
  } finally {
    testRunActive = false;
  }
});

app.get('/api/evidence', async () => {
  const file = join(config.evidenceDir, 'smoke-results.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { generatedAt: null, results: [] };
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  setTimeout(() => process.exit(0), 5_000);
  void (async () => {
    await manager.stopAll();
    await app.close();
    process.exit(0);
  })();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await manager.startAll();
await app.listen({ host: config.host, port: config.ports.supervisor });
app.log.info({ event: 'SUPERVISOR_READY', url: `http://${config.host}:${config.ports.supervisor}`, pid: process.pid });
console.log(`Listening at http://${config.host}:${config.ports.supervisor}`);
