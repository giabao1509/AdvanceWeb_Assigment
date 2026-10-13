import express from "express";
import type { Server } from "node:http";
import { SLOW_MS } from "../shared/config";
import { sleep } from "../shared/log";
import type { Store } from "./store";

type Log = (event: string, fields?: Record<string, unknown>) => void;

/** REST nội bộ (baseline) + endpoint admin cho dashboard. */
export function startRestServer(opts: { port: number; store: Store; log: Log; info: () => object }): Server {
  const { store, log } = opts;
  const app = express();
  app.use(express.json());

  app.post("/reservations", async (req, res) => {
    const t0 = performance.now();
    const clientVersion = req.header("x-client-version") ?? "(none)";
    const { sku, quantity } = req.body ?? {};
    let cancelled = false;
    res.on("close", () => {
      if (!res.writableFinished) cancelled = true;
    });

    if (typeof sku !== "string" || !Number.isInteger(quantity) || quantity <= 0) {
      log("rest.Reserve", { clientVersion, sku, quantity, result: "INVALID_ARGUMENT", httpStatus: 400 });
      res.status(400).json({ error: { code: "INVALID_ARGUMENT" } });
      return;
    }
    if (store.slow) await sleep(SLOW_MS);

    const check = store.check(sku, quantity);
    if (cancelled) {
      log("rest.Reserve", { clientVersion, sku, quantity, result: "SKIPPED_CALLER_CANCELLED", note: "skipped: caller cancelled", durationMs: ms(t0) });
      return;
    }
    if (!check.ok) {
      const httpStatus = check.reason === "NOT_FOUND" ? 404 : 409;
      const body = check.reason === "NOT_FOUND"
        ? { error: { code: "SKU_NOT_FOUND" } }
        : { error: { code: "INSUFFICIENT_STOCK", available: check.available } };
      log("rest.Reserve", { clientVersion, sku, quantity, result: check.reason, httpStatus, durationMs: ms(t0) });
      res.status(httpStatus).json(body);
      return;
    }
    const reservationId = store.commit(sku, quantity);
    log("rest.Reserve", { clientVersion, sku, quantity, result: "RESERVED", httpStatus: 201, reservationId, stockLeft: store.snapshot()[sku], durationMs: ms(t0) });
    res.status(201).json({ reservationId, sku, quantity });
  });

  app.get("/admin/state", (_req, res) => {
    res.json({ ...opts.info(), slow: store.slow, stock: store.snapshot() });
  });
  app.post("/admin/slow", (req, res) => {
    store.slow = Boolean(req.body?.on);
    log("admin.slow", { slow: store.slow, delayMs: SLOW_MS });
    res.json({ slow: store.slow });
  });
  app.post("/admin/reset", (_req, res) => {
    store.reset();
    log("admin.reset", { stock: store.snapshot() });
    res.json({ stock: store.snapshot() });
  });

  return app.listen(opts.port, "127.0.0.1", () => log("rest.listening", { port: opts.port }));
}

const ms = (t0: number) => Math.round((performance.now() - t0) * 10) / 10;
