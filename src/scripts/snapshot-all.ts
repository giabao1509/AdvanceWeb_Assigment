/**
 * Chạy lại snapshot trên mọi Order API đang chạy (cần `npm start`), so với baseline REST,
 * và dựng ma trận client × server kèm log nội bộ của chính lời gọi đó.
 *
 *   tsx src/scripts/snapshot-all.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareSnapshots } from "./compare";
import { takeSnapshot } from "./snapshot";

const SUP = "http://127.0.0.1:4000";
const TARGETS = [
  { inst: "order-rest", url: "http://127.0.0.1:3001", admin: "http://127.0.0.1:5001", server: "inventory-v2", client: "REST baseline", serverTitle: "server mới (v2) · REST" },
  { inst: "order-grpc-v1", url: "http://127.0.0.1:3002", admin: "http://127.0.0.1:5001", server: "inventory-v2", client: "client cũ (proto v1)", serverTitle: "server mới (v2)" },
  { inst: "order-grpc-v2", url: "http://127.0.0.1:3003", admin: "http://127.0.0.1:5001", server: "inventory-v2", client: "client mới (proto v2)", serverTitle: "server mới (v2)" },
  { inst: "order-grpc-v2-oldsrv", url: "http://127.0.0.1:3004", admin: "http://127.0.0.1:5002", server: "inventory-v1", client: "client mới (proto v2)", serverTitle: "server cũ (v1)" },
];

type LogRow = {
  _seq: number;
  event: string;
  orderId?: string;
  reservationId?: string;
  clientVersion?: string;
  transport?: string;
  outcome?: string;
  result?: string;
  [field: string]: unknown;
};

async function readLogs(inst?: string, limit = 200): Promise<LogRow[]> {
  const query = new URLSearchParams({ last: String(limit) });
  if (inst) query.set("inst", inst);
  const response = await fetch(`${SUP}/api/logs?${query}`);
  if (!response.ok) throw new Error(`Cannot read logs: HTTP ${response.status}`);
  return response.json();
}

async function captureLogs(inst: string, server: string, transport: string, orderId: string, startSeq: number) {
  const event = transport === "rest" ? "rest.Reserve" : "grpc.Reserve";
  const until = Date.now() + 2000;
  while (Date.now() < until) {
    const orderRows = await readLogs(inst);
    // Bound the call by this run's watermark and the response's unique order ID.
    const response = orderRows.find((r) => r._seq > startSeq && r.event === "order.response" && r.orderId === orderId);
    if (response) {
      const calls = orderRows.filter((r) => r._seq > startSeq && r._seq < response._seq && r.event === "inventory.call");
      if (calls.length > 1) {
        throw new Error(`${inst}: multiple calls in the capture window; stop concurrent demo requests and retry.`);
      }
      const orderLog = calls[0];
      if (orderLog) {
        if (orderLog.transport !== transport || orderLog.outcome !== "RESERVED" || !orderLog.reservationId) {
          throw new Error(`${inst}: the captured call is not the expected successful ${transport} reservation.`);
        }
        const inventoryRows = await readLogs(server);
        const inventoryLog = inventoryRows.find((r) =>
          r._seq > startSeq && r.event === event && r.result === "RESERVED" &&
          r.reservationId === orderLog.reservationId && r.clientVersion === orderLog.clientVersion,
        );
        if (inventoryLog) return { orderLog, inventoryLog };
      }
    }
    // stdout from different child processes may arrive after the HTTP response.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${inst}: no matching Order/Inventory logs for order ${orderId}; evidence was not saved.`);
}

async function main() {
  const matrix = [];
  for (const t of TARGETS) {
    const label = `live-${t.inst}`;
    const snap = await takeSnapshot(label, t.url, t.admin);
    const cmp = compareSnapshots("baseline-rest", label);
    console.log(`${t.inst.padEnd(22)} vs baseline-rest: ${cmp.identical ? "IDENTICAL" : cmp.onlyAdditive ? "ONLY ADDITIVE (+" + cmp.rows.flatMap((r: any) => r.addedKeys).join(",") + ")" : "DIFFERENT"}`);

    // Một lời gọi đủ hàng riêng để chụp log nội bộ tương ứng.
    await fetch(`${t.admin}/admin/reset`, { method: "POST" });
    const health = await (await fetch(`${t.url}/health`)).json();
    const before = await readLogs(undefined, 1);
    const startSeq = before[0]?._seq ?? 0;
    const res = await fetch(`${t.url}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sku: "SKU-001", quantity: 2 }),
    });
    const body = await res.json();
    if (res.status !== 201 || typeof body.orderId !== "string") {
      throw new Error(`${t.inst}: expected 201 with orderId, received ${res.status}; evidence was not saved.`);
    }
    const { orderLog, inventoryLog } = await captureLogs(t.inst, t.server, health.transport, body.orderId, startSeq);
    matrix.push({
      instance: t.inst,
      client: t.client,
      server: t.serverTitle,
      clientVersion: health.clientVersion,
      at: new Date().toISOString(),
      status: res.status,
      body,
      hasReservationExpiresAt: "reservationExpiresAt" in body,
      orderLog,
      inventoryLog,
      vsBaseline: cmp.rows.map((r: any) => ({ case: r.case, identical: r.identical, a: r.a, b: r.b })),
      identicalToBaseline: cmp.identical,
      onlyAdditiveVsBaseline: cmp.onlyAdditive,
      addedKeys: [...new Set(cmp.rows.flatMap((r: any) => r.addedKeys))],
      cases: snap.cases.map((c) => ({ case: c.case, status: c.status })),
    });
    await fetch(`${t.admin}/admin/reset`, { method: "POST" });
  }
  writeFileSync(join(__dirname, "../../evidence/matrix.json"), JSON.stringify({ takenAt: new Date().toISOString(), matrix }, null, 2));
  for (const m of matrix) {
    console.log(`${m.client.padEnd(22)} × ${m.server.padEnd(22)} → ${m.status}  reservationExpiresAt=${m.hasReservationExpiresAt ? m.body.reservationExpiresAt : "(vắng)"}  unknownFieldBytes=${m.orderLog?.unknownFieldBytes ?? "-"}`);
  }
  console.log("→ evidence/matrix.json");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
