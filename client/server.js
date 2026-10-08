// Server tĩnh :5173 cho client web/mobile. Không log, không thuộc phép đo.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { LOG_DIR, PORTS } from '../shared/config.js';
import { countEvents, readAllEvents } from '../scripts/logs.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.get('/health', (req, res) => res.json({ ok: true, service: 'client' }));

// Metrics của một lần demo, đọc từ JSON Lines theo rid. Chỉ trả số đếm,
// không trả SQL hay dữ liệu nghiệp vụ. Chờ ngắn để stream log ghi hết sự kiện.
app.get('/__metrics/:rid', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  let events = [];
  let previousCount = -1;
  let stableReads = 0;
  for (let attempt = 0; attempt < 20; attempt++) {
    events = readAllEvents(LOG_DIR).get(req.params.rid) ?? [];
    if (events.length > 0 && events.length === previousCount) stableReads++;
    else stableReads = 0;
    if (stableReads >= 2) break;
    previousCount = events.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!events.length) return res.status(404).json({ error: { code: 'METRICS_NOT_READY', message: 'Chưa tìm thấy log của rid này.' } });
  res.json({ rid: req.params.rid, ...countEvents(events) });
});

app.use(express.static(dir, { etag: false, lastModified: false, setHeaders: (res) => res.set('Cache-Control', 'no-store') }));

app.listen(PORTS.client, (err) => {
  if (err) {
    console.error(`[client] không mở được cổng ${PORTS.client}: ${err.message}`);
    process.exit(1);
  }
  console.log(`[client] http://localhost:${PORTS.client}/`);
});
