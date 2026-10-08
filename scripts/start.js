// Chạy toàn bộ hệ thống để demo bằng tay.
//   npm start                      -> PRODUCT_LOADER=batched
//   npm run start:naive            -> PRODUCT_LOADER=naive (tái hiện N+1)
//   thêm "-- --fault" để bật POST /__fault trên Product Service
import { PORTS } from '../shared/config.js';
import { Stack, ensureClient } from './stack.js';

const args = process.argv.slice(2);
const productLoader = args.includes('--naive') ? 'naive' : 'batched';
const enableFault = args.includes('--fault');

const client = await ensureClient({ inherit: true });
const stack = new Stack({ productLoader, enableFault, logDir: 'logs/dev', inherit: true });
await stack.start();

const c = `http://localhost:${PORTS.client}`;
console.log(`
Sẵn sàng (PRODUCT_LOADER=${productLoader}, fault ${enableFault ? 'BẬT' : 'tắt'}). Log: logs/dev/*.jsonl
  Trang chọn biến thể : ${c}/
  Web baseline        : ${c}/web.html?variant=baseline&user=u_small
  Web BFF             : ${c}/web.html?variant=bff&user=u_small
  Web GraphQL         : ${c}/web.html?variant=graphql&user=u_small
  Mobile BFF          : ${c}/mobile.html?variant=bff&user=u_small
  Mobile GraphQL      : ${c}/mobile.html?variant=graphql&user=u_small
  GraphiQL            : http://localhost:${PORTS.graphql}/graphql
Ctrl+C để dừng.`);

const shutdown = async () => {
  await stack.stop();
  await client?.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
