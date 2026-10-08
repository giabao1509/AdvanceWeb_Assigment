// Cấu hình dùng chung cho mọi server và script (D03, D10, D20).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PORTS = { user: 4001, order: 4002, product: 4003, bff: 4010, graphql: 4020, client: 5173 };

const urlOf = (name) => process.env[`${name.toUpperCase()}_URL`] || `http://localhost:${PORTS[name]}`;

export const URLS = {
  user: urlOf('user'),
  order: urlOf('order'),
  product: urlOf('product'),
  bff: urlOf('bff'),
  graphql: urlOf('graphql'),
  client: urlOf('client'),
};

export const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || `http://localhost:${PORTS.client}`;

// D20: timeout cho mọi call nội bộ, 0 retry.
export const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 1000);

// D10: số id tối đa mỗi lần gọi batch tới Product Service.
export const PRODUCT_BATCH_LIMIT = 100;

export const DATA_DIR = path.join(ROOT, 'data');
export const LOG_DIR = path.resolve(ROOT, process.env.LOG_DIR || 'logs/dev');
