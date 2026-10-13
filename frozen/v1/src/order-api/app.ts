import express from "express";
import { randomUUID } from "node:crypto";
import { InventoryError, toHttp } from "./errors";
import { ms, type InventoryClient, type Log } from "./clients/types";

/** API ngoài cho browser / bên thứ ba. Contract cố định (PLAN §2). */
export function createApp(opts: { inventory: InventoryClient; log: Log; info: () => object }) {
  const { inventory, log } = opts;
  const app = express();

  // Dashboard (cổng 4000) gọi thẳng Order API như một browser thật → cần CORS.
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json(opts.info());
  });

  app.post("/orders", async (req, res) => {
    const t0 = performance.now();
    const { sku, quantity } = req.body ?? {};
    log("order.request", { sku, quantity });

    if (typeof sku !== "string" || sku.trim() === "" || !Number.isInteger(quantity) || quantity <= 0) {
      const body = {
        error: {
          code: "VALIDATION_ERROR",
          message: "Request body must contain a non-empty 'sku' string and a positive integer 'quantity'.",
          details: { sku: sku ?? null, quantity: quantity ?? null },
        },
      };
      log("order.response", { status: 400, code: "VALIDATION_ERROR", inventoryCalled: false, durationMs: ms(t0) });
      res.status(400).json(body);
      return;
    }

    try {
      const reservation = await inventory.reserve(sku, quantity);
      const order: Record<string, unknown> = {
        orderId: `ord_${randomUUID()}`,
        sku,
        quantity,
        status: "CONFIRMED",
        createdAt: new Date().toISOString(),
      };
      log("order.response", { status: 201, orderId: order.orderId, transport: inventory.transport, durationMs: ms(t0) });
      res.status(201).json(order);
    } catch (err) {
      const { status, code, body } =
        err instanceof InventoryError ? toHttp(err.failure) : toHttp({ kind: "INTERNAL", detail: String(err) });
      log("order.response", { status, code, transport: inventory.transport, durationMs: ms(t0) });
      res.status(status).json(body);
    }
  });

  return app;
}
