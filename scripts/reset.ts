import { existsSync, unlinkSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { config, dataRoot, type Mode } from '../shared/config.js';
import { setup } from './setup.js';
const configs = (['baseline', 'secure'] as Mode[]).map(config);
for (const c of configs) for (const origin of [c.as, c.api, c.taxi]) {
  let live = false;
  try { live = (await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* stopped */ }
  if (live) throw new Error('Stop all lab servers with Ctrl+C before reset:demo.');
}
for (const c of configs) for (const name of ['as', 'wallet', 'taxi', 'revocations']) {
  const path = resolve(c.dir, `${name}.sqlite`);
  const within = relative(resolve(dataRoot), path);
  if (within.startsWith('..') || isAbsolute(within)) throw new Error('Reset path outside lab data root');
  if (existsSync(path)) unlinkSync(path);
}
await setup();
console.log('Demo reset: balances 1,000,000 VND; sessions/jobs/consents cleared; keys preserved.');
