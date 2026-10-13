/**
 * Chụp status + body mà browser nhận từ POST /orders ở các đường đủ hàng / thiếu hàng (+ SKU lạ, input sai).
 * Reset fixture trước mỗi case để kết quả xác định. Giá trị động được thay bằng placeholder.
 *
 *   tsx src/scripts/snapshot.ts <label> <orderApiUrl> [inventoryAdminUrl]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CASES = [
  { name: "du-hang", title: "Đủ hàng (SKU-001 × 2)", body: { sku: "SKU-001", quantity: 2 } },
  { name: "thieu-hang", title: "Thiếu hàng (SKU-001 × 10)", body: { sku: "SKU-001", quantity: 10 } },
  { name: "sku-la", title: "SKU không tồn tại", body: { sku: "SKU-404", quantity: 1 } },
  { name: "input-sai", title: "Input sai (quantity = 0)", body: { sku: "SKU-001", quantity: 0 } },
];

const DYNAMIC_KEYS = new Set(["orderId", "createdAt", "reservationExpiresAt"]);

export function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, DYNAMIC_KEYS.has(k) ? `<${k}>` : normalize(v)]),
    );
  }
  return value;
}

export async function takeSnapshot(label: string, orderUrl: string, adminUrl: string) {
  const cases = [];
  for (const c of CASES) {
    await fetch(`${adminUrl}/admin/reset`, { method: "POST" });
    const t0 = performance.now();
    const res = await fetch(`${orderUrl}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(c.body),
    });
    const text = await res.text();
    const body = JSON.parse(text);
    cases.push({
      case: c.name,
      title: c.title,
      request: { method: "POST", url: "/orders", body: c.body },
      status: res.status,
      contentType: res.headers.get("content-type"),
      body,
      normalized: normalize(body),
      elapsedMs: Math.round(performance.now() - t0),
    });
  }
  await fetch(`${adminUrl}/admin/reset`, { method: "POST" });
  const snap = { label, orderUrl, takenAt: new Date().toISOString(), cases };
  const dir = join(__dirname, "../../evidence/snapshots");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${label}.json`), JSON.stringify(snap, null, 2));
  return snap;
}

if (require.main === module) {
  const [label, orderUrl, adminUrl = "http://127.0.0.1:5001"] = process.argv.slice(2);
  if (!label || !orderUrl) {
    console.error("usage: snapshot <label> <orderApiUrl> [inventoryAdminUrl]");
    process.exit(2);
  }
  takeSnapshot(label, orderUrl, adminUrl).then((s) => {
    for (const c of s.cases) console.log(`${c.case.padEnd(12)} ${c.status}  ${JSON.stringify(c.normalized)}`);
    console.log(`→ evidence/snapshots/${label}.json`);
  });
}
