import { config, type Mode } from '../shared/config.js';
import { runCase } from '../shared/cases.js';
const arg = process.argv.indexOf('--target'), mode = (arg < 0 ? 'secure' : process.argv[arg + 1]) as Mode;
if (!['baseline', 'secure'].includes(mode)) throw new Error('--target baseline|secure');
const ids = ['redirect', 'pkce', 'code_replay', 'wrong_verifier', 'wrong_secret', 'other_client', 'refresh_replay', 'other_refresh', ...(process.argv.includes('--all') ? ['code_expired'] : [])];
for (const id of ids) {
  const result = await runCase(config(mode), id);
  console.log(JSON.stringify(result, null, 2));
  if (mode === 'secure' && !result.protected) process.exitCode = 1;
}
