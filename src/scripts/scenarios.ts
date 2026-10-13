/**
 * Thiếu hàng / Inventory chậm / Inventory tắt — trên cả REST baseline, client cũ, client mới.
 * Cần supervisor đang chạy (`npm start`) vì phải kill/start process Inventory thật.
 *
 *   tsx src/scripts/scenarios.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const SUP = "http://127.0.0.1:4000";
const ORDERS = [
  { inst: "order-rest", url: "http://127.0.0.1:3001", transport: "REST" },
  { inst: "order-grpc-v1", url: "http://127.0.0.1:3002", transport: "gRPC (client cũ v1)" },
  { inst: "order-grpc-v2", url: "http://127.0.0.1:3003", transport: "gRPC (client mới v2)" },
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = (path: string, body?: object) =>
  fetch(`${SUP}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

async function order(o: (typeof ORDERS)[number], scenario: string, quantity: number) {
  const sentAt = new Date();
  const t0 = performance.now();
  const res = await fetch(`${o.url}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sku: "SKU-001", quantity }),
  });
  const body = await res.json();
  const elapsedMs = Math.round(performance.now() - t0);
  const receivedAt = new Date();
  await sleep(100);
  const logs: any[] = await (await fetch(`${SUP}/api/logs?inst=${o.inst}&last=20`)).json();
  const orderLog = logs.reverse().find((l) => l.event === "inventory.call") ?? null;
  const row = {
    scenario,
    instance: o.inst,
    transport: o.transport,
    request: { sku: "SKU-001", quantity },
    sentAt: sentAt.toISOString(),
    receivedAt: receivedAt.toISOString(),
    elapsedMs,
    status: res.status,
    body,
    internal: orderLog && {
      outcome: orderLog.outcome,
      grpcCode: orderLog.grpcCode,
      httpStatus: orderLog.httpStatus,
      error: orderLog.error,
      cause: orderLog.cause,
      grpcDetails: orderLog.grpcDetails,
      durationMs: orderLog.durationMs,
    },
  };
  console.log(`${scenario.padEnd(10)} ${o.inst.padEnd(15)} → ${res.status} ${body?.error?.code ?? body?.status}  ${elapsedMs} ms`);
  return row;
}

async function stock(): Promise<number> {
  const r = await (await fetch("http://127.0.0.1:5001/admin/state")).json();
  return r.stock["SKU-001"];
}
async function waitStatus(name: string, status: string) {
  for (let i = 0; i < 100; i++) {
    const s = await (await fetch(`${SUP}/api/state`)).json();
    if (s.instances.find((x: any) => x.name === name)?.status === status) return;
    await sleep(200);
  }
  throw new Error(`${name} không đạt trạng thái ${status}`);
}

async function main() {
  const rows: any[] = [];
  const notes: Record<string, unknown> = {};

  // 1. Thiếu hàng
  for (const o of ORDERS) {
    await post("/api/reset");
    rows.push(await order(o, "thieu-hang", 10));
  }

  // 2. Inventory chậm 5 s, deadline 2 s. Gửi song song để cả ba cùng chờ.
  await post("/api/reset");
  await post("/api/inventory/inventory-v2/slow", { on: true });
  const slowStart = performance.now();
  rows.push(...(await Promise.all(ORDERS.map((o) => order(o, "cham", 2)))));
  // Đợi Inventory ngủ xong rồi kiểm tra có giữ hàng ma không.
  await sleep(Math.max(0, 5600 - (performance.now() - slowStart)));
  const invLogs: any[] = await (await fetch(`${SUP}/api/logs?inst=inventory-v2&last=30`)).json();
  notes.slow = {
    stockAfter: await stock(),
    stockExpected: 5,
    inventoryOutcomes: invLogs.filter((l) => /Reserve$/.test(l.event)).slice(-3).map((l) => ({ event: l.event, result: l.result, note: l.note, clientVersion: l.clientVersion, durationMs: l.durationMs })),
  };
  console.log(`sau khi chậm: tồn = ${(notes.slow as any).stockAfter} (kỳ vọng 5, không giữ hàng ma)`);
  await post("/api/inventory/inventory-v2/slow", { on: false });

  // 3. Inventory tắt (kill process thật)
  await post("/api/instances/inventory-v2/stop");
  await waitStatus("inventory-v2", "stopped");
  for (const o of ORDERS) rows.push(await order(o, "tat", 2));
  await post("/api/instances/inventory-v2/start");
  await waitStatus("inventory-v2", "running");
  await post("/api/reset");

  const out = { takenAt: new Date().toISOString(), deadlineMs: 2000, slowMs: 5000, rows, notes };
  writeFileSync(join(__dirname, "../../evidence/scenarios.json"), JSON.stringify(out, null, 2));
  console.log("→ evidence/scenarios.json");
}

main().catch(async (e) => {
  console.error(e);
  await post("/api/inventory/inventory-v2/slow", { on: false }).catch(() => {});
  await post("/api/instances/inventory-v2/start").catch(() => {});
  process.exit(1);
});
