import * as grpc from "@grpc/grpc-js";
import { DEADLINE_MS } from "../../shared/config";
import { InventoryServiceService, ReserveRequest, ReserveResponse } from "../../gen/inventory";
import { InventoryError, type InventoryFailure } from "../errors";
import { ms, type InventoryClient, type Log, type Reservation } from "./types";

/** Số byte protobuf của message trên lời gọi gần nhất (đo ngay trong serialize/deserialize). */
const lastBytes = { req: 0, res: 0 };
const measured = {
  reserve: {
    ...InventoryServiceService.reserve,
    requestSerialize: (v: ReserveRequest) => {
      const b = InventoryServiceService.reserve.requestSerialize(v);
      lastBytes.req = b.length;
      return b;
    },
    responseDeserialize: (b: Buffer) => {
      lastBytes.res = b.length;
      return InventoryServiceService.reserve.responseDeserialize(b);
    },
  },
} as const;
const InventoryClientCtor = grpc.makeGenericClientConstructor(measured, "inventory.InventoryService");

export function createGrpcClient(target: string, clientVersion: string, log: Log): InventoryClient {
  const client = new InventoryClientCtor(target, grpc.credentials.createInsecure());

  return {
    transport: "grpc",
    target,
    reserve(sku, quantity): Promise<Reservation> {
      const t0 = performance.now();
      const md = new grpc.Metadata();
      md.set("x-client-version", clientVersion);
      const call = { transport: "grpc", method: "/inventory.InventoryService/Reserve", target, deadlineMs: DEADLINE_MS };

      return new Promise((resolve, reject) => {
        client.reserve(
          { sku, quantity },
          md,
          { deadline: new Date(Date.now() + DEADLINE_MS) },
          (err: grpc.ServiceError | null, res?: ReserveResponse) => {
            const raw: Record<string, unknown> = { ...call, durationMs: ms(t0), reqMsgBytes: lastBytes.req };
            if (!err && res) {
              // Byte nhận trên wire so với byte mà client này hiểu được → phần còn lại là field lạ đã bị bỏ qua.
              const knownBytes = ReserveResponse.encode(res).finish().length;
              log("inventory.call", {
                ...raw,
                grpcCode: "OK",
                outcome: "RESERVED",
                reservationId: res.reservationId,
                resMsgBytes: lastBytes.res,
                unknownFieldBytes: lastBytes.res - knownBytes,
              });
              resolve({ reservationId: res.reservationId });
              return;
            }
            const e = err as grpc.ServiceError;
            const codeName = grpc.status[e.code];
            const failure = toFailure(e, sku, quantity);
            log("inventory.call", {
              ...raw,
              grpcCode: codeName,
              grpcDetails: e.details,
              trailer: e.metadata?.getMap(),
              outcome: failure.kind,
            });
            reject(new InventoryError(failure, { ...raw, grpcCode: codeName }));
          },
        );
      });
    },
  };
}

function toFailure(e: grpc.ServiceError, sku: string, quantity: number): InventoryFailure {
  switch (e.code) {
    case grpc.status.FAILED_PRECONDITION:
      return {
        kind: "OUT_OF_STOCK",
        sku,
        requested: quantity,
        available: Number(e.metadata.get("x-available-stock")[0]),
      };
    case grpc.status.NOT_FOUND:
      return { kind: "SKU_NOT_FOUND", sku };
    case grpc.status.DEADLINE_EXCEEDED:
      return { kind: "TIMEOUT" };
    case grpc.status.UNAVAILABLE:
      return { kind: "UNAVAILABLE" };
    default:
      return { kind: "INTERNAL", detail: `${grpc.status[e.code]}: ${e.details}` };
  }
}
