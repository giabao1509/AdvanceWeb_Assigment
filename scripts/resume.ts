import { config } from '../src/shared/config.js';
const [id] = process.argv.slice(2);
if (!id) throw new Error('Dùng: npm run resume -- <saga_id>');
const response = await fetch(`http://127.0.0.1:${config.orderPort}/api/saga/sagas/${encodeURIComponent(id)}/resume`, { method:'POST', headers:{'content-type':'application/json'}, body:'{}' });
console.log(await response.text());
if (!response.ok) process.exitCode=1;
