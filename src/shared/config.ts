import { resolve } from 'node:path';
import type { Mode } from './types.js';

export const modes: Mode[] = ['baseline', 'saga'];
const maxRetries = Number(process.env.SAGA_MAX_RETRIES ?? 3);
if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 100) throw new Error('SAGA_MAX_RETRIES phải là số nguyên từ 0 đến 100.');
const f4DowntimeMs=Number(process.env.F4_DOWNTIME_MS ?? 4000);
if(!Number.isSafeInteger(f4DowntimeMs) || f4DowntimeMs<0 || f4DowntimeMs>60000)throw new Error('F4_DOWNTIME_MS phải là số nguyên từ 0 đến 60000.');
export const config = {
  uiPort: Number(process.env.UI_PORT || 3000),
  orderPort: Number(process.env.ORDER_PORT || 3003),
  inventoryPort: Number(process.env.INVENTORY_PORT || 3001),
  paymentPort: Number(process.env.PAYMENT_PORT || 3002),
  inventoryUrl: process.env.INVENTORY_URL || `http://127.0.0.1:${process.env.INVENTORY_PORT || 3001}`,
  paymentUrl: process.env.PAYMENT_URL || `http://127.0.0.1:${process.env.PAYMENT_PORT || 3002}`,
  dataDir: resolve(process.env.DATA_DIR || 'data'),
  logDir: resolve(process.env.LOG_DIR || 'logs'),
  timeout: Number(process.env.HTTP_TIMEOUT_MS || 2000),
  interval: Number(process.env.RECOVERY_INTERVAL_MS || 1000),
  maxRetries,
  f4DowntimeMs,
  faults: process.env.ENABLE_FAULTS === 'true',
};

export const catalog = [
  { sku: 'LAMP-01', name: 'Đèn bàn Studio', category: 'GÓC LÀM VIỆC', price: 450000, stock: 20, art: 'lamp', color: '#f2e4cf', description: 'Ánh sáng dịu, thiết kế gọn cho một góc bàn thật thoải mái.' },
  { sku: 'CUP-01', name: 'Ly gốm Morning', category: 'MỖI NGÀY', price: 180000, stock: 30, art: 'cup', color: '#e5ebe2', description: 'Một chiếc ly vừa tay cho cà phê và những ý tưởng mới.' },
  { sku: 'BAG-01', name: 'Túi Everyday', category: 'MANG THEO', price: 320000, stock: 15, art: 'bag', color: '#e4e6ef', description: 'Túi vải bền nhẹ, đủ chỗ cho những món đồ thiết yếu.' },
];
