import 'dotenv/config';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';

// Isolate this run from the dashboard's databases, logs and listening ports.
const root = process.cwd();
mkdirSync(join(root, 'data'), { recursive: true });
const workspace = mkdtempSync(join(root, 'data', 'submission-'));
const reservations = await Promise.all(Array.from({ length: 4 }, async () => {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolvePromise); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Cannot reserve evidence port');
  return { server, port: address.port };
}));
for (const [index, name] of ['LAB_BASELINE_ORDER_PORT', 'LAB_SECURE_ORDER_PORT', 'LAB_BASELINE_INVENTORY_PORT', 'LAB_SECURE_INVENTORY_PORT'].entries()) {
  process.env[name] = String(reservations[index]!.port);
}
process.env.LAB_DATA_DIR = join(workspace, 'database');
process.env.LAB_EVIDENCE_DIR = join(workspace, 'runtime');
process.env.LOG_LEVEL = 'info';
await Promise.all(reservations.map(({ server }) => new Promise<void>((done) => server.close(() => done()))));

try {
  const { runSubmission } = await import('../src/testing/submission.js');
  const result = await runSubmission(resolve(root, 'evidence', 'submission'));
  console.log(JSON.stringify(result, null, 2));
  if (result.failed) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
