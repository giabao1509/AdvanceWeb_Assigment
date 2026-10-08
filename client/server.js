// Server tĩnh :5173 cho client web/mobile. Không log, không thuộc phép đo.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { PORTS } from '../shared/config.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.get('/health', (req, res) => res.json({ ok: true, service: 'client' }));
app.use(express.static(dir, { etag: false, lastModified: false, setHeaders: (res) => res.set('Cache-Control', 'no-store') }));

app.listen(PORTS.client, (err) => {
  if (err) {
    console.error(`[client] không mở được cổng ${PORTS.client}: ${err.message}`);
    process.exit(1);
  }
  console.log(`[client] http://localhost:${PORTS.client}/`);
});
