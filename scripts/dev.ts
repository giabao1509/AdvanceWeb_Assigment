import { config } from '../src/shared/config.js';
import { Lab } from './lab.js';

const lab = new Lab(process.cwd(), { ui: config.uiPort, order: config.orderPort, inventory: config.inventoryPort, payment: config.paymentPort }, {
  DATA_DIR: config.dataDir, LOG_DIR: config.logDir, HTTP_TIMEOUT_MS: String(config.timeout), RECOVERY_INTERVAL_MS: String(config.interval),
  SAGA_MAX_RETRIES: String(config.maxRetries),
  F4_DOWNTIME_MS:String(config.f4DowntimeMs),
  ENABLE_FAULTS: String(config.faults), AUTO_KILL_MARKERS: String(config.faults), INVENTORY_URL: config.inventoryUrl, PAYMENT_URL: config.paymentUrl,
}, true);
let closing = false;
async function close() { if (closing) return; closing = true; await lab.close(); process.exit(0); }
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
try {
  await lab.startAll();
  console.log(`\nMở UI đặt hàng: ${lab.url()}\nCtrl+C để dừng cả ba service. Dữ liệu được giữ lại.\n`);
  lab.listeners.add(entry => { if (!closing && entry.event === 'PROCESS_EXITED') console.log(`${entry.service} đã dừng. UI và các service còn lại tiếp tục chạy; dùng nút Khôi phục trên UI.`); });
} catch (error) { console.error(error); await lab.close(); process.exitCode = 1; }
