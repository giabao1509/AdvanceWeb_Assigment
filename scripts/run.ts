import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { config, type Mode } from '../shared/config.js';
import { setup } from './setup.js';

await setup();
const selected = process.argv[2] || 'both';
if (!['both', 'baseline', 'secure'].includes(selected)) throw new Error('Use both | baseline | secure');
const modes: Mode[] = selected === 'both' ? ['baseline', 'secure'] : [selected as Mode];
const children = modes.flatMap(mode => ['wallet-as', 'wallet-api', 'taxi'].map(service => {
  const c = config(mode);
  return spawn(process.execPath, ['--import', 'tsx', `apps/${service}.ts`], { cwd: process.cwd(), stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: true,
    env: { ...process.env, LAB_MODE: mode, LAB_CONFIG: readFileSync(resolve(c.dir, 'config.json'), 'utf8') } });
}));
let closing = false;
function stop() { if (closing) return; closing = true; for (const child of children) { if (child.connected) child.send('shutdown'); else child.kill('SIGTERM'); } }
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, stop);
process.on('message', message => { if (message === 'shutdown') stop(); });
process.on('disconnect', stop);
let remaining = children.length;
for (const child of children) child.on('exit', code => {
  if (!closing) { console.error(`A server exited (${code}); stopping the lab.`); process.exitCode = 1; stop(); }
  if (--remaining === 0 && process.connected) process.disconnect();
});
