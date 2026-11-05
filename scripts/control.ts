import { config } from '../src/shared/config.js';
const [service, action] = process.argv.slice(2);
if (!['order','inventory','payment'].includes(service) || !['start','stop'].includes(action)) throw new Error('Dùng: npm run service -- payment start|stop');
const response = await fetch(`http://127.0.0.1:${config.uiPort}/lab/services/${service}/${action}`, { method:'POST', headers:{'content-type':'application/json'}, body:'{}' });
console.log(await response.text());
if (!response.ok) process.exitCode=1;
