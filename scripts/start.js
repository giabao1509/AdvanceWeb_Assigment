// Chạy toàn bộ hệ thống để demo bằng tay.
// npm start bật cả /graphql-naive và /graphql-batched, đồng thời bật POST /__fault.
import { PORTS } from '../shared/config.js';
import { Stack, ensureClient } from './stack.js';

const args = process.argv.slice(2);
const enableFault = args.includes('--fault');

const client = await ensureClient({ inherit: true });
const stack = new Stack({ enableFault, logDir: 'logs/dev', inherit: true });
await stack.start();

const c = `http://localhost:${PORTS.client}`;
console.log(`
Sẵn sàng (fault ${enableFault ? 'BẬT' : 'tắt'}). Log: logs/dev/*.jsonl
  Trang chọn biến thể : ${c}/
  Web baseline        : ${c}/web.html?variant=baseline&user=u_small
  Web BFF             : ${c}/web.html?variant=bff&user=u_small
  Web GraphQL naive   : ${c}/web.html?variant=graphql-naive&user=u_small
  Web GraphQL batched : ${c}/web.html?variant=graphql-batched&user=u_small
  Mobile BFF          : ${c}/mobile.html?variant=bff&user=u_small
  Mobile GraphQL naive: ${c}/mobile.html?variant=graphql-naive&user=u_small
  Mobile GraphQL batch: ${c}/mobile.html?variant=graphql-batched&user=u_small
  GraphiQL naive      : http://localhost:${PORTS.graphql}/graphql-naive
  GraphiQL batched    : http://localhost:${PORTS.graphql}/graphql-batched
Ctrl+C để dừng.`);

const shutdown = async () => {
  await stack.stop();
  await client?.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
