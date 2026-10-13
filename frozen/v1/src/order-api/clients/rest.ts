import { DEADLINE_MS } from "../../shared/config";
import { InventoryError } from "../errors";
import { ms, type InventoryClient, type Log, type Reservation } from "./types";

/** Baseline: gọi Inventory bằng REST/JSON, cùng deadline 2000 ms với gRPC. */
export function createRestClient(baseUrl: string, clientVersion: string, log: Log): InventoryClient {
  return {
    transport: "rest",
    target: baseUrl,
    async reserve(sku, quantity): Promise<Reservation> {
      const t0 = performance.now();
      const reqBody = JSON.stringify({ sku, quantity });
      const call = { transport: "rest", method: "POST /reservations", target: baseUrl, deadlineMs: DEADLINE_MS };
      let res: Response;
      try {
        res = await fetch(`${baseUrl}/reservations`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-client-version": clientVersion },
          body: reqBody,
          signal: AbortSignal.timeout(DEADLINE_MS),
        });
      } catch (err) {
        const e = err as Error & { cause?: { code?: string } };
        const timedOut = e.name === "TimeoutError";
        const raw = { ...call, error: e.name, cause: e.cause?.code ?? e.message, durationMs: ms(t0) };
        log("inventory.call", { ...raw, outcome: timedOut ? "TIMEOUT" : "UNAVAILABLE" });
        throw new InventoryError(timedOut ? { kind: "TIMEOUT" } : { kind: "UNAVAILABLE" }, raw);
      }
      const text = await res.text();
      const json = safeJson(text);
      const raw = {
        ...call,
        httpStatus: res.status,
        reqBodyBytes: Buffer.byteLength(reqBody),
        resBodyBytes: Buffer.byteLength(text),
        durationMs: ms(t0),
      };
      if (res.status === 201) {
        log("inventory.call", { ...raw, outcome: "RESERVED", reservationId: json?.reservationId });
        return { reservationId: json.reservationId };
      }
      if (res.status === 404) {
        log("inventory.call", { ...raw, outcome: "SKU_NOT_FOUND" });
        throw new InventoryError({ kind: "SKU_NOT_FOUND", sku }, raw);
      }
      if (res.status === 409) {
        const available = Number(json?.error?.available);
        log("inventory.call", { ...raw, outcome: "OUT_OF_STOCK", available });
        throw new InventoryError({ kind: "OUT_OF_STOCK", sku, requested: quantity, available }, raw);
      }
      log("inventory.call", { ...raw, outcome: "INTERNAL", body: text.slice(0, 200) });
      throw new InventoryError({ kind: "INTERNAL", detail: `HTTP ${res.status}` }, raw);
    },
  };
}

function safeJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
