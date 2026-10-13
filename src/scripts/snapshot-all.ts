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

async function lastLog(inst: string, event: string) {
  const rows: any[] = await (await fetch(`${SUP}/api/logs?inst=${inst}&last=50`)).json();
  return rows.reverse().find((r) => r.event === event) ?? null;
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
    const res = await fetch(`${t.url}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sku: "SKU-001", quantity: 2 }),
    });
    const body = await res.json();
    await new Promise((r) => setTimeout(r, 150));
    const health = await (await fetch(`${t.url}/health`)).json();
    matrix.push({
      instance: t.inst,
      client: t.client,
      server: t.serverTitle,
      clientVersion: health.clientVersion,
      at: new Date().toISOString(),
      status: res.status,
      body,
      hasReservationExpiresAt: "reservationExpiresAt" in body,
      orderLog: await lastLog(t.inst, "inventory.call"),
      inventoryLog: (await lastLog(t.server, "grpc.Reserve")) ?? (await lastLog(t.server, "rest.Reserve")),
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

main();
