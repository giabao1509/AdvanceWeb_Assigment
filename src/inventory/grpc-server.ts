import * as grpc from "@grpc/grpc-js";
import { RESERVATION_TTL_MS, SLOW_MS } from "../shared/config";
import { sleep } from "../shared/log";
import { InventoryServiceService, type InventoryServiceServer } from "../gen/inventory";
import type { Store } from "./store";

type Log = (event: string, fields?: Record<string, unknown>) => void;

export function startGrpcServer(opts: { port: number; store: Store; log: Log }) {
  const { store, log } = opts;

  const impl: InventoryServiceServer = {
    async reserve(call, callback) {
      const t0 = performance.now();
      const clientVersion = call.metadata.get("x-client-version")[0]?.toString() ?? "(none)";
      const deadline = call.getDeadline();
      const base = {
        rpc: "/inventory.InventoryService/Reserve",
        clientVersion,
        peer: call.getPeer(),
        // Deadline của client được truyền tới server qua header grpc-timeout.
        deadline: Number.isFinite(+deadline) ? new Date(+deadline).toISOString() : "none",
        sku: call.request.sku,
        quantity: call.request.quantity,
      };
      const done = (fields: Record<string, unknown>) => log("grpc.Reserve", { ...base, ...fields, durationMs: ms(t0) });
      const { sku, quantity } = call.request;

      if (!sku || quantity <= 0) {
        done({ result: "INVALID_ARGUMENT", grpcCode: grpc.status.INVALID_ARGUMENT });
        callback({ code: grpc.status.INVALID_ARGUMENT, details: "sku must be set and quantity > 0" });
        return;
      }
      if (store.slow) await sleep(SLOW_MS);

      // Caller đã hết deadline / huỷ → không trừ tồn (tránh giữ hàng ma).
      if (call.cancelled) {
        done({ result: "SKIPPED_CALLER_CANCELLED", note: "skipped: caller cancelled" });
        return;
      }

      const check = store.check(sku, quantity);
      if (!check.ok && check.reason === "NOT_FOUND") {
        done({ result: "NOT_FOUND", grpcCode: grpc.status.NOT_FOUND });
        callback({ code: grpc.status.NOT_FOUND, details: `sku ${sku} not found` });
        return;
      }
      if (!check.ok && check.reason === "INSUFFICIENT_STOCK") {
        const trailer = new grpc.Metadata();
        trailer.set("x-available-stock", String(check.available));
        trailer.set("x-requested", String(quantity));
        done({ result: "FAILED_PRECONDITION", grpcCode: grpc.status.FAILED_PRECONDITION, available: check.available });
        callback({ code: grpc.status.FAILED_PRECONDITION, details: "insufficient stock", metadata: trailer });
        return;
      }

      const reservationId = store.commit(sku, quantity);
      const reservationExpiresAt = new Date(Date.now() + RESERVATION_TTL_MS);
      done({
        result: "RESERVED",
        grpcCode: grpc.status.OK,
        reservationId,
        reservationExpiresAt: reservationExpiresAt.toISOString(),
        stockLeft: store.snapshot()[sku],
      });
      callback(null, { reservationId, sku, quantity, reservationExpiresAt });
    },
  };

  const server = new grpc.Server();
  server.addService(InventoryServiceService, impl);
  server.bindAsync(`127.0.0.1:${opts.port}`, grpc.ServerCredentials.createInsecure(), (err, port) => {
    if (err) {
      log("grpc.bind_error", { error: err.message });
      process.exit(1);
    }
    log("grpc.listening", { port });
  });
  return server;
}

const ms = (t0: number) => Math.round((performance.now() - t0) * 10) / 10;
