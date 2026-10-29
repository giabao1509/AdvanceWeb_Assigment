import type { Config } from '../shared/config.js';
export async function ready(configs: Config[]) {
  for (let i = 0; i < 80; i++) {
    const checks = await Promise.all(configs.flatMap(c => [c.as, c.api, c.taxi]).map(async url => {
      try { return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
    }));
    if (checks.every(Boolean)) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Lab servers not ready. Check ports and npm run dev.');
}
