import { randomUUID } from "node:crypto";
import { FIXTURE } from "../shared/config";

export type CheckResult =
  | { ok: true }
  | { ok: false; reason: "NOT_FOUND" }
  | { ok: false; reason: "INSUFFICIENT_STOCK"; available: number };

export class Store {
  private stock = new Map<string, number>();
  slow = false;

  constructor() {
    this.reset();
  }

  reset() {
    this.stock = new Map(Object.entries(FIXTURE));
  }

  snapshot() {
    return Object.fromEntries(this.stock);
  }

  check(sku: string, quantity: number): CheckResult {
    const available = this.stock.get(sku);
    if (available === undefined) return { ok: false, reason: "NOT_FOUND" };
    if (available < quantity) return { ok: false, reason: "INSUFFICIENT_STOCK", available };
    return { ok: true };
  }

  /** Trừ tồn. Chỉ gọi sau check() và khi caller chưa huỷ. */
  commit(sku: string, quantity: number) {
    this.stock.set(sku, (this.stock.get(sku) ?? 0) - quantity);
    return `res_${randomUUID()}`;
  }
}
