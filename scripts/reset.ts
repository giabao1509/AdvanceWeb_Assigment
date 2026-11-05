import { resolve, relative, isAbsolute, join } from 'node:path';
import { rmSync, readdirSync, readFileSync } from 'node:fs';
import { config } from '../src/shared/config.js';
import { root } from './lab.js';

const target = resolve(config.dataDir);
const inside = relative(root, target);
if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error(`Không reset DATA_DIR ngoài repo hoặc tại repo root: ${target}`);
for (const file of (() => { try { return readdirSync(join(target, '.runtime')); } catch { return []; } })()) {
  const info = JSON.parse(readFileSync(join(target, '.runtime', file), 'utf8')) as { pid: number };
  try { process.kill(info.pid, 0); } catch { continue; }
  throw new Error(`Service PID ${info.pid} còn chạy. Dừng các service trước khi reset.`);
}
for (const port of [config.uiPort, config.orderPort, config.inventoryPort, config.paymentPort]) {
  try { const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(400) }); if (response.ok) throw new Error('LIVE_SERVICE'); }
  catch (error) { if (error instanceof Error && error.message === 'LIVE_SERVICE') throw new Error(`Service trên port ${port} còn chạy. Dừng trước khi reset.`); }
}
// Absolute target was checked to be inside this workspace before any recursive removal.
for (const mode of ['baseline', 'saga']) rmSync(join(target, mode), { recursive: true, force: true });
for(const service of ['order','inventory','payment']){
  for(const suffix of ['.sqlite','.sqlite-wal','.sqlite-shm'])rmSync(join(target,service+suffix),{force:true});
  rmSync(join(target,`migration-${service}.json`),{force:true});
}
rmSync(join(target,'f4-recovery.json'),{force:true});
console.log('Đã reset dữ liệu dùng chung của Baseline/Saga. Lần khởi động tiếp theo sẽ seed lại.');
