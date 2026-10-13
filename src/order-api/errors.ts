/** Lỗi Inventory đã chuẩn hoá, độc lập transport. Client REST/gRPC đều ném loại này. */
export type InventoryFailure =
  | { kind: "SKU_NOT_FOUND"; sku: string }
  | { kind: "OUT_OF_STOCK"; sku: string; requested: number; available: number }
  | { kind: "TIMEOUT" }
  | { kind: "UNAVAILABLE" }
  | { kind: "INTERNAL"; detail: string };

export class InventoryError extends Error {
  constructor(public failure: InventoryFailure, public raw: Record<string, unknown>) {
    super(failure.kind);
  }
}

/** Ánh xạ sang contract ngoài (PLAN §2). Message do Order API tự tạo nên không phụ thuộc transport. */
export function toHttp(f: InventoryFailure): { status: number; code: string; body: object } {
  switch (f.kind) {
    case "SKU_NOT_FOUND":
      return err(404, "SKU_NOT_FOUND", "SKU not found.", { sku: f.sku });
    case "OUT_OF_STOCK":
      return err(409, "OUT_OF_STOCK", "Not enough stock to fulfil the order.", {
        sku: f.sku,
        requested: f.requested,
        available: f.available,
      });
    case "UNAVAILABLE":
      return err(503, "INVENTORY_UNAVAILABLE", "Inventory service is unavailable. Please retry later.");
    case "TIMEOUT":
      return err(504, "INVENTORY_TIMEOUT", "Inventory service did not respond in time.");
    case "INTERNAL":
      return err(500, "INTERNAL_ERROR", "Unexpected error.");
  }
}

function err(status: number, code: string, message: string, details?: object) {
  return { status, code, body: { error: details ? { code, message, details } : { code, message } } };
}
